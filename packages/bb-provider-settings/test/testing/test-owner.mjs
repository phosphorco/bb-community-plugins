// A test-owned owner plugin for the kit's self-tests. Its factory registers
// the package's real registerProviderSettingsOwner on an SDK fake host; its
// storage is a plain object that survives reload, like persisted settings.
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { decodeRoleChoice, projectSpawnOverride, resolveTuple } from '@phosphorco/bb-provider-settings';
import { readCatalog, registerProviderSettingsOwner } from '@phosphorco/bb-provider-settings/bb';
import { catalogFixture, createFakeCatalog, policies, providerFixture, roleDescriptorFixture, selectionFixture } from '@phosphorco/bb-provider-settings/testing';

const permissive = { '~standard': { version: 1, vendor: 'kit-self-test', validate: value => ({ value }) } };

/**
 * flaw: undefined (conforming), 'write-on-read' (Read migrates storage).
 * descriptor: overrides for the role descriptor.
 */
export function createTestOwner({ pluginId = 'owner-a', roleId = 'expert', descriptor = {}, flaw, catalog = createFakeCatalog(), destination } = {}) {
  const baseline = () => ({ [roleId]: '', instructions: '', unrelated: 'stable' });
  const store = baseline();
  let migrations = 0, externalWrites = 0;
  const role = roleDescriptorFixture({ id: roleId, choiceKinds: ['inherit', 'tuple'], ...descriptor });
  const port = () => ({
    descriptor: role, policy: policies.strictModel,
    async readValues() {
      if (flaw === 'write-on-read') store.unrelated = `migrated-${++migrations}`;
      return [store[roleId], store.instructions];
    },
    decode([raw, instructions]) {
      let parsed;
      try { parsed = raw ? JSON.parse(raw) : { kind: 'inherit' }; } catch { parsed = { kind: 'unparseable' }; }
      return { choice: decodeRoleChoice(parsed), owned: instructions ? { instructions } : null, rule: raw ? 'saved choice' : 'inherits the invocation' };
    },
    preserveOwned([, instructions], next) { return instructions && next.kind === 'inherit' ? [{ code: 'owner-fields-would-be-lost', message: 'instructions would be lost' }] : []; },
    async checkSampleRoute() { return []; },
    catalog: (route, providerId) => readCatalog(catalog.sdk, route, providerId),
    ...(destination ? { destination: async () => destination } : {}),
    async write(next) { store[roleId] = JSON.stringify(next); },
  });
  const factory = bb => registerProviderSettingsOwner(bb, [port()]);
  let host = createFakePluginHost({ pluginId });
  factory(host.bb);
  const owner = {
    pluginId, roleId, role, store, catalog,
    get host() { return host; },
    async reload() { host = await host.harness.lifecycle.reload(factory); return host; },
    async writeExternally() { store[roleId] = JSON.stringify({ kind: 'inherit' }) + ' '.repeat(++externalWrites); },
    subject(extra = {}) {
      return {
        get host() { return host; }, roleId, catalog,
        acceptedChoice: { kind: 'tuple', selection: { ...selectionFixture } },
        rejectedChoice: { kind: 'by-provider', entries: { p: { model: 'exec-model' } } },
        ...(destination ? {} : { sampleRoute: { kind: 'host', hostId: 'h' } }),
        readRaw: () => ({ ...store }), roleKeys: [roleId],
        writeExternally: owner.writeExternally,
        async seedMalformed() { store[roleId] = '{"kind":"tuple"'; },
        async seedProtectedFields() { store.instructions = 'keep these instructions'; },
        sideEffects: () => host.harness.inspection.sdk.calls.length,
        reload: owner.reload,
        async restore() { Object.assign(store, baseline()); },
        ...extra,
      };
    },
    dispose: () => host.harness.lifecycle.dispose(),
  };
  return owner;
}

/**
 * A hand-rolled owner that forwards to a conforming one but ignores the
 * caller's expectedFingerprint: it substitutes the current fingerprint, so a
 * stale Save overwrites an intervening write.
 */
export function createFingerprintIgnoringOwner(options = {}) {
  const inner = createTestOwner(options);
  const outer = createFakePluginHost({ pluginId: inner.pluginId });
  const forward = method => input => inner.host.harness.behavior.callRpc(method, input);
  outer.bb.rpc.register({
    providerSettingsDescribe: { input: permissive, output: permissive },
    providerSettingsV1Read: { input: permissive, output: permissive },
    providerSettingsV1Validate: { input: permissive, output: permissive },
    providerSettingsV1Save: { input: permissive, output: permissive },
  }, {
    providerSettingsDescribe: forward('providerSettingsDescribe'),
    providerSettingsV1Read: forward('providerSettingsV1Read'),
    providerSettingsV1Validate: forward('providerSettingsV1Validate'),
    async providerSettingsV1Save(input) {
      const current = await inner.host.harness.behavior.callRpc('providerSettingsV1Read', { version: 1, role: input.role });
      return inner.host.harness.behavior.callRpc('providerSettingsV1Save', { ...input, expectedFingerprint: current.fingerprint });
    },
  });
  return { ...inner, subject: extra => ({ ...inner.subject(extra), host: outer }), dispose: async () => { await outer.harness.lifecycle.dispose(); await inner.dispose(); } };
}

// Invocation: a trivial plugin dispatch over resolveTuple + projectSpawnOverride.
// Its own permission provenance is part of the native baseline (Amendment R1).
export function spawningPlugin({ leakOnInherit = false } = {}) {
  const baselineArgs = { prompt: 'hello', permissionMode: 'auto', executionInputSources: { permissionMode: 'explicit' } };
  let choice = { kind: 'inherit' }, catalog = catalogFixture();
  const sent = [];
  return {
    baseline: [{ method: 'threads.spawn', args: baselineArgs }],
    async setChoice(next) { choice = next; },
    async invoke() {
      const resolution = resolveTuple(choice, [providerFixture()], catalog, policies.strictModel);
      if (resolution.kind === 'rejected') throw new Error(resolution.issues.map(i => i.message).join('; '));
      const { executionInputSources, ...fields } = projectSpawnOverride(resolution, 'explicit-map');
      const leak = leakOnInherit && resolution.kind === 'no-override' ? { model: 'exec-model' } : {};
      sent.push({ method: 'threads.spawn', args: { ...baselineArgs, ...fields, ...leak, ...(executionInputSources ? { executionInputSources: { ...baselineArgs.executionInputSources, ...executionInputSources } } : {}) } });
    },
    requests: () => sent,
    override: {
      choice: { kind: 'tuple', selection: selectionFixture },
      expected: [{ method: 'threads.spawn', args: { ...baselineArgs, ...selectionFixture, executionInputSources: { permissionMode: 'explicit', providerId: 'explicit', model: 'explicit', reasoningLevel: 'explicit', serviceTier: 'explicit' } } }],
    },
    refusedChoices: [{ kind: 'tuple', selection: { ...selectionFixture, model: 'missing-model' } }, { kind: 'fields', fields: { model: 'exec-model' } }],
    async changeDestination() { catalog = catalogFixture({ models: [] }); },
  };
}
