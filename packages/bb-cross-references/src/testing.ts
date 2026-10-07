import { canonicalizeIdentity, normalizeProjectionCommand, resourceIdentityOf, type ApplyProjectionInput } from "./index.js";
import { createCrossReferencesClient, type CrossReferencesSdk } from "./bb.js";

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
