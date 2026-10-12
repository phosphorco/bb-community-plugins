import { cliCommand, defineCli, PluginCliError } from "@get-bb/plugin-sdk";
import type { PluginAgentToolResult, PluginCliContext } from "@get-bb/plugin-sdk";
import type { Bridge, BridgeOperation } from "./bridge.ts";

function argumentsObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new PluginCliError("Arguments must be a JSON object. Use --arguments-stdin to send JSON from a file or pipe.", { code: "invalid_value" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PluginCliError("Arguments must be a JSON object.", { code: "invalid_value" });
  return parsed as Record<string, unknown>;
}

export function createSentryCli(bridge: Pick<Bridge, "invoke">) {
  const shared = {
    source: { type: "enum", values: ["official"], default: "official", description: "Use official Sentry MCP." },
    json: { type: "boolean", description: "Return the same JSON content envelope as the native agent tool." },
  } as const;
  const argumentsOption = { type: "string", default: "{}", stdin: true, description: "Upstream arguments as JSON; use --arguments-stdin for a file or pipe." } as const;
  async function invoke(operation: BridgeOperation, input: unknown, ctx: PluginCliContext) {
    let result: PluginAgentToolResult;
    try { result = await bridge.invoke(operation, input, ctx.signal); }
    catch (error) {
      // Transport errors are sanitized by the shared bridge/manager. Do not retry.
      const message = error instanceof Error ? error.message : "Sentry request failed.";
      return { exitCode: 1, stdout: `${JSON.stringify({ content: [{ type: "text", text: message }], isError: true })}\n` };
    }
    return { exitCode: typeof result !== "string" && result.isError ? 1 : 0, stdout: `${JSON.stringify(result)}\n` };
  }
  return defineCli({
    name: "sentry", summary: "Use this BB deployment's shared Sentry MCP connection.",
    description: "Runs on the BB server from any enrolled machine. Sign in through BB's Sentry settings; no local Sentry/Codex executable or token is required. Results preserve the native tool content envelope. Writes are never retried.",
    commands: {
      discover: cliCommand({
        summary: "Discover current Sentry tools, exact schemas and capabilities.", options: shared,
        run: ({ options }, ctx) => invoke("sentry_discover", { source: options.source }, ctx),
      }),
      call: cliCommand({
        summary: "Call an upstream tool using its discovered name and schema.",
        options: { ...shared, arguments: argumentsOption },
        positionals: [{ name: "tool", required: true, description: "Original upstream name, such as whoami or search_issues." }],
        run: ({ options, positionals }, ctx) => invoke("sentry_call", { source: options.source, name: positionals.tool, arguments: argumentsObject(options.arguments) }, ctx),
      }),
      mcp: cliCommand({
        summary: "Request advertised MCP resources, prompts or other operations.",
        options: { ...shared, arguments: argumentsOption },
        positionals: [{ name: "method", required: true, description: "Original MCP method, such as resources/read." }],
        run: ({ options, positionals }, ctx) => invoke("sentry_mcp", { source: options.source, method: positionals.method, params: argumentsObject(options.arguments) }, ctx),
      }),

    },
  });
}
