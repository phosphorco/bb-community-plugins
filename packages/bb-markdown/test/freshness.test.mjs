import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {checkLibrary} from '../tools/check-library.mjs';
test('freshness builds only in memory and leaves canonical emission metadata unchanged',async()=>{
 let calls=0;
 const outputs=await checkLibrary({build(options){calls++;expect('outdir' in options).toBe(false);expect('write' in options).toBe(false);return Bun.build(options);}});
 expect(calls).toBe(5);expect(outputs).toHaveLength(5);
});
test('exact freshness checker rejects stale installed bytes without writing a repair',async()=>{
 let hit=0;
 await expect(checkLibrary({read:async(path,...rest)=>{if(String(path).endsWith('/index.js')){hit++;return Buffer.from('stale emission');}return readFile(path,...rest);}})).rejects.toThrow('Stale installed emission: index.js');
 expect(hit).toBe(1);
});
test('exact freshness checker rejects missing installed emission without regeneration',async()=>{
 let hit=0;
 await expect(checkLibrary({read:async(path,...rest)=>{if(String(path).endsWith('/index.js')){hit++;throw Object.assign(Error('missing installed emission'),{code:'ENOENT'});}return readFile(path,...rest);}})).rejects.toThrow('missing installed emission');
 expect(hit).toBe(1);
});
