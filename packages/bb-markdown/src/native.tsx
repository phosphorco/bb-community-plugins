import { Markdown as SdkMarkdown } from '@get-bb/plugin-sdk/app';

const NODE_CHARS = 262_144;
/** A generated fence, never arbitrary message prose. A longer delimiter cannot
 * be closed by authored code. No source/frame or local navigation is inferred. */
export function safeCodeFence(value: string, language?: string): string | null {
  if(typeof value!=='string'||value.length>NODE_CHARS)return null;
  const runs=value.match(/`+/g)??[];
  const longest=runs.reduce((max,run)=>Math.max(max,run.length),2);
  // Avoid constructing huge repeated delimiters from adversarial code.
  if(longest>128)return null;
  const fence='`'.repeat(longest+1);
  const lang=typeof language==='string'&&/^[a-zA-Z0-9_+-]{1,48}$/.test(language)?language:'';
  return `${fence}${lang}\n${value}\n${fence}`;
}
/** Host math uses double-dollar inline math (single-dollar is disabled).
 * Unsupported delimiter-bearing values stay readable code, not broken-out prose. */
export function safeMathSource(value: string, display: boolean): string | null {
  if(typeof value!=='string'||value.length>65_536||value.includes('$')||value.includes('\u0000')||(!display&&/[\r\n]/.test(value)))return null;
  return display?`$$\n${value}\n$$`:`$$${value}$$`;
}
export function NativeCodeBlock({value,language,className}:{value:string;language?:string;className?:string}) {
  // math fences are normalized into prose by the native pipeline. Admit them
  // through the independently fenced math path rather than a code escape.
  if(language?.toLowerCase()==='math')return <NativeMath value={value} display {...(className?{className}:{})}/>;
  const content=safeCodeFence(value,language);
  return content===null?<pre className={className}><code>{value}</code></pre>:<SdkMarkdown content={content} {...(className?{className}:{})}/>;
}
export function NativeMath({value,display,className}:{value:string;display:boolean;className?:string}) {
  const content=safeMathSource(value,display);
  return content===null?<code className={className} data-markdown-unsupported="math-delimiter">{value}</code>:<SdkMarkdown content={content} {...(className?{className}:{})}/>;
}

/** Only a validated source-contained image target, never an authored URL or
 * original prose. The selected image itself is the real document target. */
export function NativeImage({target,document,alt,title}:{target:{kind:'workspace';environmentId:string;path:string};document:{threadId:string;rootPath:string};alt:string;title?:string}) {
  const pieces=target.path.split('/'),name=pieces.at(-1)??'';
  if(!/^thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/.test(document.threadId)||!/^env_[a-z0-9]+$/.test(target.environmentId)||!document.rootPath.startsWith('/')||/[\\\u0000-\u001f\u007f]/u.test(document.rootPath)||!name||pieces.some(part=>!part||part==='.'||part==='..')||/[\\:%?#\u0000-\u001f\u007f]/u.test(target.path))return <span>{alt}</span>;
  const label=alt.replace(/[\r\n]/g,' ').replace(/&/g,'&amp;').replace(/[\\\[\]<>]/g,'\\$&');
  const tooltip=title?` "${title.replace(/[\r\n]/g,' ').replace(/&/g,'&amp;').replace(/[\\"<>]/g,'\\$&')}"`:'';
  const content=`![${label}](<${encodeURIComponent(name)}>${tooltip})`;
  return <SdkMarkdown content={content} experimental_document={{...document,target}}/>;
}
