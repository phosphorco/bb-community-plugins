import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JsonObject, McpInfo, McpPeer } from "../contract.ts";

const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;
const resultSchema = z.object({}).passthrough();

/** The SDK owns negotiation, request ids, cancellation and protocol handling. */
export async function openStdioPeer(input: {
  binaryPath: string; cwd: string; token: string; intervalSeconds: number;
  timeoutMs: number; signal?: AbortSignal; onFailure: () => void;
}): Promise<McpPeer> {
  const transport = new StdioClientTransport({
    command: input.binaryPath,
    args: ["serve", "--no-upstream", "--interval", String(input.intervalSeconds)],
    cwd: input.cwd,
    env: { ...getDefaultEnvironment(), FIGMA_TOKEN: input.token },
    stderr: "pipe", maxBufferSize: MAX_MESSAGE,
  });
  const client = new Client({ name: "bb-plugin-figma", version: "0.1.0" }, { capabilities: {} });
  let closed = false;
  let stderrBytes = 0;
  let closing: Promise<void> | undefined;
  const terminate = (failure = true): Promise<void> => {
    if (!closed) {
      closed = true;
      if (failure) input.onFailure();
    }
    closing ??= client.close();
    return closing;
  };
  // Drain without retaining or printing upstream diagnostics (may contain credentials).
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR) void terminate();
  });
  client.onclose = () => { void terminate(); };
  client.onerror = () => { void terminate(); };
  try {
    await client.connect(transport, { timeout: input.timeoutMs, signal: input.signal });
    if (closed) throw new Error("Figmog could not initialize.");
  } catch {
    await terminate();
    throw new Error("Figmog could not initialize.");
  }
  const info = (): McpInfo => ({
    capabilities: client.getServerCapabilities() ?? {},
    ...(client.getServerVersion() ? { serverInfo: client.getServerVersion() } : {}),
    ...(client.getInstructions() ? { instructions: client.getInstructions() } : {}),
  });
  return {
    info: () => structuredClone(info()),
    close: () => terminate(false),
    async request(method, params, signal) {
      if (closed) throw new Error("Figmog connection is closed.");
      if (signal?.aborted) throw new Error("Figmog request cancelled.");
      const request = { method, ...(params === undefined ? {} : { params }) };
      if (Buffer.byteLength(JSON.stringify(request)) > 8 * 1024 * 1024) throw new Error("Figmog request exceeds the size limit.");
      try {
        // Passthrough preserves content extensions, structuredContent and metadata.
        return await client.request(request, resultSchema, { signal, timeout: input.timeoutMs }) as JsonObject;
      } catch (error) {
        if (signal?.aborted || (error instanceof McpError && error.code === ErrorCode.RequestTimeout)) {
          // figmog ignores MCP cancellation. Stop the owner so queued work cannot continue.
          await terminate();
          throw new Error(signal?.aborted ? "Figmog request cancelled; process stopped." : "Figmog request timed out; process stopped.");
        }
        if (error instanceof McpError) throw new Error(`Figmog MCP protocol error (${error.code}).`);
        throw new Error("Figmog request failed.");
      }
    },
  };
}
