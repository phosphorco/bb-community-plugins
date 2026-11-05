/** Bounded primary Brief evidence admission/decoding. No source reads or recognition. */
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalJson } from '@phosphorco/bb-context-recognition';
import {
 crossReferencesProducerRpcSchemas, PRODUCER_METHODS, briefApplyLimitCodes, BriefAdmissionError,
 validateBriefCommand, normalizeProjectionCommand, briefEvidenceSchema, briefEvidenceDigest, assertBriefDisplaySafe,
 briefSourcePresentationSchema, briefTargetDescriptorSchema, briefPresentation, verifiedFileIdentity,
 type BriefEvidenceV1, type ProducerApplyInput,
} from '@phosphorco/bb-cross-references';
export function admitBriefApply(input:ProducerApplyInput){
 const limits=briefApplyLimitCodes(input);if(limits.length)throw new BriefAdmissionError('over-limit',limits);
 try{
  const parsed=crossReferencesProducerRpcSchemas[PRODUCER_METHODS.apply].input.parse(input);
  const evidence=validateBriefCommand(parsed.projection,parsed.evidence,parsed.evidenceDigest);
  const command=normalizeProjectionCommand(parsed.projection);
  const metadata=canonicalJson({sourcePresentation:evidence.sourcePresentation,targetDescriptors:evidence.targetDescriptors,metadataPolicyVersion:evidence.metadataPolicyVersion,completeness:evidence.completeness});
  for(const o of evidence.occurrences){if(Buffer.byteLength(canonicalJson(o.locator))>4096||Buffer.byteLength(canonicalJson(o.provenance))>65536)throw new BriefAdmissionError('over-limit',['envelope-bytes']);}
  return {command,evidence,evidenceDigest:parsed.evidenceDigest,metadata};
 }catch(e){if(e instanceof BriefAdmissionError)throw e;throw new BriefAdmissionError('invalid');}
}
export interface BriefStreamRow {
 producer_plugin_id:string;source_resource_id:number;graph_revision:number;graph_payload_digest:string;evidence_digest:string;
 source_file_json:string;source_state:string;raw_sha:string|null;frame_json:string|null;metadata_json:string;occurrence_count:number;accepted_at:number;
}
interface BriefOccurrenceRow {occurrence_key:string;source_occurrence_id:string;locator_json:string;provenance_json:string;authored_url_json:string;target_provider:string;target_keys:string}
const metadataSchema=z.strictObject({sourcePresentation:briefSourcePresentationSchema,targetDescriptors:z.array(briefTargetDescriptorSchema).max(256),metadataPolicyVersion:z.literal(1),completeness:z.strictObject({state:z.literal('complete'),codecVersion:z.literal(1)})});
/** Strict persisted validation of the admitted snapshot; this does not reread source bytes. */
export function readBriefSnapshot(db:Database.Database,producer:string,sourceId:number):{row:BriefStreamRow;evidence:BriefEvidenceV1}|null {
 const row=db.prepare('SELECT * FROM brief_evidence_streams WHERE producer_plugin_id=? AND source_resource_id=?').get(producer,sourceId) as BriefStreamRow|undefined;if(!row)return null;
 const metadata=metadataSchema.parse(JSON.parse(row.metadata_json));
 const rows=db.prepare(`SELECT b.*,r.provider target_provider,r.canonical_keys_json target_keys FROM brief_evidence_occurrences b JOIN resources r ON r.id=b.target_resource_id WHERE b.producer_plugin_id=? AND b.source_resource_id=? ORDER BY b.occurrence_key LIMIT 513`).all(producer,sourceId) as BriefOccurrenceRow[];
 if(rows.length!==row.occurrence_count||rows.length>512||!Number.isSafeInteger(row.graph_revision)||row.graph_revision<1)throw new Error('Invalid stored Brief snapshot.');
 const evidence=briefEvidenceSchema.parse({...metadata,kind:'thread-brief',sourceFile:JSON.parse(row.source_file_json),sourceState:row.source_state,sourceContentRevision:row.raw_sha,frame:row.frame_json===null?null:JSON.parse(row.frame_json),
  occurrences:rows.map(o=>({occurrenceKey:o.occurrence_key,sourceOccurrenceId:o.source_occurrence_id,target:{provider:o.target_provider,keys:JSON.parse(o.target_keys)},locator:JSON.parse(o.locator_json),provenance:JSON.parse(o.provenance_json),authoredUrl:JSON.parse(o.authored_url_json)}))});
 assertBriefDisplaySafe(evidence);if(briefEvidenceDigest(evidence)!==row.evidence_digest)throw new Error('Stored Brief evidence digest mismatch.');
 // Revalidate the original admitted binding/codec/ranges, without fetching source
 // bytes or comparing against an intervening ordinary V1 replacement.
 admitBriefApply({version:1,evidence,evidenceDigest:row.evidence_digest,projection:{protocolVersion:1,producerPluginId:'thread-brief',source:{...verifiedFileIdentity(evidence.sourceFile),presentation:briefPresentation(evidence.sourcePresentation)},revision:row.graph_revision,expectedRevision:0,mutationId:'00000000-0000-4000-8000-000000000000',payloadDigest:row.graph_payload_digest,tombstone:evidence.sourceState!=='present',targets:evidence.targetDescriptors.map(d=>({...d.target,presentation:briefPresentation(d.presentation)}))}});
 return {row,evidence};
}
