import { describe, expect, it, vi } from "vitest";
import plugin from "../server";
import { createPluginSurfaceAgentReference, pluginSurfaceAgentContext } from "../src/agent-reference";
import { SURFACES_BY_ID } from "../src/surfaces";

describe("independent mention registration", () => {
  it("registers its own resolver while retaining authored surface IDs", () => {
    const registerMentionProvider = vi.fn();
    plugin({ ui: { registerMentionProvider }, log: { debug: vi.fn() } } as never);
    expect(registerMentionProvider).toHaveBeenCalledOnce();
    const provider = registerMentionProvider.mock.calls[0]![0];
    expect(provider.id).toBe("surface");
    expect(provider.label).toBe("BB Plugin Guide for Nerds");
    expect(provider.search()).toEqual([]);
    for (const surface of SURFACES_BY_ID.values()) {
      const resource = createPluginSurfaceAgentReference(surface).resource;
      expect(resource.pluginId).toBe("plugin-guide-for-nerds");
      expect(resource.itemId).toBe(`surface:${surface.id}`);
      expect(provider.resolve(surface.id)).toEqual({ context: pluginSurfaceAgentContext(surface.id) });
    }
    expect(() => provider.resolve("missing-surface")).toThrow("Unknown Plugin Guide surface");
  });
});
