import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerRecognitionSupplier } from '../dist/bb.js';
import { LIMITS, METHODS, UnknownResultSchema, LinkifyInputV1Schema, ResolveInputV1Schema, nearestSpan } from '../dist/index.js';
import { runSupplierConformance, workedExamples } from '../dist/testing.js';

const claim = { provider: 'fixture', kinds: ['item'], specificity: 'typed' };
const input = { version: 1, text: 'one two', format: 'plain', excluded: [], context: { consumer: { pluginId: 'consumer' }, links: [] } };
const source = { provider: 'fixture', id: 'one', kind: 'item' };
const resolveInput = { version: 1, context: { consumer: { pluginId: 'consumer' } }, sources: [source], detail: 'card' };
const candidate = (text, start = 0, end = 3, extra = {}) => ({ span: { start, end }, match: text.slice(start, end), source, confidence: 'high', provenance: { basis: 'explicit', explanation: 'Test-owned literal rule.' }, ...extra });
const goodLinkify = value => ({ candidates: value.text.startsWith('one') && !value.excluded.some(s => s.start < 3 && s.end > 0) ? [candidate(value.text)] : [] });
const goodResolve = value => ({ resolutions: value.sources.map(source => ({ source, state: 'ready', label: source.id, ...(value.detail === 'card' ? { card: { title: source.id } } : {}), reasons: [] })) });
const options = register => ({ pluginId: 'supplier-test', register, linkifyCases: [{ name: 'literal', input, expected: goodLinkify(input) }], resolveCases: [{ name: 'item', input: resolveInput, expected: goodResolve(resolveInput) }] });
const real = (linkify = goodLinkify, resolve = goodResolve, providers = [claim]) => bb => registerRecognitionSupplier(bb, { revision: 'test/1', linkify: { providers, handler: linkify }, resolve: { providers, handler: resolve } });
function rawRegistration({ describe, linkify = goodLinkify, resolve = goodResolve, strict = true } = {}) {
  return bb => bb.rpc.register({
    [METHODS.describe]: { input: UnknownResultSchema, output: UnknownResultSchema },
    [METHODS.linkify]: { input: strict ? LinkifyInputV1Schema : UnknownResultSchema, output: UnknownResultSchema },
    [METHODS.resolve]: { input: strict ? ResolveInputV1Schema : UnknownResultSchema, output: UnknownResultSchema },
  }, {
    [METHODS.describe]: () => describe ?? { protocol: 'bb-context-recognition', versions: [1], capabilities: { revision: 'raw/1', linkify: { providers: [claim] }, resolve: { providers: [claim] } } },
    [METHODS.linkify]: linkify,
    [METHODS.resolve]: resolve,
  }, { experimental_discoverable: true });
}
const failures = report => report.checks.filter(c => c.state === 'failed');
function expectFailure(report, prefix, pattern) {
  assert.equal(report.passed, false);
  const failed = failures(report).filter(c => c.name.startsWith(prefix));
  assert.ok(failed.length, JSON.stringify(report));
  if (pattern) assert.ok(failed.some(c => pattern.test(c.detail)), JSON.stringify(failed));
}

test('kit uses real registration, owner-bound SDK client, and cleans up lifecycle', async () => {
  let called = 0, disposed = false;
  const report = await runSupplierConformance(options(bb => {
    assert.equal(bb.sdk !== undefined, true);
    bb.onDispose(() => { disposed = true; });
    real(value => { called++; return goodLinkify(value); })(bb);
  }));
  assert.equal(report.proof, 'source-conformance');
  assert.equal(report.passed, true, JSON.stringify(failures(report)));
  assert.ok(called >= 8, 'real handler sees repetitions and context variants');
  assert.equal(disposed, true);
  assert.ok(report.checks.some(c => c.name === 'linkify:no-git-empty-links'));
  assert.ok(report.checks.some(c => c.name === 'resolve:item-label'));
});
test('testing emitted module shares sibling public modules and stays DOM-free', () => {
  const emitted = readFileSync(new URL('../dist/testing.js', import.meta.url), 'utf8');
  assert.match(emitted, /from ["']\.\/bb\.js["']/);
  assert.match(emitted, /from ["']\.\/index\.js["']/);
  assert.doesNotMatch(emitted, /from ["'](?:react|react-dom|jsdom)(?:["'/])/);
  assert.equal(typeof globalThis.document, 'undefined');
});
test('only advertised stages run; policy cases for missing stage fail explicitly', async () => {
  const register = bb => registerRecognitionSupplier(bb, { revision: 'resolve-only', resolve: { providers: [claim], handler: goodResolve } });
  const report = await runSupplierConformance({ pluginId: 'resolve-only', register, resolveCases: [{ input: resolveInput }] });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.checks.find(c => c.name === 'linkify').state, 'skipped');
  expectFailure(await runSupplierConformance({ ...options(register) }), 'linkify-cases-applicable');
});
for (const [name, versions, capabilities] of [
  ['wrong-version', [2], { future: true }], ['empty', [], {}], ['zero', [0], {}], ['noninteger', [1.5], {}], ['seventeen', Array.from({ length: 17 }, (_, i) => i + 1), {}],
  ['too-many-claims', [1], { revision: 'a', linkify: { providers: Array.from({ length: 17 }, (_, i) => ({ provider: `p${i}`, kinds: ['item'] })) } }],
  ['duplicate-claims', [1], { revision: 'a', linkify: { providers: [claim, claim] } }],
  ['too-many-kinds', [1], { revision: 'a', linkify: { providers: [{ provider: 'fixture', kinds: Array.from({ length: 17 }, (_, i) => `k${i}`) }] } }],
]) test(`describe rejects ${name}`, async () => {
  const register = rawRegistration({ describe: { protocol: 'bb-context-recognition', versions, capabilities } });
  expectFailure(await runSupplierConformance(options(register)), 'describe-negotiation');
});
test('negotiates [1,2] and skips decoding incompatible v2 capabilities', async () => {
  const describe = { protocol: 'bb-context-recognition', versions: [1, 2], capabilities: { revision: 'v1-v2', linkify: { providers: [claim] }, resolve: { providers: [claim] } } };
  const report = await runSupplierConformance(options(rawRegistration({ describe })));
  assert.equal(report.passed, true, JSON.stringify(failures(report)));
});
test('reserved claims are supplier conformance failures', async () => {
  expectFailure(await runSupplierConformance(options(real(goodLinkify, goodResolve, [{ ...claim, provider: 'bb.file' }]))), 'describe-claims', /reserved/);
});
test('registered handlers, rather than client input validation, must reject unknown and malformed inputs', async () => {
  const report = await runSupplierConformance(options(rawRegistration({ strict: false })));
  expectFailure(report, 'linkify-strict:unknown-field', /accepted/);
  expectFailure(report, 'resolve-strict:unknown-field', /accepted/);
});
test('generic supplier faults cannot pass strict-input rejection checks', async () => {
  const report = await runSupplierConformance(options(rawRegistration({ strict: false, linkify: () => { throw new Error('Supplier broken'); }, resolve: () => { throw new Error('Supplier broken'); } })));
  expectFailure(report, 'linkify-strict:', /without a validation error/);
  expectFailure(report, 'resolve-strict:', /without a validation error/);
});
for (const [name, linkify] of [
  ['malformed', () => ({ candidates: 'wrong' })],
  ['span', value => ({ candidates: value.text ? [candidate(value.text, 0, 3, { match: 'mismatch' })] : [] })],
  ['excluded', value => ({ candidates: value.text ? [candidate(value.text)] : [] })],
  ['unadvertised', value => ({ candidates: value.text ? [candidate(value.text, 0, 3, { source: { provider: 'other', id: 'x' } })] : [] })],
  ['duplicate-span', value => ({ candidates: value.text ? [candidate(value.text), candidate(value.text)] : [] })],
  ['sorting', value => ({ candidates: value.text.length >= 7 ? [candidate(value.text, 4, 7), candidate(value.text)] : [] })],
  ['inferred-high', value => ({ candidates: value.text ? [candidate(value.text, 0, 3, { provenance: { basis: 'context', explanation: 'Inferred.' } })] : [] })],
  ['no-git', value => { if (!value.context.git) throw new Error('No repository'); return goodLinkify(value); }],
  ['empty-links', value => { if (!value.context.links.length) throw new Error('No links'); return goodLinkify(value); }],
  ['bytes-before-decode', () => ({ candidates: [], ignoredFutureField: '😀'.repeat(LIMITS.responseBytes / 3) })],
  ['failure', () => { throw new Error('Supplier broken'); }],
]) test(`linkify failure: ${name}`, async () => {
  const opts = options(rawRegistration({ linkify }));
  if (name === 'excluded') opts.linkifyCases.push({ name: 'excluded', input: { ...input, excluded: [{ start: 0, end: 3 }] } });
  expectFailure(await runSupplierConformance(opts), 'linkify:');
});
test('repeated raw canonical output detects nondeterminism including unknown fields', async () => {
  let sequence = 0;
  const report = await runSupplierConformance(options(rawRegistration({ linkify: value => ({ ...goodLinkify(value), futureField: sequence++ }) })));
  expectFailure(report, 'linkify:', /Repeated canonical/);
});
for (const [name, resolve] of [
  ['malformed', () => ({ resolutions: null })],
  ['duplicate', value => ({ resolutions: [...goodResolve(value).resolutions, ...goodResolve(value).resolutions] })],
  ['unrequested', value => ({ resolutions: [{ source: { provider: 'fixture', id: 'unrequested' }, state: 'ready', reasons: [] }] })],
  ['wrong-provider-echo', value => ({ resolutions: value.sources.map(s => ({ source: { ...s, provider: 'other' }, state: 'ready', reasons: [] })) })],
  ['label-card', value => ({ resolutions: value.sources.map(source => ({ source, state: 'ready', card: { title: 'item' }, reasons: [] })) })],
  ['non-ready-card', value => ({ resolutions: value.sources.map(source => ({ source, state: 'unavailable', card: { title: 'item' }, reasons: [] })) })],
  ['unknown-state', value => ({ resolutions: value.sources.map(source => ({ source, state: 'cached', reasons: [] })) })],
  ['unknown-reason', value => ({ resolutions: value.sources.map(source => ({ source, state: 'unavailable', reasons: [{ code: 'future-code', summary: 'Future.' }] })) })],
  ['bytes-before-decode', () => ({ resolutions: [], ignoredFutureField: 'x'.repeat(LIMITS.responseBytes) })],
  ['failure', () => { throw new Error('Supplier broken'); }],
]) test(`resolve failure: ${name}`, async () => {
  expectFailure(await runSupplierConformance(options(rawRegistration({ resolve }))), 'resolve:');
});
test('omissions are allowed and per-item timeout reasons pass', async () => {
  for (const resolve of [() => ({ resolutions: [] }), value => ({ resolutions: value.sources.map(source => ({ source, state: 'unavailable', reasons: [{ code: 'timeout', summary: 'Own source read timed out.' }] })) })]) {
    const opts = options(real(goodLinkify, resolve));
    opts.resolveCases = [{ input: resolveInput }];
    const report = await runSupplierConformance(opts);
    assert.equal(report.passed, true, JSON.stringify(failures(report)));
  }
});
test('slow describe terminates under its deadline', async () => {
  const register = bb => bb.rpc.register({ [METHODS.describe]: { input: UnknownResultSchema, output: UnknownResultSchema } }, { [METHODS.describe]: () => new Promise(() => {}) });
  expectFailure(await runSupplierConformance({ pluginId: 'slow-describe', register }), 'describe-negotiation');
});
for (const stage of ['linkify', 'resolve']) test(`slow ${stage} terminates under deadline`, async () => {
  const opts = options(rawRegistration({ [stage]: () => new Promise(() => {}) }));
  // No policy cases: one automatic probe bounds total test duration.
  opts.linkifyCases = []; opts.resolveCases = [];
  expectFailure(await runSupplierConformance(opts), `${stage}:`);
});
test('registration rejection is reported and disposes resources', async () => {
  let disposed = false;
  const report = await runSupplierConformance({ pluginId: 'registration-fails', register(bb) { bb.onDispose(() => { disposed = true; }); throw new Error('Registration failure'); } });
  expectFailure(report, 'registration', /Registration failure/);
  assert.equal(disposed, true);
});

// These policies belong only to this test supplier, never to the contract kit.
function workedGithub(input) {
  const candidates = [];
  const links = [];
  const urlPattern = /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/(pull|issues)\/(\d+)/g;
  for (const m of input.text.matchAll(urlPattern)) {
    const span = { start: m.index, end: m.index + m[0].length };
    links.push({ ...span, repo: `${m[1]}/${m[2]}` });
    candidates.push({ span, match: m[0], source: { provider: 'github', id: `github.com/${m[1]}/${m[2]}#${m[4]}`, kind: m[3] === 'pull' ? 'pull-request' : 'issue' }, confidence: 'high', provenance: { basis: 'explicit', explanation: 'GitHub pull request URL.' } });
  }
  for (const m of input.text.matchAll(/#\d+/g)) {
    const span = { start: m.index, end: m.index + m[0].length };
    const nearest = nearestSpan(span, links);
    let repo, provenance, confidence;
    if (nearest) { repo = nearest.repo; confidence = 'medium'; provenance = { basis: 'text-url', explanation: `Repository from the nearest GitHub link (${repo}).`, evidence: { span: { start: nearest.start, end: nearest.end } } }; }
    else if (input.context.git) {
      const git = input.context.git;
      const remote = git.remotes.find(r => r.name === git.upstream?.remote) ?? git.remotes.find(r => r.name === 'origin') ?? (git.remotes.length === 1 ? git.remotes[0] : undefined);
      const match = remote?.url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (match) { repo = `${match[1]}/${match[2]}`; confidence = 'low'; provenance = { basis: 'git-remote', explanation: `Repository from ${remote.name}, the upstream of branch ${git.branch}.`, evidence: { remote: remote.name } }; }
    }
    if (repo) candidates.push({ span, match: m[0], source: { provider: 'github', id: `github.com/${repo}${m[0]}` }, confidence, provenance });
  }
  return { candidates: candidates.filter(c => !input.excluded.some(s => s.start < c.span.end && s.end > c.span.start)).sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end) };
}
test('worked GitHub inference passes through real registration as supplier policy', async () => {
  const cases = workedExamples.filter(f => /^11\.[12]/.test(f.name)).map(f => ({ name: f.name, input: f.input, expected: f.output }));
  const githubClaim = { provider: 'github', kinds: ['issue', 'pull-request'], specificity: 'typed' };
  const report = await runSupplierConformance({ pluginId: 'github-review-test', register: bb => registerRecognitionSupplier(bb, { revision: 'worked/1', linkify: { providers: [githubClaim], handler: workedGithub } }), linkifyCases: cases });
  assert.equal(report.passed, true, JSON.stringify(failures(report)));
});
test('worked Plan Graph inference passes through real registration as supplier policy', async () => {
  const fixture = workedExamples.find(f => f.name === '11.3-plan-path');
  const report = await runSupplierConformance({ pluginId: 'plan-graph-test', register: bb => registerRecognitionSupplier(bb, { revision: 'worked-plan/1', linkify: { providers: [{ provider: 'plan-graph', kinds: ['plan'], specificity: 'typed' }], handler(value) {
    if (!value.context.environmentId) return { candidates: [] };
    const m = /plans\/[^\s]+\.plan\.pkl/.exec(value.text);
    if (!m) return { candidates: [] };
    const c = { ...fixture.output.candidates[0], span: { start: m.index, end: m.index + m[0].length }, match: m[0], source: { provider: 'plan-graph', id: `${value.context.environmentId}:${m[0]}`, kind: 'plan' } };
    return { candidates: value.excluded.some(s => s.start < c.span.end && s.end > c.span.start) ? [] : [c] };
  } } }), linkifyCases: [{ name: fixture.name, input: fixture.input, expected: fixture.output }] });
  assert.equal(report.passed, true, JSON.stringify(failures(report)));
});
