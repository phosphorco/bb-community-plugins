import { useEffect, useRef, useState } from 'react';
import type { AttachmentReference } from './index.js';
export interface ClipboardClient { writeText(text:string):Promise<void>; }
export interface ConnectionDetailsProps {ownerKey:string;url:string;instructions:string;clipboard:ClipboardClient;busy?:boolean;status?:string|null;error?:string|null;urlLabel?:string;}
export function ConnectionDetails(props:ConnectionDetailsProps){
 const [feedback,setFeedback]=useState<{copied?:string;error?:string}|null>(null);
 const generation=useRef(0);
 useEffect(()=>{generation.current++;setFeedback(null);return()=>{generation.current++;};},[props.ownerKey,props.url,props.instructions,props.clipboard]);
 async function copy(kind:'URL'|'Instructions',value:string){const current=++generation.current;try{await props.clipboard.writeText(value);if(current===generation.current)setFeedback({copied:kind});}catch(e){if(current===generation.current)setFeedback({error:e instanceof Error?e.message:'Could not copy to the clipboard.'});}}
 return <div className="bb-agent-connection-details">
  <input aria-label={props.urlLabel??'Agent connection URL'} value={props.url} readOnly spellCheck={false} onFocus={e=>e.currentTarget.select()} />
  <button type="button" disabled={props.busy} onClick={()=>void copy('URL',props.url)}>Copy URL</button>
  <button type="button" disabled={props.busy} onClick={()=>void copy('Instructions',props.instructions)}>Copy Instructions</button>
  {props.status?<p role="status">{props.status}</p>:null}
  <span role="status">{feedback?.copied?`${feedback.copied} copied.`:''}</span>
  {props.error||feedback?.error?<p role="alert">{props.error??feedback?.error}</p>:null}
 </div>;
}
/** Owner supplies preview URLs only after resolving scoped references. No fetching on mount. */
export function AttachmentList({attachments,previewUrls={}}:{attachments:readonly AttachmentReference[];previewUrls?:Readonly<Record<string,string>>}){
 return <ul aria-label="Attachments">{attachments.map(a=>{const url=previewUrls[a.uploadId];const safe=url&&/^(https?:|blob:)/.test(url)?url:undefined;return <li key={a.uploadId}>{a.presentationKind==='image'&&safe?<img src={safe} alt={a.filename} loading="lazy"/>:null}<span>{a.filename} · {a.declaredMimeType} · {a.sizeBytes} bytes</span></li>;})}</ul>;
}
