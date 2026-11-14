/** Canonical JSON is a fingerprint format, not a signature or authority credential. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue};
export class ContractBoundaryError extends Error {
  readonly code: 'invalid_data' | 'capacity';
  constructor(code:'invalid_data'|'capacity', message:string) { super(message); this.name='ContractBoundaryError'; this.code=code; }
}
export function canonicalJson(value:unknown, maxBytes:number, maxDepth=64):string {
  if (!Number.isSafeInteger(maxBytes)||maxBytes<1) throw new ContractBoundaryError('invalid_data','A positive byte budget is required.');
  const active=new Set<object>();
  let bytes=0;
  const encoder=new TextEncoder();
  function emit(s:string):string { bytes+=encoder.encode(s).byteLength; if(bytes>maxBytes) throw new ContractBoundaryError('capacity',`Canonical JSON exceeds ${maxBytes} UTF-8 bytes.`); return s; }
  function visit(v:unknown,depth:number):string {
    if(depth>maxDepth) throw new ContractBoundaryError('capacity',`JSON exceeds depth ${maxDepth}.`);
    if(v===null||typeof v==='boolean'||typeof v==='string') return emit(JSON.stringify(v));
    if(typeof v==='number'&&Number.isFinite(v)) return emit(JSON.stringify(v));
    if(typeof v!=='object'||v===null) throw new ContractBoundaryError('invalid_data','Expected finite plain JSON.');
    if(active.has(v)) throw new ContractBoundaryError('invalid_data','Cyclic JSON.');
    const array=Array.isArray(v);
    if(!array&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null) throw new ContractBoundaryError('invalid_data','Expected a plain object.');
    if(Object.getOwnPropertySymbols(v).length) throw new ContractBoundaryError('invalid_data','Symbol keys are not JSON.');
    active.add(v);
    const keys=Object.keys(v);
    const descriptors=Object.getOwnPropertyDescriptors(v);
    for(const key of keys) if(!descriptors[key]||!('value' in descriptors[key]!)) throw new ContractBoundaryError('invalid_data','JSON accessors are not allowed.');
    let result:string;
    if(array) {
      if(keys.length!==v.length||keys.some((key,i)=>key!==String(i))) throw new ContractBoundaryError('invalid_data','Sparse or decorated arrays are not JSON.');
      const start=emit('['); const parts=keys.map((key,i)=>(i?emit(','):'')+visit(descriptors[key]!.value,depth+1)); result=start+parts.join('')+emit(']');
    } else {
      const start=emit('{'); const parts=keys.sort().map((key,i)=>(i?emit(','):'')+emit(JSON.stringify(key))+emit(':')+visit(descriptors[key]!.value,depth+1)); result=start+parts.join('')+emit('}');
    }
    active.delete(v); return result;
  }
  return visit(value,0);
}
export async function fingerprint(value:unknown,maxBytes:number):Promise<string> {
  const data=new TextEncoder().encode(canonicalJson(value,maxBytes));
  const hash=await globalThis.crypto.subtle.digest('SHA-256',data);
  return 'sha256:'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
