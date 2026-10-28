import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { LIMITS, nativeCandidates, type Span } from '@phosphorco/bb-context-recognition';
import { safeAuthoredHrefSchema, hasSensitiveUrlParameter } from '@phosphorco/bb-cross-references';

type Node = {type:string;value?:string;url?:string;title?:string;identifier?:string;children?:Node[];position?:{start:{offset?:number};end:{offset?:number}}};
const parser = unified().use(remarkParse).use(remarkGfm);
const skip = new Set(['image','imageReference','code','inlineCode','definition']);
const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
export type MarkdownLink = {href:string;label:string;span:Span;authoredHref?:string};
export type MentionFrame = {excluded:Span[];links:MarkdownLink[];windows:Span[];limited:boolean;forbidden:Span[]};
const text = (node:Node):string => node.value ?? node.children?.map(text).join('') ?? '';
const containsImage = (node:Node):boolean => ['image','imageReference'].includes(node.type) || !!node.children?.some(containsImage);

/** Privacy applies to the original destination, even when an established graph
 * adapter can retain a sanitized target. Relative file links remain eligible. */
function unsafeExcerptDestination(href:string):boolean {
  try {
    if(hasSensitiveUrlParameter(new URL(href,'https://local.invalid')))return true;
    return (URL.canParse(href)||href.startsWith('/'))&&!safeAuthoredHrefSchema.safeParse(href).success;
  } catch { return true; }
}

/** Root-relative text uses only the existing policy/native grammar. GFM owns
 * absolute prose URLs. Keep original whole runs within the native4096 bound. */
function prosePrivacyHoles(raw:string,base:number):Span[] {
  const holes:Span[]=[];
  if(raw.includes('/'))for(let at=0;at<raw.length;){
    while(at<raw.length&&raw[at]!.trim()==='')at++;
    const from=at;while(at<raw.length&&raw[at]!.trim()!=='')at++;
    const run=raw.slice(from,at);
    if(run.startsWith('/')&&unsafeExcerptDestination(run)){holes.push({start:base+from,end:base+at});continue;}
    if(!run.includes('/projects/'))continue;
    if(run.length>4096){holes.push({start:base+from,end:base+at});continue;}
    for(let offset=0;offset<run.length;){
      const candidates=nativeCandidates({version:1,text:run.slice(offset),format:'plain',excluded:[],context:{consumer:{pluginId:'cross-references'},links:[]}},undefined,'bb.thread');
      for(const candidate of candidates)if(unsafeExcerptDestination(candidate.match))holes.push({start:base+from+offset+candidate.span.start,end:base+from+offset+candidate.span.end});
      const last=candidates.at(-1);
      if(candidates.length<LIMITS.candidatesPerCall||!last)break;
      offset+=last.span.end;
    }
  }
  return holes;
}

/** Same positioned Markdown/GFM text grammar as Thread Brief. Never search
 * reconstructed/rendered text: offsets always address the authored UTF-16. */
export function mentionFrame(markdown:string):MentionFrame {
  const tree = parser.parse(markdown) as Node;
  const eligible:Span[] = [], links:MarkdownLink[] = [], html:string[] = [], forbidden:Span[] = [];
  const forbid=(node:Node)=>{const start=node.position?.start.offset,end=node.position?.end.offset;if(start!==undefined&&end!==undefined&&end>start)forbidden.push({start,end});};
  const inlineForbidden=(node:Node):void=>{if(skip.has(node.type)||node.type==='html'){forbid(node);return;}node.children?.forEach(inlineForbidden);};
  const definitions = new Map<string,string>(),definitionTitles=new Map<string,string>(),definitionProof=new Map<string,string>();
  // Markdown suppresses nested autolinks inside labels; titles have no child
  // nodes. Classify their decoded text with the SAME GFM grammar once per
  // distinct field/message. Any hit excludes the entire original outer link,
  // so no reconstructed-text offsets are ever presented as source evidence.
  const textPrivacy=new Map<string,boolean>();
  let textPrivacyChars=0;
  const unsafeContextText=(value:string):boolean=>{
    const known=textPrivacy.get(value);if(known!==undefined)return known;
    // Bound nested Markdown-looking metadata by the admitted original body,
    // rather than repeatedly reparsing an adversarial shrinking title chain.
    // Unproved metadata makes only its outer link ineligible for excerpts.
    if(textPrivacyChars+value.length>markdown.length*2)return true;
    textPrivacyChars+=value.length;textPrivacy.set(value,true);
    const fragment=parser.parse(value) as Node;
    const unsafe=(node:Node):boolean=>!!node.url&&unsafeExcerptDestination(node.url)||
      node.type==='text'&&!!node.value&&prosePrivacyHoles(node.value,0).length>0||!!node.title&&unsafeContextText(node.title)||!!node.children?.some(unsafe);
    const result=unsafe(fragment);textPrivacy.set(value,result);return result;
  };
  const destinationProof=(raw:string,href:string):string|undefined=>{
    if(raw===href||raw===`<${href}>`)return href;
    const cut=raw.lastIndexOf('](');if(cut<0||!raw.endsWith(')'))return;
    const dest=raw.slice(cut+2,-1).trim();
    if(dest===href||dest===`<${href}>`||dest.startsWith(href+' ')||dest.startsWith(href+'\n')||dest.startsWith(`<${href}> `))return href;
  };
  const index = (node:Node) => {
    if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier.toUpperCase())) {
      const key=node.identifier.toUpperCase();definitions.set(key,node.url);
      if(node.title)definitionTitles.set(key,node.title);
      const raw=markdown.slice(node.position?.start.offset??0,node.position?.end.offset??0);
      const match=/^\s*\[[^\]]+\]:\s*(?:<([^>\n]+)>|([^\s]+))/u.exec(raw);
      if((match?.[1]??match?.[2])===node.url)definitionProof.set(key,node.url);
    }
    node.children?.forEach(index);
  };
  index(tree);
  const walk = (node:Node):void => {
    const start=node.position?.start.offset, end=node.position?.end.offset;
    if (node.type === 'link' || node.type === 'linkReference') {
      const href=node.url ?? definitions.get(node.identifier?.toUpperCase() ?? '');
      if (!html.length && !containsImage(node) && href && start!==undefined && end!==undefined && end>start) {const proof=node.type==='linkReference'?definitionProof.get(node.identifier?.toUpperCase()??''):destinationProof(markdown.slice(start,end),href);
        const label=text(node),unsafeLabel=label!==href&&unsafeContextText(label);
        // This is a display-metadata fallback only. Original source bytes and
        // source spans remain unchanged; excerpts never substitute this label.
        links.push({href,label:unsafeLabel?'Link':label,span:{start,end},...(proof?{authoredHref:proof}:{})});
        const title=node.title??definitionTitles.get(node.identifier?.toUpperCase()??'');
        if(unsafeExcerptDestination(href)||unsafeLabel||!!title&&unsafeContextText(title))forbid(node);else node.children?.forEach(inlineForbidden);}
      else forbid(node);
      return;
    }
    if (skip.has(node.type)) {forbid(node);return;}
    if (node.type === 'html') {
      forbid(node);
      for (const tag of (node.value ?? '').matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-z][\w-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu)) {
        if (!tag[2]) continue;
        const name=tag[2].toLowerCase();
        if (tag[1]) { const at=html.lastIndexOf(name); if(at>=0)html.splice(at); }
        else if (!tag[0].endsWith('/>') && !voidTags.has(name)) html.push(name);
      }
      return;
    }
    if(html.length && node.type==='text')forbid(node);
    if (node.type === 'text' && !html.length && start!==undefined && end!==undefined && end>start) {
      eligible.push({start,end});
      forbidden.push(...prosePrivacyHoles(markdown.slice(start,end),start));
    }
    else node.children?.forEach(walk);
  };
  walk(tree);
  eligible.sort((a,b)=>a.start-b.start);
  const excluded:Span[]=[];let cursor=0;
  for(const span of eligible){if(span.start>cursor)excluded.push({start:cursor,end:span.start});cursor=Math.max(cursor,span.end);}
  if(cursor<markdown.length)excluded.push({start:cursor,end:markdown.length});
  for(const match of markdown.matchAll(/\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu))excluded.push({start:match.index,end:match.index+2});
  excluded.sort((a,b)=>a.start-b.start);
  for(let i=1;i<excluded.length;){const a=excluded[i-1]!,b=excluded[i]!;if(b.start<=a.end){a.end=Math.max(a.end,b.end);excluded.splice(i,1);}else i++;}
  const windows:Span[]=[];
  // A huge block is skipped as a unit so a cut never reinterprets a code fence
  // or splits a recognizer token. Prior evidence for this message is retained.
  let start=0, limited=false;
  const appendWindow=(start:number,end:number)=>{
    if(end<=start)return;
    // Original-source gaps can exceed the wire bound without any big block.
    if(end-start>LIMITS.textChars){limited=true;return;}
    windows.push({start,end});
  };
  for(const block of tree.children??[]){const end=block.position?.end.offset??start;
    if(end-start>LIMITS.textChars){const prior=block.position?.start.offset??start;if(prior>start)appendWindow(start,prior);start=prior;
      if(end-start>LIMITS.textChars){start=end;limited=true;continue;}}
    if(end-start>=LIMITS.textChars){appendWindow(start,end);start=end;}
  }
  if(start<markdown.length)appendWindow(start,markdown.length);
  if(windows.length>LIMITS.windows)limited=true;
  forbidden.sort((a,b)=>a.start-b.start);
  const merged:Span[]=[];for(const hole of forbidden){const prior=merged.at(-1);if(prior&&hole.start<=prior.end)prior.end=Math.max(prior.end,hole.end);else merged.push({...hole});}
  return {excluded,links,windows:windows.slice(0,LIMITS.windows),limited,forbidden:merged};
}
