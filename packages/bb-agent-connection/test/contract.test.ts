import {runUploadConformance} from '../dist/testing.js';
import {test,expect} from 'bun:test';
import {attachmentReferenceSchema,attachmentReferencesSchema,directSendInputSchema,connectionPath,connectionInstructions,CONNECTION_GRAPHQL_TYPES,LIMITS,uploadRequestSchema} from '../dist/index.js';
import {readUploadBody,uploadAttachment,uploadRequestHeaders,uploadRequestFromHeaders,uploadIdentity} from '../dist/client.js';
import {nativeAttachmentInput,resolveAttachmentInputs,nativeAttachmentDescriptorSchema} from '../dist/bb.js';
const request={operationId:'upload-1',filename:'image.png',declaredMimeType:'image/png',sizeBytes:3,presentationKind:'image' as const};
const ref={uploadId:'u1',filename:request.filename,declaredMimeType:request.declaredMimeType,sizeBytes:3,sha256:'a'.repeat(64),presentationKind:'image' as const};
const stream=(chunks:Uint8Array[])=>new ReadableStream<Uint8Array>({start(c){for(const x of chunks)c.enqueue(x);c.close();}});
test('bounded opaque references reject paths, HEIF, UTF8 filename overflow and count/aggregate excess',()=>{
 expect(attachmentReferenceSchema.safeParse({...ref,path:'/tmp/a'}).success).toBe(false);
 for(const filename of ['../a','a\\b','a\0b','é'.repeat(101)])expect(attachmentReferenceSchema.safeParse({...ref,filename}).success).toBe(false);
 expect(attachmentReferenceSchema.safeParse({...ref,declaredMimeType:'image/heif'}).success).toBe(false);
 expect(attachmentReferenceSchema.safeParse({...ref,sizeBytes:LIMITS.imageBytes+1}).success).toBe(false);
 expect(attachmentReferencesSchema.safeParse(Array(6).fill(ref)).success).toBe(false);
 expect(attachmentReferencesSchema.safeParse([1,2,3].map(n=>({...ref,uploadId:`u${n}`,presentationKind:'file',sizeBytes:LIMITS.fileBytes}))).success).toBe(false);
});
test('existing text, connection instructions, default AUTO and receipt SDL remain compatible',()=>{
 expect(directSendInputSchema.parse({message:'Hello'})).toEqual({message:'Hello',mode:'AUTO'});
 expect(connectionPath('a b')).toBe('/api/v1/plugins/agent-connect/http/connection?token=a%20b');
 expect(connectionInstructions('Fox','https://bb/')).toBe('<thread-connect acting-as=Fox>GET https://bb/ for usage documentation.</thread-connect>');
 expect(CONNECTION_GRAPHQL_TYPES).toContain('acceptanceStatus: AcceptanceStatus!');
});
test('received counts bounded before buffering; reserve/release on success, truncation, oversize and hook failure',async()=>{
 for(const chunks of [[new Uint8Array(3)],[new Uint8Array(2)],[new Uint8Array(2),new Uint8Array(2)]]){
 let reserves=0,releases=0;const task=readUploadBody(stream(chunks),request,{budget:{async reserve(n){expect(n).toBe(3);reserves++;return()=>{releases++;};}}});
 if(chunks.length===1&&chunks[0]!.length===3)expect((await task).length).toBe(3);else await expect(task).rejects.toThrow();
 expect([reserves,releases]).toEqual([1,1]);
 }
 let released=0;await expect(readUploadBody(stream([new Uint8Array(3)]),request,{budget:{async reserve(){return()=>{released++;};}},onBytes(){throw Error('quota');}})).rejects.toThrow('quota');expect(released).toBe(1);
});
test('abort cancels blocked read and releases budget exactly once',async()=>{
 let released=0,cancelled=0;const controller=new AbortController();
 const task=readUploadBody(new ReadableStream({cancel(){cancelled++;}}),request,{signal:controller.signal,budget:{async reserve(){return()=>{released++;};}}});
 await Promise.resolve();controller.abort();await expect(task).rejects.toThrow();expect(released).toBe(1);expect(cancelled).toBe(1);
});
test('headers encode Unicode and operation key binds metadata; client does one raw-body POST',async()=>{
 expect(uploadRequestFromHeaders(uploadRequestHeaders(request))).toEqual(request);
 expect(uploadIdentity(request)).not.toBe(uploadIdentity({...request,filename:'b.png'}));
 let calls=0;const fetcher:typeof fetch=async(_url,init)=>{calls++;expect(init?.method).toBe('POST');expect(new Uint8Array(await (init?.body as Blob).arrayBuffer())).toEqual(new Uint8Array([1,2,3]));return Response.json({protocol:'bb-agent-connection-upload',version:1,operationId:request.operationId,attachment:ref});};
 expect(await uploadAttachment({endpoint:'https://example/upload',request,bytes:new Uint8Array([1,2,3]),fetch:fetcher})).toEqual(ref);expect(calls).toBe(1);
 calls=0;await expect(uploadAttachment({endpoint:'https://example/upload',request,bytes:new Uint8Array(3),fetch:async()=>{calls++;throw Error('lost response');}})).rejects.toThrow();expect(calls).toBe(1);
 await expect(uploadAttachment({endpoint:'https://example/upload',request,bytes:new Uint8Array(3),fetch:async()=>Response.json({code:'UPLOAD_CONFLICT',message:'changed key'},{status:409})})).rejects.toMatchObject({code:'UPLOAD_CONFLICT',status:409});
 await expect(uploadAttachment({endpoint:'https://example/upload',request,bytes:new Uint8Array(3),fetch:async()=>Response.json({protocol:'bb-agent-connection-upload',version:1,operationId:'other',attachment:ref})})).rejects.toThrow('identity');
});
test('real SDK descriptor projection preserves source hint and rejects corrupt persisted descriptors',async()=>{
 const descriptor={type:'localImage' as const,path:'attachments/image.png',name:'image.png',sizeBytes:3,mimeType:'image/png',sourceProjectId:'P'};
 expect(nativeAttachmentInput(descriptor)).toEqual({type:'localImage',path:descriptor.path,sourceProjectId:'P'});
 expect(await resolveAttachmentInputs([ref],async()=>descriptor)).toEqual([nativeAttachmentInput(descriptor)]);
 for(const bad of [{...descriptor,path:'../x'},{...descriptor,type:'file'},{...descriptor,unexpected:true},{...descriptor,path:'/absolute'}])expect(nativeAttachmentDescriptorSchema.safeParse(bad).success).toBe(false);
 await expect(resolveAttachmentInputs([ref],async()=>({...descriptor,sizeBytes:4}))).rejects.toThrow('metadata');
});
test('fetch AbortSignal reaches injected transport; oversized response fails before JSON decode',async()=>{
 const controller=new AbortController();let received:AbortSignal|undefined;
 const task=uploadAttachment({endpoint:'https://example/upload',request,bytes:new Uint8Array(3),signal:controller.signal,fetch:async(_url,init)=>{received=init?.signal??undefined;return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});});}});
 controller.abort(new Error('cancelled'));await expect(task).rejects.toThrow('cancelled');expect(received).toBe(controller.signal);
 await expect(uploadAttachment({endpoint:'https://example/upload',request,bytes:new Uint8Array(3),fetch:async()=>new Response('x'.repeat(LIMITS.responseBytes+1))})).rejects.toMatchObject({code:'UPLOAD_TOO_LARGE'});
});
test('ZIP/video descriptors retain file metadata and original project',async()=>{
 for(const [filename,mimeType] of [['archive.zip','application/zip'],['clip.mp4','video/mp4']]){
  const descriptor={type:'localFile' as const,path:`files/${filename}`,name:filename!,sizeBytes:3,mimeType:mimeType!,sourceProjectId:'original-project'};
  const reference={...ref,filename:filename!,declaredMimeType:mimeType!,presentationKind:'file' as const};
  expect(await resolveAttachmentInputs([reference],async()=>descriptor)).toEqual([{type:'localFile',path:descriptor.path,name:filename,sizeBytes:3,mimeType,sourceProjectId:'original-project'}]);
 }
});
test('MIME kind consistency and native image bound reject before projection',()=>{
 const uploadSchema=uploadRequestSchema;
 for(const bad of [{...request,presentationKind:'file'},{...request,presentationKind:'file',sizeBytes:LIMITS.imageBytes+1},{...request,declaredMimeType:'application/zip'}])expect(uploadSchema.safeParse(bad).success).toBe(false);
 for(const bad of [{...ref,presentationKind:'file'},{...ref,presentationKind:'file',sizeBytes:LIMITS.imageBytes+1},{...ref,declaredMimeType:'application/zip'}])expect(attachmentReferenceSchema.safeParse(bad).success).toBe(false);
 const descriptor={type:'localImage' as const,path:'attachments/a.png',name:'a.png',sizeBytes:LIMITS.imageBytes+1,mimeType:'image/png'};
 expect(nativeAttachmentDescriptorSchema.safeParse(descriptor).success).toBe(false);expect(()=>nativeAttachmentInput(descriptor)).toThrow();
 expect(()=>nativeAttachmentInput({...descriptor,type:'localFile',sizeBytes:3})).toThrow();
});
test('direct send preserves 32000 UTF16 character limit and whitespace rejection; permits explicit attachment-only input',()=>{
 expect(directSendInputSchema.safeParse({message:'a'.repeat(32000)}).success).toBe(true);
 expect(directSendInputSchema.safeParse({message:'a'.repeat(32001)}).success).toBe(false);
 expect(directSendInputSchema.safeParse({message:'😀'.repeat(16000)}).success).toBe(true);
 expect(directSendInputSchema.safeParse({message:'😀'.repeat(16001)}).success).toBe(false);
 for(const message of ['', '  \n\t']){expect(directSendInputSchema.safeParse({message}).success).toBe(false);expect(directSendInputSchema.safeParse({message,attachments:[]}).success).toBe(false);expect(directSendInputSchema.safeParse({message,attachments:[ref]}).success).toBe(true);}
});
test('conformance rejects schema-valid digest that differs from actual fixture bytes',async()=>{
 await expect(runUploadConformance({upload:async()=>ref,isConflict:()=>false},{request,bytes:new Uint8Array([1,2,3])})).rejects.toThrow('digest differs');
});
