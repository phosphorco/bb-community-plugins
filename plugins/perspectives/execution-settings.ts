import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { decodeRoleChoice, type RoleDescriptorV1, type ValidationPolicy } from "@phosphorco/bb-provider-settings";
import { readCatalog, registerProviderSettingsOwner, type OwnerRolePort } from "@phosphorco/bb-provider-settings/bb";

export const perspectivesPolicy: ValidationPolicy = {
  match: "id-or-model", routeQualifier: "ignore", candidates: "models+selected-only",
  modelLoadError: "not-checked", tier: "not-validated",
};
export const perspectivesRoles: RoleDescriptorV1[] = [
  { id: "planner", label: "Perspectives planner", description: "Help planner and panel coordinator, including synthesis." },
  { id: "expert", label: "Perspectives expert", description: "Help expert and panel workers." },
].map(role => ({ ...role, choiceKinds: ["inherit", "fields"], cascade: "caller-v1", providerPolicy: "any",
  saveValidation: "invocation", applies: "New runs; existing requests retain their frozen execution and permission tuples.", writable: true }));

/** Only legacy blanks/sentinels become absent. Nonblank configured bytes stay exact. */
export function decodePhase(provider: string, model: string, reasoning: string) {
  const fields = { ...(provider.trim() ? { providerId: provider } : {}), ...(model.trim() ? { model } : {}),
    ...(reasoning !== "inherit" ? { reasoningLevel: reasoning } : {}) };
  return decodeRoleChoice(Object.keys(fields).length ? { kind: "fields", fields } : { kind: "inherit" });
}
type Values = Record<string, string>;
type Settings = { get(): Promise<Values>; experimental_set(values: Record<string, string>): Promise<unknown> };
export function registerPerspectivesSettings(bb: BbPluginApi, settings: Settings) {
  const ports: OwnerRolePort[] = perspectivesRoles.map(descriptor => {
    const prefix = descriptor.id === "planner" ? "planner" : "worker";
    const keys = [`${prefix}Provider`, `${prefix}Model`, `${prefix}Reasoning`];
    return {
      descriptor, policy: perspectivesPolicy,
      async readValues() { const values = await settings.get(); return keys.map(key => values[key]); },
      decode(values) { return { choice: decodePhase(String(values[0]), String(values[1]), String(values[2])), owned: null,
        rule: "Caller execution cascades at invocation. Permission remains feature-owned; a browse/sample route is not caller inheritance." }; },
      async checkSampleRoute(route) {
        try {
          if (route.kind === "host") await bb.sdk.hosts.get({ hostId: route.hostId });
          else await bb.sdk.environments.get({ environmentId: route.environmentId });
          return [];
        } catch { return [{ code: "sample-route-unreadable", message: "The sample host/environment cannot be read. Actual invocation checks the calling thread's environment." }]; }
      },
      catalog: (route, providerId) => readCatalog(bb.sdk, route, providerId),
      async write(next) {
        if (next.kind !== "inherit" && next.kind !== "fields") throw new Error("Perspectives requires inherit or caller fields.");
        const fields = next.kind === "fields" ? next.fields : {};
        await settings.experimental_set({ [keys[0]!]: fields.providerId ?? "", [keys[1]!]: fields.model ?? "", [keys[2]!]: fields.reasoningLevel ?? "inherit" });
      },
    };
  });
  registerProviderSettingsOwner(bb, ports);
}
