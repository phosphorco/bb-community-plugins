import { parseDocument } from "yaml";
import type { Connection } from "../contracts/model.ts";
import type { Transport } from "./evaluator.ts";
export class TransportError extends Error {
  constructor(
    message: string,
    readonly invoked: boolean,
    readonly observation: unknown = null,
  ) {
    super(message);
  }
}
function maskCredential(text:string,key:string):string {
  const replacement="[Message Rules credential]";
  return text.replace(/"(?:[^"\\]|\\.)*"/g,token=>{try{const decoded:unknown=JSON.parse(token);return typeof decoded==='string'&&decoded.includes(key)?JSON.stringify(decoded.replaceAll(key,replacement)):token;}catch{return token;}}).replaceAll(key,replacement);
}
export function createHttpTransport(
  config: Connection,
  credential: () => Promise<string | null>,
  fetcher: typeof fetch = fetch,
): Transport {
  return async (wire, signal) => {
    const key = await credential();
    if (!key)
      throw new TransportError(
        "JEV connection is not configured. Add a Message Rules API key in settings.",
        false,
      );
    if (signal.aborted)
      throw new TransportError("Cancelled before HTTP invocation.", false);
    const body = JSON.stringify(wire);
    if (Buffer.byteLength(body) > config.maxWireBytes)
      throw new TransportError(
        "Request exceeds configured wire budget.",
        false,
      );
    const timer = AbortSignal.timeout(config.timeoutMs),
      combined = AbortSignal.any([signal, timer]);
    let invoked = false;
    try {
      invoked = true;
      const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body,
        signal: combined,
      });
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      if (!reader) throw Error("Empty JEV response.");
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > config.maxResponseBytes) {
            await reader.cancel();
            throw Error("Response exceeds configured budget.");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const raw = maskCredential(Buffer.concat(chunks).toString("utf8"),key);
      if (!response.ok)
        throw new TransportError(
          "JEV HTTP " +
            response.status +
            ": " +
            raw.replaceAll(key, "[Message Rules credential]"),
          true,
          {
            status: response.status,
            body: raw.replaceAll(key, "[Message Rules credential]"),
          },
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new TransportError("Invalid JSON response: " + String(e), true, {
          status: response.status,
          body: raw.replaceAll(key, "[Message Rules credential]"),
        });
      }
      const unique = parseDocument(raw, { uniqueKeys: true });
      if (unique.errors.length)
        throw new TransportError("Duplicate JSON response keys.", true, {
          status: response.status,
          body: raw.replaceAll(key, "[Message Rules credential]"),
        });
      return parsed;
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new TransportError(
        (e instanceof Error ? e.message : String(e)).replaceAll(
          key,
          "[Message Rules credential]",
        ),
        invoked,
      );
    }
  };
}
