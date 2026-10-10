import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const source = z.enum(["official", "mirror"]);
const object = z.record(z.string(), z.unknown());
const tool = z.object({ name: z.string(), description: z.string().optional(), inputSchema: object, annotations: object.optional() }).passthrough();
const connection = z.object({
  phase: z.enum(["unconfigured", "disconnected", "connecting", "authorizing", "connected", "error"]),
  detail: z.string().nullable(), connectedAt: z.number().nullable(), serverVersion: z.string().nullable(),
});
export const snapshotSchema = z.object({
  scope: z.literal("shared"),
  config: z.object({ binaryPath: z.string(), mirrorEnabled: z.boolean(), binaryAvailable: z.boolean(), tokenConfigured: z.boolean(), clientId: z.string(), clientSecretConfigured: z.boolean(), redirectUri: z.string() }),
  official: connection, mirror: connection,
  tools: z.object({ official: z.array(tool), mirror: z.array(tool) }), aliasesNeedReload: z.boolean(),
});
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: snapshotSchema },
  configure: {
    input: z.object({
      binaryPath: z.string().min(1).max(4096).optional(),
      mirrorEnabled: z.boolean().optional(),
      readToken: z.string().max(16384).optional(),
      clientId: z.string().max(4096).optional(),
      clientSecret: z.string().max(16384).optional(),
      redirectUri: z.string().max(8192).optional(),
    }).strict(), output: snapshotSchema,
  },
  connectOfficial: { input: z.null(), output: z.object({ authorizationUrl: z.string() }) },
  finishAuthorization: { input: z.object({ callbackUrl: z.string().min(1).max(65536) }).strict(), output: snapshotSchema },
  disconnect: { input: z.object({ source }).strict(), output: snapshotSchema },
  testConnection: { input: z.object({ source, file: z.string().optional() }).strict(), output: snapshotSchema },
  refreshTools: { input: z.object({ source }).strict(), output: snapshotSchema },
  syncMirror: { input: z.object({ file: z.string().min(1), acceptUnverified: z.boolean().default(false) }).strict(), output: object },
});
