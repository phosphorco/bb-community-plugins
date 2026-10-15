import {test,expect} from 'bun:test';
import {JSDOM} from 'jsdom';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {ConnectionDetails,AttachmentList} from '../dist/react.js';
(globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
test('rendered explicit clipboard: errors recover, stale owner/value completion and teardown suppressed',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://bb.example'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document});
 const container=document.getElementById('root')!;const root=createRoot(container);
 let pending:()=>void=()=>{};let fail=true;const copied:string[]=[];
 const clipboard={async writeText(text:string){copied.push(text);if(fail)throw Error('Clipboard denied');await new Promise<void>(resolve=>{pending=resolve;});}};
 const render=async(ownerKey='A',url='https://a')=>{await act(async()=>root.render(createElement(ConnectionDetails,{ownerKey,url,instructions:'GET '+url,clipboard})));};
 const click=async(index=0)=>{await act(async()=>{container.querySelectorAll('button')[index]!.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));});};
 await render();await click();expect(container.textContent).toContain('Clipboard denied');fail=false;
 await click();await act(async()=>pending());expect(container.textContent).toContain('URL copied.');expect(container.textContent).not.toContain('Clipboard denied');
 await click(1);await render('B','https://b');await act(async()=>pending());expect(container.textContent).not.toContain('Instructions copied.');expect(copied.at(-1)).toBe('GET https://a');
 const input=container.querySelector('input')!;expect(input.readOnly).toBe(true);expect(input.getAttribute('aria-label')).toBe('Agent connection URL');
 await click();await act(async()=>root.unmount());await act(async()=>pending());expect(container.textContent).toBe('');dom.window.close();
});
test('typed attachment list renders owner supplied preview and rejects data URI preview',async()=>{
 const dom=new JSDOM('<div id="root"></div>');Object.assign(globalThis,{window:dom.window,document:dom.window.document});
 const container=document.getElementById('root')!;const root=createRoot(container);
 const attachment={uploadId:'u1',filename:'capture.png',declaredMimeType:'image/png',sizeBytes:3,sha256:'a'.repeat(64),presentationKind:'image' as const};
 await act(async()=>root.render(createElement(AttachmentList,{attachments:[attachment],previewUrls:{u1:'https://example/owned-preview'}})));
 expect(container.querySelector('img')?.alt).toBe('capture.png');expect(container.querySelector('ul')?.getAttribute('aria-label')).toBe('Attachments');
 await act(async()=>root.render(createElement(AttachmentList,{attachments:[attachment],previewUrls:{u1:'data:image/png;base64,AAAA'}})));
 expect(container.querySelector('img')).toBeNull();expect(container.textContent).toContain('capture.png');await act(async()=>root.unmount());dom.window.close();
});
