import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { LIMITS, type Span } from '@phosphorco/bb-context-recognition';

type Node = {type:string;value?:string;url?:string;identifier?:string;children?:Node[];position?:{start:{offset?:number};end:{offset?:number}}};
const parser = unified().use(remarkParse).use(remarkGfm);
const skip = new Set(['image','imageReference','code','inlineCode','definition']);
const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
export type MarkdownLink = {href:string;label:string;span:Span};
export type MentionFrame = {excluded:Span[];links:MarkdownLink[];windows:Span[];limited:boolean};
const text = (node:Node):string => node.value ?? node.children?.map(text).join('') ?? '';
const containsImage = (node:Node):boolean => ['image','imageReference'].includes(node.type) || !!node.children?.some(containsImage);

/** Same positioned Markdown/GFM text grammar as Thread Brief. Never search
 * reconstructed/rendered text: offsets always address the authored UTF-16. */
export function mentionFrame(markdown:string):MentionFrame {
  const tree = parser.parse(markdown) as Node;
  const eligible:Span[] = [], links:MarkdownLink[] = [], html:string[] = [];
  const definitions = new Map<string,string>();
  const index = (node:Node) => {
    if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(),node.url);
    node.children?.forEach(index);
  };
  index(tree);
  const walk = (node:Node):void => {
    const start=node.position?.start.offset, end=node.position?.end.offset;
    if (node.type === 'link' || node.type === 'linkReference') {
      const href=node.url ?? definitions.get(node.identifier?.toUpperCase() ?? '');
      if (!html.length && !containsImage(node) && href && start!==undefined && end!==undefined && end>start) links.push({href,label:text(node),span:{start,end}});
      return;
    }
    if (skip.has(node.type)) return;
    if (node.type === 'html') {
      for (const tag of (node.value ?? '').matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-z][\w-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu)) {
        if (!tag[2]) continue;
        const name=tag[2].toLowerCase();
        if (tag[1]) { const at=html.lastIndexOf(name); if(at>=0)html.splice(at); }
        else if (!tag[0].endsWith('/>') && !voidTags.has(name)) html.push(name);
      }
      return;
    }
    if (node.type === 'text' && !html.length && start!==undefined && end!==undefined && end>start) eligible.push({start,end});
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
  return {excluded,links,windows:windows.slice(0,LIMITS.windows),limited};
}
