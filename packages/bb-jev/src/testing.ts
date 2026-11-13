import {canonical,decodeRecord,fingerprint,type Submit,type OperationRecord} from './protocol.js';
export interface ConformancePort {submit(input:Submit):Promise<OperationRecord>;lookup(operation:Submit['operation']):Promise<OperationRecord|null>}
/** Real adopter callers supply an inert transport. The kit makes no inference itself. */
export async function runJevConformance(port:ConformancePort,input:Submit):Promise<{cases:string[]}>{
  const initial=await decodeRecord(input,await port.submit(input));
  if(!initial||initial.requestFingerprint!==await fingerprint(input))throw Error('Submitted operation not anchored');
  const anchor=(record:OperationRecord)=>canonical({operation:{namespace:record.operation.namespace,operationId:record.operation.operationId},requestFingerprint:record.requestFingerprint,work:{consumerPluginId:record.work.consumerPluginId,kind:record.work.kind,attribution:record.work.attribution},createdAt:record.createdAt,source:{ownerPluginId:record.source.ownerPluginId,kind:record.source.kind,field:record.source.field}});
  const frozen=anchor(initial);
  const replay=await decodeRecord(input,await port.submit(input));
  if(!replay||anchor(replay)!==frozen)throw Error('Same operation replay drifted');
  const lookup=await decodeRecord(input,await port.lookup(input.operation));
  if(!lookup||anchor(lookup)!==frozen)throw Error('Operation lookup drifted');
  let conflict=false;
  try{await port.submit({...input,work:{...input.work,kind:input.work.kind+'-changed'}});}catch{conflict=true;}
  if(!conflict)throw Error('Changed immutable request did not conflict');
  return {cases:['request-anchored','immutable-replay','exact-lookup','changed-request-conflict']};
}
