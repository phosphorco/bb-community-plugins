import { canonicalizeIdentity, normalizeProjectionCommand, resourceIdentityOf, type ApplyProjectionInput } from "./index.js";
import { createCrossReferencesClient, createCrossReferencesV2Client, type CrossReferencesSdk } from "./bb.js";

export interface CrossReferencesConformanceResult {
  level: "source-conformance";
  pluginId: string;
  checks: string[];
}
/** Drive the adopter's actual registered handlers using its SDK transport. */
export async function runCrossReferencesConformance(options: {
  sdk: CrossReferencesSdk;
  pluginId?: string;
  /** Use an isolated fixture source with a fresh revision and at least one target. */
  command: ApplyProjectionInput;
}): Promise<CrossReferencesConformanceResult> {
  const command = normalizeProjectionCommand(options.command);
  if (command.tombstone || command.targets.length === 0) throw new Error("Conformance requires an active projection with targets.");
  const client = createCrossReferencesClient(options.sdk, options.pluginId);
  const checks: string[] = [];
  await client.describe();
  checks.push("describe-or-legacy-v1");
  const applied = await client.applyProjection(options.command);
  if (!["applied", "duplicate", "equal"].includes(applied.outcome) || applied.currentRevision !== command.revision || applied.currentDigest !== command.payloadDigest) {
    throw new Error("applyProjection did not accept the fixture revision and digest.");
  }
  checks.push("apply-acceptance");
  const duplicate = await client.applyProjection(options.command);
  if (duplicate.outcome !== "duplicate" || duplicate.currentRevision !== command.revision || duplicate.currentDigest !== command.payloadDigest) throw new Error("Identical mutation was not an exact duplicate.");
  checks.push("duplicate-acceptance");
  const source = resourceIdentityOf(command.source);
  const { projection } = await client.getProjection({ producerPluginId: command.producerPluginId, source });
  if (projection === null || projection.revision !== command.revision || projection.mutationId !== command.mutationId || projection.payloadDigest !== command.payloadDigest || projection.tombstone || projection.producerPluginId !== command.producerPluginId) {
    throw new Error("getProjection did not preserve the accepted fixture.");
  }
  const readCommand = normalizeProjectionCommand({ ...projection, protocolVersion: 1, expectedRevision: command.expectedRevision });
  if (readCommand.payloadJson !== command.payloadJson) throw new Error("getProjection changed the accepted source, targets or presentation.");
  checks.push("get-acceptance");
  for (const target of command.targets) {
    let cursor: string | undefined;
    let found = false;
    // This test fixture must keep its backlink set small enough for 10 pages.
    for (let page = 0; page < 10; page += 1) {
      const backlinks = await client.listBacklinks({ target: resourceIdentityOf(target), pageSize: 100, ...(cursor === undefined ? {} : { cursor }) });
      found = backlinks.rows.some(row => row.producerPluginId === command.producerPluginId && row.revision === command.revision && canonicalizeIdentity({ provider: row.source.provider, keys: row.source.keys }).canonicalIdentityJson === command.source.canonicalIdentityJson);
      if (found || backlinks.nextCursor === null) break;
      cursor = backlinks.nextCursor;
    }
    if (!found) throw new Error("listBacklinks did not include the accepted source and producer.");
  }
  checks.push("backlinks-acceptance");
  return { level: "source-conformance", pluginId: client.pluginId, checks };
}

/** Read-only V2 conformance through the adopter's real transport/handlers.
 * The caller owns fixture preparation; this kit never enqueues or writes. */
export async function runCrossReferencesV2Conformance(options:{sdk:CrossReferencesSdk;pluginId?:string;
 input:import('./evidence-v2.js').ListMentionsInputV2;lookup:import('./evidence-v2.js').ResolveLookupInputV2;
 assertPage:(page:Extract<import('./evidence-v2.js').ListMentionsOutputV2,{status:'page'}>)=>void|Promise<void>;
}):Promise<CrossReferencesConformanceResult>{
 const client=createCrossReferencesV2Client(options.sdk,options.pluginId);await client.describe();
 const page=await client.listMentions(options.input);if(page.status!=='page')throw new Error('V2 fixture must yield a page.');await options.assertPage(page);
 const {cursor:_cursor,ifSnapshot:_conditional,...base}=options.input;
 const conditional=await client.listMentions({...base,ifSnapshot:page.snapshot});
 if(conditional.status!=='not-modified'||!conditional.coverage.authoredUrlCoverage.watermark)throw new Error('V2 conditional omitted current coverage.');
 const lookup=await client.resolveLookup(options.lookup);if(!['ready','ambiguous','incomplete'].includes(lookup.state)||lookup.options.length===0)throw new Error('V2 lookup fixture did not resolve.');
 return {level:'source-conformance',pluginId:client.pluginId,checks:['describe-v2','actual-evidence-page','conditional-current-coverage','query-normalization']};
}

/** New-family acceptance, through the adopter's ACTUAL registered transport.
 * The caller owns an isolated complete fixture and its revision allocation. */
export async function runCrossReferencesProducerConformance(options:{sdk:CrossReferencesSdk;pluginId?:string;
 command:import('./producer.js').ProducerApplyInput;blocked:import('./producer.js').ProducerReportStatusInput;
 assertState?:(state:import('./producer.js').ProducerState)=>void|Promise<void>;
}):Promise<CrossReferencesConformanceResult>{
 const {createCrossReferencesProducerClient}=await import('./bb.js');
 const client=createCrossReferencesProducerClient(options.sdk,options.pluginId),checks:string[]=[];
 await client.describe();checks.push('producer-describe');
 const accepted=await client.apply(options.command);
 if(!['applied','duplicate','equal'].includes(accepted.outcome)||!['installed','replayed'].includes(accepted.evidenceDisposition)||accepted.state.evidence?.state!=='bound'||accepted.state.evidence.evidenceDigest!==options.command.evidenceDigest)throw new Error('Producer fixture was not atomically bound.');
 checks.push('atomic-graph-evidence');
 const replay=await client.apply(options.command);if(replay.evidenceDisposition!=='replayed'||replay.state.evidence?.evidenceDigest!==options.command.evidenceDigest)throw new Error('Producer evidence replay failed.');checks.push('evidence-replay');
 if(options.blocked.expectedRevision!==options.command.projection.revision||options.blocked.attemptRevision<=options.command.projection.revision)throw new Error('Blocked fixture must allocate above the accepted graph.');
 const blocked=await client.reportStatus(options.blocked);if(!['recorded','duplicate'].includes(blocked.outcome)||blocked.state.projection?.revision!==options.command.projection.revision||blocked.state.revisionHighWater!==options.blocked.attemptRevision)throw new Error('Status changed graph or lost prospective revision.');checks.push('status-retains-last-good');
 const current=await client.getState({version:1,producerPluginId:'thread-brief',source:options.blocked.source});
 if(current.status?.statusDigest!==options.blocked.statusDigest||current.evidence?.evidenceDigest!==options.command.evidenceDigest)throw new Error('GetState lost committed evidence/status.');await options.assertState?.(current);checks.push('producer-readback');
 const oldReplay=await client.apply(options.command);if(oldReplay.evidenceDisposition!=='replayed'||oldReplay.state.status?.attemptRevision!==options.blocked.attemptRevision)throw new Error('An exact replay cleared newer blocked intent.');checks.push('replay-preserves-newer-status');
 return {level:'source-conformance',pluginId:client.pluginId,checks};
}
/** The proof provider must be the actual adopter handler, with its accepted raw
 * reader fixture. This kit never reads/parses a file or constructs a model. */
export async function runBriefNavigationConformance(options:{sdk:CrossReferencesSdk;input:import('./producer.js').BriefNavigationInput;assertResult:(value:import('./producer.js').BriefNavigationOutput)=>void|Promise<void>}):Promise<CrossReferencesConformanceResult>{
 const {createBriefNavigationClient}=await import('./bb.js');const client=createBriefNavigationClient(options.sdk);await client.describe();const result=await client.resolve(options.input);await options.assertResult(result);
 return {level:'source-conformance',pluginId:'thread-brief',checks:['navigation-describe','fixed-file-same-revision-proof']};
}
