import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
export default experimental_defineHostEntry({ contract: {}, handlers: {} });
export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine(line) {
    const request = JSON.parse(line);
    if (request.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message:
              "Inert queue proof: execution is intentionally unavailable.",
          },
        }) + "\n",
      );
  },
});
