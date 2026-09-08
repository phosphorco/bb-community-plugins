import assert from "node:assert/strict";
import test from "node:test";

import { bindBbIdentity } from "@phosphorco/bb-identity/bb";
import { z } from "zod";

test("the packed public binding admits an interactive capture without an ambient author", async () => {
  const registrations: Array<{ handlers: Record<string, (input: unknown) => Promise<unknown>> }> = [];
  const bb = {
    pluginId: "agentation-mentions",
    onDispose() {},
    rpc: {
      register(_contract: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) {
        registrations.push({ handlers });
      },
    },
    realtime: { publish() {} },
    sdk: {
      threads: { async send() { return { ok: true }; } },
      plugins: { async callRpc() { return null; } },
    },
  } as unknown as Parameters<typeof bindBbIdentity>[0];
  const binding = bindBbIdentity(bb);
  assert.equal(binding.ok, true);
  if (!binding.ok) return;

  const contract = {
    capture: { input: z.object({}).strict(), output: z.object({ status: z.string(), name: z.string() }) },
  };
  const registered = binding.value.rpc.register(contract, {
    capture: {
      origin: "interactive-user",
      async handle(_input, invocation) {
        const session = await binding.value.server.session(invocation);
        return session.status === "ready"
          ? { status: session.status, name: session.actor.presentation.displayName }
          : { status: session.status, name: "" };
      },
    },
  });
  assert.equal(registered.ok, true);

  const handler = registrations.at(-1)?.handlers.capture;
  assert.ok(handler);
  assert.deepEqual(await handler({}), { status: "ready", name: "Local user" });
  binding.value.dispose();
});
