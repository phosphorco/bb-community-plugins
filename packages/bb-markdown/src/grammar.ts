/** Server-only source-offset grammar. Never import from the browser entry. */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import path from 'node:path';
import { MARKDOWN_LIMITS, MARKDOWN_TAGS, MarkdownTreeSchema, type MarkdownNode, type MarkdownTree, type MarkdownDiagnostic, type MarkdownDocument, type MarkdownFileLocation } from './index.js';
export interface Span { start: number; end: number }
interface Node { type: string; value?: string; url?: string; identifier?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
export interface Edit extends Span { value: string }
export interface MarkdownGrammar { text: string; excluded: Span[]; textSpans: Span[]; edits: Edit[]; document: MarkdownDocument | null; tree: MarkdownTree; diagnostics: MarkdownDiagnostic[] }
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, {singleDollarTextMath:false});
const treeProcessor = unified().use(remarkRehype, {allowDangerousHtml:true}).use(rehypeRaw).use(rehypeSanitize, {
  ...defaultSchema,
  attributes: {...defaultSchema.attributes, code:[['className', /^language-/, 'math-inline', 'math-display']]},
});
const span = (node: Node): Span => ({ start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 });
export const overlap = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
export function escapeLabel(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}()!~|]/g, '\\$&');
}
const htmlText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Only fixed BB project/thread routes are local app routes, never arbitrary root URLs. */
export function safeExternal(href: string): boolean {
  if (/[\s\\\u0000-\u001f\u007f]/u.test(href)) return false;
  try { const url = new URL(href); return /^https?:$/.test(url.protocol) && !url.username && !url.password; } catch { return false; }
}
export function safeAppRoute(href: string): boolean { return /^\/projects\/proj_[a-z0-9]+\/threads\/thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}(?:[?#][^\s\\<>]*)?$/u.test(href); }
export function safeLocal(href: string, document: MarkdownDocument | null): boolean {
  if (!document || !href || /[\u0000-\u001f\u007f\\]/u.test(href) || /^(?:[a-z][a-z0-9+.-]*:|\/\/|~)/iu.test(href)) return false;
  try {
    const bare = href.split(/[?#]/u)[0]!;
    const decoded = decodeURIComponent(bare);
    // Encoded separators and traversal have different interpretations in host navigation.
    if (decoded !== bare || !bare || bare.startsWith('//')) return false;
    const resolved = path.posix.resolve(document.rootPath, bare);
    return resolved === document.rootPath || resolved.startsWith(document.rootPath === '/' ? '/' : `${document.rootPath}/`);
  } catch { return false; }
}
function htmlHasUnsafeDestination(value: string): boolean {
  if (/<(?:base|form|input|button|iframe|object|embed)\b/iu.test(value)) return true;
  const attrs = /(?:^|[\s<])(?:href|src|srcset|action|formaction|poster|data|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  for (const attr of value.matchAll(attrs)) { const href = attr[1] ?? attr[2] ?? attr[3] ?? ''; if (!safeExternal(href)) return true; }
  return false;
}
function safeDestination(href: string, document: MarkdownDocument | null, image = false): boolean {
  return safeExternal(href) || (!image && (safeAppRoute(href) || /^#[^\s\\]*$/u.test(href))) || safeLocal(href, document);
}
function flatten(node: Node): string { return node.value ?? node.children?.map(flatten).join('') ?? ''; }
export function compileGrammar(text: string, initialDocument: MarkdownDocument | null): MarkdownGrammar {
  const root = parser.parse(text) as Node;
  const definitions = new Map<string, Node>();
  const diagnostics: MarkdownDiagnostic[] = [];
  const document = initialDocument;
  const inspect = (node: Node) => {
    if (node.type === 'definition' && node.identifier) definitions.set(node.identifier.toLowerCase(), node);
    node.children?.forEach(inspect);
  };
  inspect(root);
  const excluded: Span[] = [], textSpans: Span[] = [], edits: Edit[] = [];
  function visit(node: Node) {
    const range = span(node);
    if (['link', 'image', 'linkReference', 'imageReference', 'definition'].includes(node.type)) {
      // Bare GFM URLs may receive explicit metadata labels, but their whole
      // destination remains exact. Authored link/image syntax is always excluded.
      const raw=text.slice(range.start,range.end);
      if(node.type==='link' && safeExternal(raw) && node.url===raw){textSpans.push(range);return;}
      excluded.push(range);
      const definition = node.identifier ? definitions.get(node.identifier.toLowerCase()) : undefined;
      const href = node.url ?? definition?.url;
      if (!href || !safeDestination(href, document, node.type.startsWith('image'))) {
        if (node.type === 'definition') edits.push({ ...range, value: '' });
        else edits.push({ ...range, value: escapeLabel(node.type.startsWith('image') ? node.value ?? text.slice(range.start, range.end).match(/^!\[([^\]]*)\]/u)?.[1] ?? 'image' : flatten(node)) });
        diagnostics.push({ code: 'inert-local-destination', message: 'An unverified local or unsupported destination is presented as readable text.' });
      }
      return;
    }
    if (['code', 'inlineCode', 'html', 'yaml', 'math', 'inlineMath'].includes(node.type)) {
      excluded.push(range);
      if (node.type === 'html') {
        if (/<(?:video|source)\b/iu.test(node.value??'')) diagnostics.push({code:'unsupported-media',message:'Video/source HTML is outside this initial prepared-tree adapter; other formatted content is retained.'});
        // Keep native sanitized HTML policy for safe markup. Unsafe link-bearing raw HTML
        // is checked conservatively: entities/unquoted attributes cannot bypass URL checks.
        if (htmlHasUnsafeDestination(node.value ?? '')) {
          edits.push({ ...range, value: htmlText(node.value ?? text.slice(range.start, range.end)) });
          diagnostics.push({ code: 'inert-html-destination', message: 'Link-bearing raw HTML is shown as text; native sanitized HTML remains available for other markup.' });
        }
      }
      return;
    }
    // Inline HTML children are separate mdast nodes. Exclude their containing
    // prose range so text between opening/closing tags is never enriched.
    if (node.children?.some(child => child.type === 'html')) excluded.push(range);
    if (node.type === 'text') textSpans.push(range);
    node.children?.forEach(visit);
  }
  visit(root);
  const merged: Span[] = [];
  for (const range of excluded.sort((a,b) => a.start-b.start || b.end-a.end)) {
    const previous = merged.at(-1); if (previous && range.start <= previous.end) previous.end = Math.max(previous.end,range.end); else if (range.end > range.start) merged.push({...range});
  }
  const tree = compileTreeRoot(root, document, diagnostics);
  return { text, excluded: merged, textSpans, edits, document, tree, diagnostics };
}
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let output = text;
  const sorted = [...edits].sort((a,b) => a.start-b.start || b.end-a.end);
  const accepted: Edit[] = [];
  for (const edit of sorted) if (!accepted.some(other => overlap(edit, other))) accepted.push(edit);
  for (const edit of accepted.reverse()) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  return output;
}
export interface NativeThreadToken extends Span { threadId: string; anchor: string; match: string }
/** Explicit tokens only: no loose IDs, path tails, escapes, or Unicode word suffixes. */
export function nativeThreadTokens(grammar: MarkdownGrammar): NativeThreadToken[] {
  const results: NativeThreadToken[] = [];
  const uris=opaqueUriTokens(grammar.text);
  const re = /@thread:(thr_[23456789abcdefghijkmnpqrstuvwxyz]{10})(?:#msg=([1-9]\d{0,11}))?/gu;
  for (const match of grammar.text.matchAll(re)) {
    const start = match.index, end = start + match[0].length;
    const previous = [...grammar.text.slice(Math.max(0,start-2),start)].at(-1) ?? '';
    const next = [...grammar.text.slice(end,end+2)][0] ?? '';
    if (/[\p{L}\p{N}\p{M}_./@-]/u.test(previous) || /[\p{L}\p{N}\p{M}_/#+-]/u.test(next) || (next === '.' && /[\p{L}\p{N}\p{M}_/]/u.test(grammar.text[end+1] ?? ''))) continue;
    let escapes = 0; for(let i=start-1;grammar.text[i] === '\\';i--) escapes++;
    if (escapes % 2 || uris.some(uri=>overlap(uri,{start,end})) || grammar.excluded.some(range => overlap(range,{start,end})) || !grammar.textSpans.some(range => start >= range.start && end <= range.end)) continue;
    results.push({ start, end, match: match[0], threadId: match[1]!, anchor: match[2] ? `#msg=${match[2]}` : '' });
    if (results.length === 64) break;
  }
  return results;
}

interface HtmlNode { type: string; value?: string; tagName?: string; properties?: Record<string,unknown>; children?: HtmlNode[] }
function nodeText(node: HtmlNode): string { return node.value ?? node.children?.map(nodeText).join('') ?? ''; }
function fileDestination(href: string, document: MarkdownDocument | null, allowLocation=true): {path:string;location?:MarkdownFileLocation}|undefined {
  // Native editor schemes are deliberately inert; only the correlated workspace root grants targets.
  const stripped=allowLocation?href.replace(/:(\d+)(?:-(\d+))?$/u,''):href;
  // The actual native image/file mapper treats these as URL/editor delimiters.
  // Reject per node rather than truncating a filename or blanking the document.
  if(!document || /[:?%#]/u.test(stripped) || !safeLocal(stripped,document))return;
  const absolute=path.posix.resolve(document.rootPath,stripped.split(/[?#]/u)[0]!);
  const relative=path.posix.relative(document.rootPath,absolute);if(!relative||relative.startsWith('../')||/[:?%#]/u.test(relative))return;
  const match=allowLocation?href.match(/:(\d+)(?:-(\d+))?$/u):null;
  const line=Number(match?.[1]),end=Number(match?.[2]??match?.[1]);
  return {path:relative,...(match&&line>0&&end>=line&&end<=10_000_000?{location:{kind:'range' as const,startLine:line,endLine:end}}:{})};
}
function compileTreeRoot(root: Node, document: MarkdownDocument|null, diagnostics:MarkdownDiagnostic[]):MarkdownTree {
  const html=treeProcessor.runSync(root as Parameters<typeof treeProcessor.runSync>[0]) as HtmlNode;
  let count=0;
  function convert(node:HtmlNode,depth:number,insideLink=false):MarkdownNode[]{
    if(++count>MARKDOWN_LIMITS.treeNodes||depth>MARKDOWN_LIMITS.treeDepth)throw new Error('Markdown tree exceeds node/depth budget.');
    if(node.type==='text')return [{kind:'text',value:node.value??''}];
    if(node.type==='root')return (node.children??[]).flatMap(child=>convert(child,depth+1));
    if(node.type!=='element')return [];
    const tag=node.tagName??'',props=node.properties??{};
    const title=typeof props.title==='string'?props.title.slice(0,4096):undefined;
    const classes=Array.isArray(props.className)?props.className:[];
    if(tag==='code'&&classes.includes('language-math')){
      const value=nodeText(node);if(value.length>16384)throw new Error('Math exceeds technical leaf budget.');
      return insideLink?[{kind:'element',tag:'code',children:[{kind:'text',value}]}]:[{kind:'math',value,display:classes.includes('math-display')}];
    }
    if(tag==='pre'&&node.children?.length===1&&node.children[0]!.tagName==='code'){
      const code=node.children[0]!,codeClasses=Array.isArray(code.properties?.className)?code.properties.className:[];
      if(codeClasses.includes('language-math'))return convert(code,depth+1,insideLink);
      const language=codeClasses.find(value=>typeof value==='string'&&/^language-[a-zA-Z0-9_+-]{1,64}$/u.test(value));
      if(insideLink)return [{kind:'element',tag:'code',children:[{kind:'text',value:nodeText(code)}]}];
      return [{kind:'code-block',value:nodeText(code).replace(/\n$/u,''),...(typeof language==='string'?{language:language.slice(9)}:{})}];
    }
    if(tag==='img'){
      const src=typeof props.src==='string'?props.src:'',alt=typeof props.alt==='string'?props.alt.slice(0,4096):'';
      if(safeExternal(src))return [{kind:'image',src,alt,...(title?{title}:{})}];
      const file=fileDestination(src,document,false);
      if(file&&document){
        if(!insideLink)return [{kind:'local-image',target:{kind:'workspace',environmentId:document.target.environmentId,path:file.path},alt,...(title?{title}:{})}];
        diagnostics.push({code:'nested-local-image',message:'A verified local image inside an authored link retains alternative text to avoid nested interactive image controls.'});return [{kind:'text',value:alt||src}];
      }
      diagnostics.push({code:'inert-image',message:'An unverified local image is shown as readable alternative text.'});return [{kind:'text',value:alt}];
    }
    const children=(node.children??[]).flatMap(child=>convert(child,depth+1,insideLink||tag==='a'));
    if(tag==='a'){
      const href=typeof props.href==='string'?props.href:'';
      if(!insideLink&&(safeExternal(href)||safeAppRoute(href)||/^#[^\s\\]*$/u.test(href)))return [{kind:'element',tag:'a',href,children,...(title?{title}:{})}];
      const file=fileDestination(href,document);
      if(!insideLink&&file&&document)return [{kind:'file',target:{kind:'workspace',environmentId:document.target.environmentId,path:file.path},children,...(file.location?{location:file.location}:{}),...(title?{title}:{})}];
      diagnostics.push({code:'inert-link',message:'An unverified local or unsupported link retains its formatted label without navigation.'});return children;
    }
    if(!(MARKDOWN_TAGS as readonly string[]).includes(tag)){
      if(tag!=='')diagnostics.push({code:'unsupported-html',message:'A sanitized HTML element has no prepared-tree equivalent; readable children are retained.'});return children;
    }
    const align=props.align==='left'||props.align==='right'||props.align==='center'?props.align:undefined;
    const integer=(key:string,max:number)=>typeof props[key]==='number'&&Number.isInteger(props[key])&&(props[key] as number)>0&&(props[key] as number)<=max?props[key] as number:undefined;
    const start=integer('start',1_000_000),colSpan=integer('colSpan',1000),rowSpan=integer('rowSpan',1000);
    return [{kind:'element',tag:tag as typeof MARKDOWN_TAGS[number],children,...(title?{title}:{}),...(align?{align}:{}),...(start!==undefined?{start}:{}),...(colSpan!==undefined?{colSpan}:{}),...(rowSpan!==undefined?{rowSpan}:{}),...(tag==='input'?{checked:props.checked===true}:{})}];
  }
  const tree:MarkdownTree={version:1,children:convert(html,0)};
  if(!MarkdownTreeSchema.safeParse(tree).success)throw new Error('Markdown tree exceeds its public data budget.');
  return tree;
}
/** Rendering only: enrichment never feeds this result back into recognition. */
export function compilePreparedTree(text:string,document:MarkdownDocument|null):MarkdownTree {
  if(text.length>MARKDOWN_LIMITS.parseChars*2)throw new Error('Prepared text exceeds grammar budget.');
  return compileTreeRoot(parser.parse(text) as Node,document,[]);
}

/** Outer scheme tokens are opaque: a reference in a query, path or unknown URI
 * cannot acquire an unrelated identity. Explicit @thread syntax is handled separately. */
export function opaqueUriTokens(text:string):Span[]{
  const result:Span[]=[];
  for(const match of text.matchAll(/[a-z][a-z0-9+.-]*:[^\s<>"`]+/giu)){
    if(match[0].startsWith('thread:')&&text[match.index-1]==='@')continue;
    let value=match[0];
    if(!/[?#]/u.test(value)){
      const counts:Record<string,number>={')':0,']':0,'}':0};
      for(const char of value){if(char==='(')counts[')']!--;else if(char==='[')counts[']']!--;else if(char==='{')counts['}']!--;else if(char in counts)counts[char]!++;}
      while(value){const last=value.at(-1)!;if(/[.,;:!?]/u.test(last))value=value.slice(0,-1);else if((counts[last]??0)>0){counts[last]!--;value=value.slice(0,-1);}else break;}
    }
    if(value)result.push({start:match.index,end:match.index+value.length});
  }
  return result;
}
