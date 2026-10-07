import { defineRpcContract } from "@get-bb/plugin-sdk";
import { crossReferencesRpcSchemas } from "@phosphorco/bb-cross-references";
export * from "@phosphorco/bb-cross-references";
export const rpcContract = defineRpcContract(crossReferencesRpcSchemas);
