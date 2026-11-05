import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CLIENT_FACT_LIMITS, ClientFactReadError, parseConfiguredClientFactSource,
  readClientFactBatch,
} from "./client-fact-source.ts";

export const CLIENT_FACT_READ_PATH = "/client-facts/v1/read";
export const CLIENT_FACT_REQUEST_BYTES = 8 * 1024;
type ErrorCode = "source_unconfigured" | "source_unavailable" | "read_busy"
  | "request_too_large" | "unsupported_media_type" | "invalid_json"
  | ClientFactReadError["code"] | "deadline_exceeded";
class HttpFailure extends Error {
  readonly code: ErrorCode; readonly status: number;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
  } });
}
function active(signal: AbortSignal): void {
  if (signal.aborted) throw new ClientFactReadError("cancelled", "Client-fact request was cancelled.");
}
async function boundedJson(request: Request, signal: AbortSignal): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new HttpFailure(415, "unsupported_media_type", "Send an application/json client-fact request.");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > CLIENT_FACT_REQUEST_BYTES)) throw new HttpFailure(413, "request_too_large", "Client-fact request exceeds the 8 KiB input limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpFailure(400, "invalid_json", "Client-fact request requires a JSON body.");
  const chunks: Uint8Array[] = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    active(signal);
    for (;;) {
      const part = await reader.read(); active(signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > CLIENT_FACT_REQUEST_BYTES) {
        await reader.cancel();
        throw new HttpFailure(413, "request_too_large", "Client-fact request exceeds the 8 KiB input limit.");
      }
      chunks.push(part.value);
    }
    const body = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { throw new HttpFailure(400, "invalid_json", "Client-fact request is not valid UTF-8 JSON."); }
  } finally {
    signal.removeEventListener("abort", cancel); reader.releaseLock();
  }
}

/** Fixed protected source operation; Manager is its only collection scheduler. */
export function registerClientFactHttp(bb: Pick<BbPluginApi, "settings" | "http" | "sdk" | "log">): void {
  const settings = bb.settings.define({
    sourceNamespace: { type: "string", label: "Client-fact source namespace",
      description: "Explicit identity of this BB installation. Required before Manager can collect client lineage facts." },
    sourceEpoch: { type: "string", label: "Client-fact source epoch",
      description: "Explicit event-history generation. Change it after a restore or replacement that may invalidate collected event cursors." },
  });
  let outstanding = false;
  bb.http.route("POST", CLIENT_FACT_READ_PATH, async context => {
    if (outstanding) return json({ version: 1, error: { code: "read_busy", message: "A client-fact source read is still outstanding. Manager must retry after that read settles." } }, 429);
    outstanding = true;
    // This is a request deadline, never a collection/refresh timer. Do not race
    // the awaited SDK promise: ignored cancellation must keep this slot held.
    const deadline = AbortSignal.timeout(CLIENT_FACT_LIMITS.elapsedMs);
    const signal = AbortSignal.any([context.req.raw.signal, deadline]);
    try {
      active(signal);
      const values = await settings.get(); active(signal);
      let source;
      try {
        if (typeof values.sourceNamespace !== "string" || !values.sourceNamespace.trim() || typeof values.sourceEpoch !== "string" || !values.sourceEpoch.trim()) throw new Error("Missing source identity.");
        source = parseConfiguredClientFactSource({ namespace: values.sourceNamespace, epoch: values.sourceEpoch });
      } catch {
        throw new HttpFailure(503, "source_unconfigured", "Configure Analytics sourceNamespace and sourceEpoch before collecting client facts. No installation identity is inferred.");
      }
      const input = await boundedJson(context.req.raw, signal);
      const batch = await readClientFactBatch(bb.sdk, input, { source, signal });
      active(signal); return json(batch);
    } catch (error) {
      if (deadline.aborted) return json({ version: 1, error: { code: "deadline_exceeded", message: "Client-fact source read exceeded its two-second deadline. No batch or cursor was published." } }, 504);
      if (signal.aborted) return json({ version: 1, error: { code: "cancelled", message: "Client-fact source read was cancelled. No batch or cursor was published." } }, 499);
      if (error instanceof HttpFailure) return json({ version: 1, error: { code: error.code, message: error.message } }, error.status);
      if (error instanceof ClientFactReadError) {
        const status = { invalid_request: 400, invalid_source: 502, source_conflict: 409, read_budget: 503, cancelled: 499 }[error.code];
        return json({ version: 1, error: { code: error.code, message: error.message } }, status);
      }
      bb.log.error(`Client-fact source read failed: ${error instanceof Error ? error.message : String(error)}`);
      return json({ version: 1, error: { code: "source_unavailable", message: "The configured client-fact source could not be read. No batch or cursor was published. The Analytics server log contains the source error." } }, 502);
    } finally { outstanding = false; }
  }, { auth: "token" });
}
