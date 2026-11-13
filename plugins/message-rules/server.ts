import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createMessageRules } from "./ui-suite-server.ts";
export default function messageRules(bb: BbPluginApi) {
  createMessageRules(bb);
}
