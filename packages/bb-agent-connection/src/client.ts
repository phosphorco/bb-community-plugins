import { LIMITS, uploadRequestSchema, uploadResponseSchema, uploadErrorSchema } from './index.js';
import type { UploadRequest, AttachmentReference } from './index.js';
export class UploadProtocolError extends Error {
 constructor(readonly code:string,message:string,readonly status?:number){super(message);this.name='UploadProtocolError';}
}
/** Reserve before reading. Release is called exactly once after reading or failure.
 * Successful returned bytes become caller-owned; reserve retained staging separately. */
export interface UploadBudget { reserve(bytes:number,signal?:AbortSignal):Promise<()=>void>; }
export async function readBoundedBody(stream:ReadableStream<Uint8Array>, maxBytes:number, options:{signal?:AbortSignal;onBytes?:(received:number)=>void} = {}):Promise<Uint8Array>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>LIMITS.totalBytes)throw new Error('Invalid byte budget');
 const reader=stream.getReader();let total=0;const chunks:Uint8Array[]=[];
 const abort=()=>{void reader.cancel(options.signal?.reason).catch(()=>{});};
 options.signal?.addEventListener('abort',abort,{once:true});
 try {
  options.signal?.throwIfAborted();
  for(;;){const {done,value}=await reader.read();options.signal?.throwIfAborted();if(done)break;
   total+=value.byteLength;if(total>maxBytes)throw new UploadProtocolError('UPLOAD_TOO_LARGE','Received byte limit exceeded',413);
   options.onBytes?.(total);chunks.push(value.slice());
  }
  const result=new Uint8Array(total);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}return result;
 }catch(e){await reader.cancel(e).catch(()=>{});throw e;}finally{options.signal?.removeEventListener('abort',abort);reader.releaseLock();}
}
export async function readUploadBody(stream:ReadableStream<Uint8Array>, metadata:UploadRequest, options:{budget:UploadBudget;signal?:AbortSignal;onBytes?:(received:number)=>void}):Promise<Uint8Array>{
 const request=uploadRequestSchema.parse(metadata);options.signal?.throwIfAborted();
 const release=await options.budget.reserve(request.sizeBytes,options.signal);
 try{options.signal?.throwIfAborted();const bytes=await readBoundedBody(stream,request.sizeBytes,options);if(bytes.length!==request.sizeBytes)throw new UploadProtocolError('INVALID_UPLOAD','Received byte count differs',400);return bytes;}finally{release();}
}
export const UPLOAD_HEADERS = Object.freeze({version:'x-bb-upload-version',operationId:'x-bb-upload-operation-id',filename:'x-bb-upload-filename',sizeBytes:'x-bb-upload-size',presentationKind:'x-bb-upload-kind'});
export function uploadRequestHeaders(input:UploadRequest):Headers {
 const r=uploadRequestSchema.parse(input);return new Headers({'content-type':r.declaredMimeType,[UPLOAD_HEADERS.version]:'1',[UPLOAD_HEADERS.operationId]:r.operationId,[UPLOAD_HEADERS.filename]:encodeURIComponent(r.filename),[UPLOAD_HEADERS.sizeBytes]:String(r.sizeBytes),[UPLOAD_HEADERS.presentationKind]:r.presentationKind});
}
export function uploadRequestFromHeaders(headers:Headers):UploadRequest {
 if(headers.get(UPLOAD_HEADERS.version)!=='1')throw new UploadProtocolError('INVALID_UPLOAD','Unsupported upload version',400);
 const size=headers.get(UPLOAD_HEADERS.sizeBytes);if(!size||!/^[1-9][0-9]*$/.test(size))throw new UploadProtocolError('INVALID_UPLOAD','Invalid byte count',400);
 return uploadRequestSchema.parse({operationId:headers.get(UPLOAD_HEADERS.operationId),filename:decodeURIComponent(headers.get(UPLOAD_HEADERS.filename)??''),declaredMimeType:headers.get('content-type'),sizeBytes:Number(size),presentationKind:headers.get(UPLOAD_HEADERS.presentationKind)});
}
/** Immutable feature replay compares metadata AND actual bytes/digest under the same scoped key. */
export function uploadIdentity(input:UploadRequest):string {const r=uploadRequestSchema.parse(input);return JSON.stringify([r.operationId,r.filename,r.declaredMimeType,r.sizeBytes,r.presentationKind]);}
export async function uploadAttachment(options:{endpoint:string;request:UploadRequest;bytes:Uint8Array;fetch:typeof fetch;signal?:AbortSignal}):Promise<AttachmentReference>{
 const request=uploadRequestSchema.parse(options.request);if(options.bytes.byteLength!==request.sizeBytes)throw new UploadProtocolError('INVALID_UPLOAD','Byte count differs',400);
 options.signal?.throwIfAborted();
 const response=await options.fetch(options.endpoint,{method:'POST',headers:uploadRequestHeaders(request),body:new Blob([Uint8Array.from(options.bytes)]),...(options.signal?{signal:options.signal}:{})});
 if(!response.body)throw new UploadProtocolError('INVALID_RESPONSE','Missing upload response');
 const bytes=await readBoundedBody(response.body,LIMITS.responseBytes,options);
 const body:unknown=JSON.parse(new TextDecoder().decode(bytes));
 if(!response.ok){const error=uploadErrorSchema.safeParse(body);throw new UploadProtocolError(error.success?error.data.code:'UPLOAD_FAILED',error.success?error.data.message:`Upload failed (${response.status})`,response.status);}
 const result=uploadResponseSchema.parse(body);
 const a=result.attachment;
 if(result.operationId!==request.operationId||a.filename!==request.filename||a.declaredMimeType!==request.declaredMimeType||a.sizeBytes!==request.sizeBytes||a.presentationKind!==request.presentationKind)throw new UploadProtocolError('INVALID_RESPONSE','Upload response identity differs');
 return a;
}
