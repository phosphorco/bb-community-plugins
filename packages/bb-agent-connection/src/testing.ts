import { attachmentReferenceSchema, directSendInputSchema, directSubmissionReceiptSchema, uploadRequestSchema } from './index.js';
import type { AttachmentReference, UploadRequest } from './index.js';
export const TEXT_ONLY_COMPATIBILITY = Object.freeze({message:'Hello',mode:'AUTO'} as const);
/** Connect this driver to the adopter's REAL route/coordinator and durable store.
 * Fresh isolated owner scope required; upload must reject changed same-key bytes.
 * No fake transport/registry is provided by this kit. */
export interface AttachmentConformanceDriver {
 upload(request:UploadRequest,bytes:Uint8Array):Promise<unknown>;
 /** Normalize real route/coordinator conflicts; transport failure is not conflict proof. */
 isConflict(error:unknown):boolean;
 send(input:{message:string;mode:'AUTO';operationId:string;attachments?:AttachmentReference[]}):Promise<unknown>;
}
export async function runUploadConformance(driver:Pick<AttachmentConformanceDriver,'upload'|'isConflict'>, fixture:{request:UploadRequest;bytes:Uint8Array}):Promise<AttachmentReference>{
 const request=uploadRequestSchema.parse(fixture.request);
 if(fixture.bytes.length!==request.sizeBytes)throw new Error('Fixture byte count differs');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(fixture.bytes))),n=>n.toString(16).padStart(2,'0')).join('');
 const first=attachmentReferenceSchema.parse(await driver.upload(request,fixture.bytes));
 if(first.sha256!==digest)throw new Error('Upload digest differs from fixture bytes');
 if(first.filename!==request.filename || first.declaredMimeType!==request.declaredMimeType || first.sizeBytes!==request.sizeBytes || first.presentationKind!==request.presentationKind)throw new Error('Upload metadata differs');
 const replay=attachmentReferenceSchema.parse(await driver.upload(request,fixture.bytes));
 if(JSON.stringify(first)!==JSON.stringify(replay))throw new Error('Upload replay changed reference');
 const changed=fixture.bytes.slice();changed[0]=(changed[0]??0)^1;
 let rejected=false;try{await driver.upload(request,changed);}catch(error){if(!driver.isConflict(error))throw error;rejected=true;}if(!rejected)throw new Error('Same-key changed bytes accepted');
 rejected=false;try{await driver.upload({...request,filename:`x${request.filename}`},fixture.bytes);}catch(error){if(!driver.isConflict(error))throw error;rejected=true;}if(!rejected)throw new Error('Same-key changed metadata accepted');
 return first;
}
export async function runAttachmentConformance(driver:AttachmentConformanceDriver, fixture:{request:UploadRequest;bytes:Uint8Array;sendOperationId:string;textOperationId:string}):Promise<void>{
 const first=await runUploadConformance(driver,fixture);
 const input={...TEXT_ONLY_COMPATIBILITY,operationId:fixture.sendOperationId,attachments:[first]};directSendInputSchema.parse(input);
 const receipt=directSubmissionReceiptSchema.parse(await driver.send(input));
 const again=directSubmissionReceiptSchema.parse(await driver.send(input));
 if(receipt.threadId!==again.threadId || receipt.clientOperationId!==again.clientOperationId)throw new Error('Send replay changed receipt identity');
 let conflicted=false;try{await driver.send({...input,message:'Changed immutable message'});}catch(error){if(!driver.isConflict(error))throw error;conflicted=true;}if(!conflicted)throw new Error('Changed same-key send accepted');
 if(receipt.serverOperationId!==again.serverOperationId)throw new Error('Send replay changed operation');
 directSubmissionReceiptSchema.parse(await driver.send({...TEXT_ONLY_COMPATIBILITY,operationId:fixture.textOperationId}));
}
