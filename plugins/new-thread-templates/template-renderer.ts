import {z} from 'zod';

export const TEMPLATE_LIMITS={sourceBytes:262144,nodes:4096,depth:32,arguments:32,steps:20000,workBytes:4*1024*1024,outputBytes:262144} as const;
export function isValidTimeZone(zone:string):boolean {
  if(!/^[A-Za-z][A-Za-z0-9_+./-]{0,199}$/.test(zone))return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:zone});return true;}catch{return false;}
}
export const renderContextSchema=z.object({version:z.literal(1),instant:z.number().int().min(-8640000000000000).max(8640000000000000),timeZone:z.string().max(200).refine(isValidTimeZone,'Use a valid IANA time zone')}).strict();
export type RenderContext=z.infer<typeof renderContextSchema>;
export function createRenderContext(timeZone='UTC',instant=Date.now()):RenderContext {return renderContextSchema.parse({version:1,instant,timeZone});}
export interface TemplateDiagnostic {message:string;line:number;column:number;offset:number}
type SourceLocation={line:number;column:number};
type SourceLocator=(offset:number)=>SourceLocation;
// One bounded source pass per validation, then UTF-16 offset lookups without
// allocating/scanning a new prefix for every diagnostic.
function sourceLocator(source:string):SourceLocator {
  const starts=[0];for(let i=0;i<source.length;i++)if(source.charCodeAt(i)===10)starts.push(i+1);
  return offset=>{let low=0,high=starts.length;while(low+1<high){const mid=(low+high)>>>1;if(starts[mid]!<=offset)low=mid;else high=mid;}return {line:low+1,column:offset-starts[low]!+1};};
}
function singleLocation(source:string,offset:number):SourceLocation {
  let line=1,start=0;for(let i=0;i<offset&&i<source.length;i++)if(source.charCodeAt(i)===10){line++;start=i+1;}return {line,column:offset-start+1};
}
export class TemplateError extends Error {
  readonly diagnostic:TemplateDiagnostic;
  constructor(source:string,offset:number,message:string,locate?:SourceLocator){const diagnostic={message,...(locate?locate(offset):singleLocation(source,offset)),offset};super(`${message} (line ${diagnostic.line}, column ${diagnostic.column})`);this.name='TemplateError';this.diagnostic=diagnostic;}
}
type Primitive=string|number|boolean|undefined;
type Value=Primitive|{instant:number};
type Expr={kind:'field';key:string;at:number}|{kind:'literal';value:Primitive;at:number}|{kind:'now';at:number}|{kind:'call';name:string;args:Expr[];at:number};
type Node={kind:'text';text:string;at:number}|{kind:'value';expr:Expr;fallback?:string;at:number}|{kind:'block';unless:boolean;expr:Expr;yes:Node[];no:Node[];at:number};
type Token={kind:'word'|'string'|'('|')';value:string;at:number};
const legacy=/^\s*([a-zA-Z][a-zA-Z0-9_]*)(?:\|([^{}]*))?\s*$/;
const arities:Record<string,readonly [number,number]>={upper:[1,1],lower:[1,1],trim:[1,1],concat:[1,32],default:[2,2],eq:[2,2],not:[1,1],and:[2,32],or:[2,32],date:[1,2]};
// Count UTF-8 without allocating an encoded copy just to enforce an allocation budget.
function utf8(s:string):number {let bytes=0;for(let i=0;i<s.length;i++){const code=s.charCodeAt(i);if(code<128)bytes++;else if(code<2048)bytes+=2;else if(code>=0xd800&&code<=0xdbff&&i+1<s.length&&s.charCodeAt(i+1)>=0xdc00&&s.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else bytes+=3;}return bytes;}
function parse(source:string):Node[] {
  const fail=(at:number,message:string):never=>{throw new TemplateError(source,at,message);};
  if(source.length>TEMPLATE_LIMITS.sourceBytes||utf8(source)>TEMPLATE_LIMITS.sourceBytes)fail(0,'Template source exceeds the size limit');
  let nodes=0,tokens=0;
  const count=(at:number)=>{if(++nodes>TEMPLATE_LIMITS.nodes)fail(at,'Template node budget exceeded');};
  function lex(text:string,base:number):Token[]{
    const result:Token[]=[];let i=0;
    while(i<text.length){if(/\s/.test(text[i]!)){i++;continue;}const at=base+i,c=text[i]!;let token:Token;
      if(c==='('||c===')'){token={kind:c,value:c,at};i++;}
      else if(c==='"'||c==="'"){const quote=c;let value='';i++;let closed=false;while(i<text.length){const char=text[i++]!;if(char===quote){closed=true;break;}if(char==='\\'){const next=text[i++];if(next===undefined)fail(at,'Unterminated quoted string');const escaped:Record<string,string>={n:'\n',r:'\r',t:'\t','\\':'\\',"'":"'",'"':'"'};if(!Object.hasOwn(escaped,next!))fail(base+i-1,'Unsupported string escape');value+=escaped[next!]!;}else value+=char;}if(!closed)fail(at,'Unterminated quoted string');token={kind:'string',value,at};}
      else {const start=i;while(i<text.length&&!/[\s()]/.test(text[i]!))i++;token={kind:'word',value:text.slice(start,i),at};}
      if(++tokens>TEMPLATE_LIMITS.nodes*4)fail(at,'Template token budget exceeded');result.push(token);
    }return result;
  }
  function expression(text:string,base:number,blockDepth:number):Expr {
    const list=lex(text,base);let pos=0;
    function atom(depth:number):Expr {if(depth+blockDepth>TEMPLATE_LIMITS.depth)fail(list[pos]?.at??base,'Template nesting limit exceeded');const t=list[pos++];if(!t)fail(base+text.length,'Expected expression');count(t!.at);
      if(t!.kind==='('){const expr=call(depth+1,true);if(list[pos]?.kind!==')')fail(list[pos]?.at??t!.at,'Expected closing parenthesis');pos++;return expr;}
      if(t!.kind==='string')return {kind:'literal',value:t!.value,at:t!.at};
      if(t!.kind!== 'word')fail(t!.at,'Unexpected parenthesis');
      if(t!.value==='@now')return {kind:'now',at:t!.at};
      if(t!.value==='true'||t!.value==='false')return {kind:'literal',value:t!.value==='true',at:t!.at};
      if(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(t!.value)){const value=Number(t!.value);if(!Number.isFinite(value))fail(t!.at,'Expected a finite number');return {kind:'literal',value,at:t!.at};}
      if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(t!.value))fail(t!.at,'Use a field name; property traversal and executable expressions are not supported');
      return {kind:'field',key:t!.value,at:t!.at};
    }
    function call(depth:number,parenthesized:boolean):Expr {
      const name=list[pos++];if(!name||name.kind!=='word'||!Object.hasOwn(arities,name.value))fail(name?.at??base,'Unknown template helper');const args:Expr[]=[];
      while(pos<list.length&&list[pos]!.kind!==')'){if(args.length===TEMPLATE_LIMITS.arguments)fail(list[pos]!.at,'Helper argument limit exceeded');args.push(atom(depth));}
      const [min,max]=arities[name!.value]!;if(args.length<min||args.length>max)fail(name!.at,`${name!.value} expects ${min===max?min:`${min}..${max}`} argument(s)`);if(name!.value==='date'){try{const input=args[0],format=args[1];if(input?.kind==='literal'){if(typeof input.value!=='string')throw Error('date requires @now or an explicit ISO timestamp');strictIso(input.value);}if(format?.kind==='literal'&&typeof format.value==='string')checkFormat(format.value);}catch(error){fail(name!.at,error instanceof Error?error.message:String(error));}}count(name!.at);if(!parenthesized&&pos!==list.length)fail(list[pos]!.at,'Unexpected closing parenthesis');return {kind:'call',name:name!.value,args,at:name!.at};
    }
    if(!list.length)fail(base,'Expected expression');
    const expr=list[0]!.kind==='word'&&list.length>1?call(1,false):atom(1);if(pos!==list.length)fail(list[pos]!.at,'Unexpected expression');return expr;
  }
  const root:Node[]=[];const stack:{node:Extract<Node,{kind:'block'}>;inElse:boolean}[]=[];
  const append=(node:Node)=>{count(node.at);const frame=stack.at(-1);(frame?(frame.inElse?frame.node.no:frame.node.yes):root).push(node);};
  let cursor=0;
  while(cursor<source.length){const start=source.indexOf('{{',cursor);const stray=source.indexOf('}}',cursor);if(stray!==-1&&(start===-1||stray<start))fail(stray,'Unexpected closing template delimiter');if(start===-1){append({kind:'text',text:source.slice(cursor),at:cursor});break;}if(start>cursor)append({kind:'text',text:source.slice(cursor,start),at:cursor});
    let end=source.indexOf('}}',start+2);const first=end===-1?null:legacy.exec(source.slice(start+2,end));
    if(!first){let quote='',escaped=false;end=-1;for(let i=start+2;i<source.length;i++){const c=source[i]!;if(escaped){escaped=false;continue;}if(quote){if(c==='\\')escaped=true;else if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='}'&&source[i+1]==='}'){end=i;break;}}}
    if(end===-1)fail(start,'Unterminated template token');const raw=source.slice(start+2,end),trimmed=raw.trim(),base=start+2;
    if(trimmed==='else'&&stack.length){const frame=stack.at(-1)!;if(frame.inElse)fail(start,'Duplicate else');frame.inElse=true;}
    else if(trimmed.startsWith('/')){const frame=stack.pop();if(!frame||trimmed!==`/${frame.node.unless?'unless':'if'}`)fail(start,'Mismatched closing block');}
    else if(trimmed.startsWith('#')){const match=/^#(if|unless)\s+([\s\S]+)$/.exec(trimmed);if(!match)fail(start,'Only if/unless blocks with one condition are supported');if(stack.length>=TEMPLATE_LIMITS.depth)fail(start,'Template nesting limit exceeded');const text=match![2]!,expr=expression(text,base+raw.indexOf(text),stack.length+1),node:Extract<Node,{kind:'block'}>={kind:'block',unless:match![1]==='unless',expr,yes:[],no:[],at:start};append(node);stack.push({node,inElse:false});}
    else if(first){append({kind:'value',expr:{kind:'field',key:first[1]!,at:base},...(first[2]!==undefined?{fallback:first[2]}:{}),at:start});}
    else append({kind:'value',expr:expression(raw,base,stack.length),at:start});
    cursor=end+2;
  }
  if(stack.length)fail(stack.at(-1)!.node.at,'Unclosed conditional block');return root;
}
export function validateTemplate(source:string,fieldKeys:Iterable<string>):TemplateDiagnostic[]{
  try{const tree=parse(source),keys=new Set(fieldKeys),issues:TemplateDiagnostic[]=[],locate=sourceLocator(source);const expr=(e:Expr)=>{if(e.kind==='field'&&!keys.has(e.key))issues.push(new TemplateError(source,e.at,`Unknown field ${e.key}`,locate).diagnostic);if(e.kind==='call'){e.args.forEach(expr);if(e.name==='date'){const input=e.args[0],format=e.args[1];try{if(input?.kind==='literal'&&typeof input.value==='string')strictIso(input.value);if(format?.kind==='literal'&&typeof format.value==='string')checkFormat(format.value);}catch(error){issues.push(new TemplateError(source,e.at,error instanceof Error?error.message:String(error),locate).diagnostic);}}}};const walk=(nodes:Node[])=>{for(const n of nodes){if(n.kind==='value')expr(n.expr);if(n.kind==='block'){expr(n.expr);walk(n.yes);walk(n.no);}}};walk(tree);return issues;}catch(error){return [error instanceof TemplateError?error.diagnostic:{message:error instanceof Error?error.message:String(error),line:1,column:1,offset:0}];}
}
function checkFormat(format:string){for(const token of format.matchAll(/yyyy|MM|dd|HH|mm|ss|EEE|[\p{L}]+/gu))if(!['yyyy','MM','dd','HH','mm','ss','EEE'].includes(token[0]))throw Error(`Unknown date format token ${token[0]}; use yyyy MM dd HH mm ss EEE`);}
function strictIso(value:string):number {
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);if(!m)throw Error('Use an ISO timestamp with explicit Z or offset');
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),hour=Number(m[4]),minute=Number(m[5]),second=Number(m[6]),zone=m[8]!;const leap=year%4===0&&(year%100!==0||year%400===0);const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(month<1||month>12||day<1||day>days[month-1]!||hour>23||minute>59||second>59||(zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4))>59)))throw Error('Invalid ISO calendar date or offset');const instant=Date.parse(value);if(!Number.isFinite(instant))throw Error('Invalid ISO instant');return instant;
}
export function renderText(source:string,inputs:Record<string,string|number|boolean>,limit:number=TEMPLATE_LIMITS.outputBytes,context?:RenderContext):string {
  if(!Number.isInteger(limit)||limit<0)throw new TemplateError(source,0,'Invalid output size limit');if(source.length>TEMPLATE_LIMITS.sourceBytes)throw new TemplateError(source,0,'Template source exceeds the size limit');if(source.length>limit||utf8(source)>limit)throw new TemplateError(source,0,'Rendered text exceeds the size limit');if(context)renderContextSchema.parse(context);
  const tree=parse(source);let steps=0,work=0;const fail=(at:number,message:string):never=>{throw new TemplateError(source,at,message);};
  function bound(value:string,at:number):string{if(value.length>limit)fail(at,'Rendered text exceeds the size limit');const size=utf8(value);if(size>limit)fail(at,'Rendered text exceeds the size limit');work+=size;if(work>TEMPLATE_LIMITS.workBytes)fail(at,'Template string work budget exceeded');return value;}
  const partsCache=new Map<number,Record<string,string>>(),suffixCache=new Map<number,string>(),shortFormatters=new Map<string,Intl.DateTimeFormat>();let formatter:Intl.DateTimeFormat|undefined;
  function zoneSuffix(instant:number,longOffset:string):string {
    const cached=suffixCache.get(instant);if(cached!==undefined)return cached;
    const canonicalZone=formatter!.resolvedOptions().timeZone;
    let result:string|undefined;
    if(canonicalZone==='UTC')result='UTC';
    else for(const locale of canonicalZone==='America/Sao_Paulo'?['en-US','en-GB','pt-BR']:['en-US','en-GB']) {
      let short=shortFormatters.get(locale);if(!short){short=new Intl.DateTimeFormat(locale,{timeZone:context?.timeZone??'UTC',timeZoneName:'short'});shortFormatters.set(locale,short);}
      const name=short.formatToParts(new Date(instant)).find(part=>part.type==='timeZoneName')?.value;
      if(name&&/^[A-Z]{2,8}$/.test(name)){result=name;break;}
    }
    if(result===undefined){
      // The actual instant's offset is the fallback, including historical seconds.
      const offset=/^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(longOffset);
      result=offset?`GMT${offset[1]}${Number(offset[2])}${offset[3]!=='00'||offset[4]&&offset[4]!=='00'?':'+offset[3]:''}${offset[4]&&offset[4]!=='00'?':'+offset[4]:''}`:longOffset;
    }
    suffixCache.set(instant,result);return result;
  }
  function date(instant:number,format:string,at:number):string {
    const zone=context?.timeZone??'UTC';let parts=partsCache.get(instant);if(!parts){formatter??=new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone:zone,calendar:'gregory',numberingSystem:'latn',era:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short',hourCycle:'h23',timeZoneName:'longOffset'});parts=Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p=>[p.type,p.value]));partsCache.set(instant,parts);}
    const year=parts.era==='BC'?1-Number(parts.year):Number(parts.year);
    const yearText=year<0?'-'+String(-year).padStart(6,'0'):year>9999?'+'+String(year).padStart(6,'0'):String(year).padStart(4,'0');
    const values:Record<string,string>={yyyy:yearText,MM:parts.month!,dd:parts.day!,HH:parts.hour!,mm:parts.minute!,ss:parts.second!,EEE:parts.weekday!};
    const suffix=` ${zoneSuffix(instant,parts.timeZoneName!)}`,chunks:string[]=[];let size=utf8(suffix);
    for(const match of format.matchAll(/yyyy|MM|dd|HH|mm|ss|EEE|[\p{L}]+|[^\p{L}]+/gu)){const token=match[0];if(/^\p{L}/u.test(token)&&!Object.hasOwn(values,token))fail(at,`Unknown date format token ${token}; use yyyy MM dd HH mm ss EEE`);const value=values[token]??token;size+=utf8(value);if(size>limit)fail(at,'Rendered text exceeds the size limit');chunks.push(value);}
    if(size>limit)fail(at,'Rendered text exceeds the size limit');return bound(chunks.join('')+suffix,at);
  }
  const truth=(v:Value)=>typeof v==='object'?true:!!v;
  const text=(v:Value,at:number):string=>typeof v==='object'?date(v.instant,'yyyy-MM-dd HH:mm:ss',at):bound(v===undefined?'':String(v),at);
  function evalExpr(expr:Expr):Value {
    if(++steps>TEMPLATE_LIMITS.steps)fail(expr.at,'Template evaluation budget exceeded');
    if(expr.kind==='literal')return typeof expr.value==='string'?bound(expr.value,expr.at):expr.value;
    if(expr.kind==='field'){const value=Object.hasOwn(inputs,expr.key)?inputs[expr.key]:undefined;return typeof value==='string'?bound(value,expr.at):value;}
    if(expr.kind==='now'){if(!context)fail(expr.at,'@now requires a frozen render context');return {instant:context!.instant};}
    const args=expr.args,name=expr.name;
    if(name==='and')return args.every(a=>truth(evalExpr(a)));if(name==='or')return args.some(a=>truth(evalExpr(a)));if(name==='not')return !truth(evalExpr(args[0]!));
    if(name==='default'){const value=evalExpr(args[0]!);return value===undefined||value===''?evalExpr(args[1]!):value;}
    if(name==='eq'){const a=evalExpr(args[0]!),b=evalExpr(args[1]!);return typeof a==='object'&&typeof b==='object'?a.instant===b.instant:a===b;}
    if(name==='date'){const value=evalExpr(args[0]!);let instant:number;try{instant=typeof value==='object'?value.instant:typeof value==='string'?strictIso(value):NaN;if(!Number.isFinite(instant))throw Error('date requires @now or an explicit ISO timestamp');}catch(error){fail(expr.at,error instanceof Error?error.message:String(error));}const format=args[1]?text(evalExpr(args[1]),expr.at):'yyyy-MM-dd HH:mm:ss';return date(instant!,format,expr.at);}
    const values=args.map(a=>text(evalExpr(a),a.at));
    if(name==='concat'){const size=values.reduce((n,v)=>n+utf8(v),0);if(size>limit)fail(expr.at,'Rendered text exceeds the size limit');return bound(values.join(''),expr.at);}
    const value=values[0]!;if(name==='trim')return bound(value.trim(),expr.at);
    // Preflight Unicode expansion before allocating the whole-string mapping. Default
    // contextual lowercase (notably final sigma) retains the mapped code point byte size.
    let size=0;for(const char of value){const converted=name==='upper'?char.toUpperCase():char.toLowerCase();size+=utf8(converted);if(size>limit)fail(expr.at,'Rendered text exceeds the size limit');bound(converted,expr.at);}
    return bound(name==='upper'?value.toUpperCase():value.toLowerCase(),expr.at);
  }
  const output:string[]=[];let size=0;
  function walk(nodes:Node[]){for(const node of nodes){if(++steps>TEMPLATE_LIMITS.steps)fail(node.at,'Template evaluation budget exceeded');if(node.kind==='block'){const yes=truth(evalExpr(node.expr))!==node.unless;walk(yes?node.yes:node.no);continue;}let value:string;if(node.kind==='text')value=bound(node.text,node.at);else {const result=evalExpr(node.expr);value=node.fallback!==undefined&&(result===undefined||result==='')?bound(node.fallback,node.at):text(result,node.at);}size+=utf8(value);if(size>limit)fail(node.at,'Rendered text exceeds the size limit');output.push(value);}}
  walk(tree);return output.join('');
}
