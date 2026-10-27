import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import * as contract from "../dist/index.js";
import { classifyCallError, createPeopleAccountsClient, registerPeopleAccountsSupplier, resolveAttributionFailOpen } from "../dist/bb.js";
import { createFixtureSupplierPort, healthFixture, rosterEntryFixture, runPeopleAccountsConformance, sdkFromFakeHost } from "../dist/testing.js";

const TOKEN = "ghp_conformanceFixtureToken000";
const ada = { ...rosterEntryFixture(), credential: healthFixture({ state: "ok", actsAs: "ada-bot", scopes: ["repo"] }) };
const bea = {
  ...rosterEntryFixture({ personKey: "person:fixture:bea", displayName: "Bea Fixture", aliases: { emails: ["bea@example.test"], nicknames: ["bea", "fixture"], handles: [] }, githubLogin: "bea-human", botLogin: "bea-bot", committer: { name: "Bea Fixture", email: "bea@example.test" } }),
  credential: healthFixture({ state: "missing" }),
};
const cyd = {
  ...rosterEntryFixture({ personKey: "person:fixture:cyd", displayName: "Cyd Fixture", aliases: { emails: [], nicknames: ["cyd", "fixture"], handles: [] }, githubLogin: null, botLogin: null, committer: null }),
  credential: healthFixture({ state: "missing" }),
};

function supplierHost(rows = [ada, bea, cyd], tokens = { "ada-bot": TOKEN }) {
  const port = createFixtureSupplierPort(rows, tokens);
  const host = createFakePluginHost({ pluginId: "people-accounts" });
  registerPeopleAccountsSupplier(host.bb, port);
  return { host, port, client: createPeopleAccountsClient(sdkFromFakeHost(host)) };
}
const sdkFor = callRpc => ({ plugins: { callRpc } });

test("closed DTOs reject unknown input fields and bound strings", () => {
  const entry = rosterEntryFixture();
  assert.deepEqual(contract.rosterEntryV1Schema.parse(entry), entry);
  assert.throws(() => contract.rosterEntryV1Schema.parse({ ...entry, token: "x" }));
  assert.throws(() => contract.rosterEntryV1Schema.parse({ ...entry, githubLogin: "bad login" }));
  assert.throws(() => contract.rosterEntryV1Schema.parse({ ...entry, githubLogin: "-lead" }));
  assert.throws(() => contract.rosterEntryV1Schema.parse({ ...entry, committer: { name: "A <x>", email: "a@b.c" } }));
  assert.throws(() => contract.rosterEntryV1Schema.parse({ ...entry, aliases: { ...entry.aliases, emails: ["not-an-email"] } }));
  assert.throws(() => contract.rosterEntryV1Schema.parse({ ...entry, displayName: "é".repeat(65) }));
  assert.throws(() => contract.resolveInputSchema.parse({ version: 1, inputs: Array(17).fill("a") }));
  assert.throws(() => contract.resolveInputSchema.parse({ version: 1, inputs: ["a\u0000"] }));
  assert.throws(() => contract.resolveInputSchema.parse({ version: 1, inputs: [], extra: 1 }));
  assert.throws(() => contract.credentialInputSchema.parse({ version: 1, botLogin: "ok", token: "x" }));
});

test("outputs tolerate and strip added fields", () => {
  const row = contract.rosterRowV1Schema.parse({ ...ada, token: TOKEN, credential: { ...ada.credential, secret: TOKEN } });
  assert.equal(JSON.stringify(row).includes(TOKEN), false);
  const envelope = contract.describeEnvelopeSchema.parse({ protocol: "bb-people-accounts", versions: [1], future: true });
  assert.deepEqual(envelope, { protocol: "bb-people-accounts", versions: [1] });
});

test("negotiation fixtures: [1], [1,2], [2], [], malformed", () => {
  const env = versions => ({ protocol: "bb-people-accounts", versions });
  assert.equal(contract.negotiateVersion(env([1])).kind, "ok");
  assert.deepEqual(contract.negotiateVersion(env([1, 2])), { kind: "ok", version: 1, versions: [1, 2] });
  assert.deepEqual(contract.negotiateVersion(env([2])), { kind: "incompatible", reason: "version", versions: [2] });
  assert.deepEqual(contract.negotiateVersion(env([])), { kind: "incompatible", reason: "schema" });
  for (const bad of [null, "x", { protocol: "other", versions: [1] }, env([1.5]), env(Array(17).fill(1))])
    assert.equal(contract.negotiateVersion(bad).kind, "incompatible");
});

test("attribution: first resolved is primary, all human logins assign, duplicates collapse, skipped named", () => {
  const p = person => contract.personSummaryOf(person);
  const results = [
    { input: "ghost", status: "not-found" },
    { input: "fixture", status: "ambiguous", candidates: [p(bea), p(cyd)] },
    { input: "bea", status: "resolved", person: p(bea), matchedBy: "nickname" },
    { input: "ada", status: "resolved", person: p(ada), matchedBy: "nickname" },
    { input: "bea@example.test", status: "resolved", person: p(bea), matchedBy: "email" },
  ];
  const a = contract.summarizeAttribution(results, ["Dee", "Eve"]);
  assert.equal(a.primary.input, "bea");
  assert.deepEqual(a.others.map(o => o.input), ["ada"]);
  assert.deepEqual(a.skipped.map(s => s.input), ["ghost", "fixture"]);
  // Bea is primary but has no token: default account, never Ada's bot.
  assert.equal(a.postAs, null);
  assert.deepEqual(a.assignees, ["bea-human", "ada-human"]);
  assert.deepEqual(contract.coAuthorTrailers(a), ["Co-Authored-By: Bea Fixture <bea@example.test>", "Co-Authored-By: Ada Fixture <ada.commits@example.test>"]);
  assert.match(a.fallbackReason, /Bea Fixture has no token configured for bea-bot/);
  assert.match(a.fallbackReason, /"ghost" \(not in the roster\)/);
  assert.match(a.fallbackReason, /"fixture" \(ambiguous: Bea Fixture, Cyd Fixture\)/);
  assert.match(a.fallbackReason, /Thread participants seen: Dee, Eve\./);

  const clean = contract.summarizeAttribution([{ input: "ada", status: "resolved", person: p(ada), matchedBy: "nickname" }]);
  assert.equal(clean.postAs, "ada-bot");
  assert.equal(clean.fallbackReason, null);
  assert.match(contract.summarizeAttribution([], []).fallbackReason, /No people were named.*Thread participants seen: none\./);
  assert.match(contract.summarizeAttribution([{ input: "cyd", status: "resolved", person: p(cyd), matchedBy: "nickname" }]).fallbackReason, /Cyd Fixture has no bot account/);
  const many = contract.summarizeAttribution(Array.from({ length: 16 }, (_, i) => ({ input: `n${i}`, status: "not-found" })));
  assert.match(many.fallbackReason, /and 8 more/);
  assert.ok(contract.utf8ByteLength(contract.summarizeAttribution([], Array(32).fill("é".repeat(64))).fallbackReason) <= contract.LIMITS.reasonBytes);
});

test("real registered handlers emit the declared entries", async () => {
  const { host, client, port } = supplierHost();
  assert.deepEqual(await client.describe(), { protocol: "bb-people-accounts", version: 1, versions: [1] });
  const resolved = await client.resolve({ inputs: ["nobody", "@ADA-L", "fixture", "ada@example.test"], participants: ["Dee"] });
  assert.deepEqual(resolved.results.map(r => [r.input, r.status]), [["nobody", "not-found"], ["@ADA-L", "resolved"], ["fixture", "ambiguous"], ["ada@example.test", "resolved"]]);
  assert.equal(resolved.attribution.postAs, "ada-bot");
  assert.deepEqual(resolved.attribution.assignees, ["ada-human"]);
  assert.match(resolved.attribution.fallbackReason, /Skipped: "nobody".*"fixture" \(ambiguous: Bea Fixture, Cyd Fixture\).*Dee/);
  assert.equal(JSON.stringify(resolved).includes(TOKEN), false);
  assert.equal(port.calls.credential.length, 0, "resolve never reads a token");
  const roster = await client.roster();
  assert.deepEqual(roster.entries.map(e => e.personKey), [ada.personKey, bea.personKey, cyd.personKey]);
  assert.deepEqual(roster.entries.map(e => e.credential.scopes), [["repo"], undefined, undefined]);
  assert.deepEqual(await client.credential("ada-bot"), { status: "available", botLogin: "ada-bot", token: TOKEN });
  assert.deepEqual(await client.credential("bea-bot"), { status: "unavailable", botLogin: "bea-bot", reason: "no-credential" });
  assert.deepEqual(await client.credential("zed-bot"), { status: "unavailable", botLogin: "zed-bot", reason: "unknown-account" });
  await assert.rejects(host.harness.callRpc("peopleAccountsDescribe", { any: 1 }));
});

test("supplier extras, including a token on a row, never reach the wire", async () => {
  const leaky = { ...ada, token: TOKEN, credential: { ...ada.credential, raw: TOKEN } };
  const port = createFixtureSupplierPort([leaky], {});
  const original = port.resolve;
  port.resolve = input => ({ ...original(input), token: TOKEN });
  const host = createFakePluginHost({ pluginId: "people-accounts" });
  registerPeopleAccountsSupplier(host.bb, port);
  for (const [method, input] of [["peopleAccountsV1Roster", { version: 1 }], ["peopleAccountsV1Resolve", { version: 1, inputs: ["ada"] }]])
    assert.equal(JSON.stringify(await host.harness.callRpc(method, input)).includes(TOKEN), false, method);
});

test("supplier port exceptions leave the real handler as fixed, token-free errors", async () => {
  const { inspect } = await import("node:util");
  const port = createFixtureSupplierPort([ada], { "ada-bot": TOKEN });
  port.credential = () => { throw new Error(`upstream ${TOKEN}`); };
  port.resolve = () => { throw new Error(`resolve ${TOKEN}`); };
  const host = createFakePluginHost({ pluginId: "people-accounts" });
  registerPeopleAccountsSupplier(host.bb, port);
  for (const [method, input] of [["peopleAccountsV1Credential", { version: 1, botLogin: "ada-bot" }], ["peopleAccountsV1Resolve", { version: 1, inputs: ["ada"] }]]) {
    const error = await host.harness.callRpc(method, input).then(() => assert.fail(`${method} resolved`), e => e);
    assert.equal(inspect(error, { depth: 10 }).includes(TOKEN), false, method);
    assert.equal(JSON.stringify({ message: error.message, ...error }).includes(TOKEN), false, method);
    assert.match(error.message, /the people-accounts supplier failed/);
  }
  const listing = createFixtureSupplierPort([ada]);
  listing.listRoster = () => { throw new Error(`roster ${TOKEN}`); };
  const rosterHost = createFakePluginHost({ pluginId: "people-accounts" });
  registerPeopleAccountsSupplier(rosterHost.bb, listing);
  const rosterError = await rosterHost.harness.callRpc("peopleAccountsV1Roster", { version: 1 }).catch(e => e);
  assert.equal(inspect(rosterError, { depth: 10 }).includes(TOKEN), false);
});

test("conformance kit rejects a real handler that leaks the token in raw replies", async () => {
  const { host: good } = supplierHost();
  const leaky = createFakePluginHost({ pluginId: "people-accounts" });
  // A supplier registering by hand (not via the helper) that adds a raw field.
  leaky.bb.rpc.register({
    peopleAccountsDescribe: { input: contract.describeInputSchema, output: { "~standard": { version: 1, vendor: "t", validate: value => ({ value }) } } },
    peopleAccountsV1Roster: { input: contract.rosterInputSchema, output: { "~standard": { version: 1, vendor: "t", validate: value => ({ value }) } } },
    peopleAccountsV1Resolve: { input: contract.resolveInputSchema, output: { "~standard": { version: 1, vendor: "t", validate: value => ({ value }) } } },
    peopleAccountsV1Credential: { input: contract.credentialInputSchema, output: { "~standard": { version: 1, vendor: "t", validate: value => ({ value }) } } },
  }, {
    peopleAccountsDescribe: () => good.harness.callRpc("peopleAccountsDescribe", null),
    peopleAccountsV1Roster: async input => ({ ...(await good.harness.callRpc("peopleAccountsV1Roster", input)), rawToken: TOKEN }),
    peopleAccountsV1Resolve: input => good.harness.callRpc("peopleAccountsV1Resolve", input),
    peopleAccountsV1Credential: input => good.harness.callRpc("peopleAccountsV1Credential", input),
  });
  await assert.rejects(runPeopleAccountsConformance({ host: leaky, entry: rosterEntryFixture(), token: TOKEN }), /roster: output contains the bot token/);
});

test("conformance kit passes the fixture supplier's real handlers and detects broken ones", async () => {
  const { host } = supplierHost();
  const result = await runPeopleAccountsConformance({ host, entry: rosterEntryFixture(), token: TOKEN, botLoginWithoutToken: "bea-bot", ambiguous: { input: "fixture", personKeys: [bea.personKey, cyd.personKey] } });
  assert.deepEqual(result, { level: "source-conformance", pluginId: "people-accounts", checks: ["describe-negotiates-v1", "roster-secret-free", "aliases-resolve", "not-found-fails-open", "ambiguous-never-picks", "credential-backend", "strict-input"] });

  const caseSensitive = createFixtureSupplierPort([ada, bea, cyd], { "ada-bot": TOKEN });
  const exact = caseSensitive.resolve;
  caseSensitive.resolve = input => input === input.trim() && !input.startsWith("@") && input === input.toLowerCase() ? exact(input) : { status: "not-found" };
  const broken = createFakePluginHost({ pluginId: "people-accounts" });
  registerPeopleAccountsSupplier(broken.bb, caseSensitive);
  await assert.rejects(runPeopleAccountsConformance({ host: broken, entry: rosterEntryFixture() }), /aliases/);

  const picky = createFixtureSupplierPort([ada, bea, cyd]);
  const pick = picky.resolve;
  picky.resolve = input => { const r = pick(input); return r.status === "ambiguous" ? { status: "resolved", person: r.candidates[0], matchedBy: "nickname" } : r; };
  const picker = createFakePluginHost({ pluginId: "people-accounts" });
  registerPeopleAccountsSupplier(picker.bb, picky);
  await assert.rejects(runPeopleAccountsConformance({ host: picker, entry: rosterEntryFixture(), ambiguous: { input: "fixture", personKeys: [bea.personKey] } }), /ambiguous/);

  const { host: wrongToken } = supplierHost([ada, bea, cyd], { "ada-bot": "ghp_other" });
  await assert.rejects(runPeopleAccountsConformance({ host: wrongToken, entry: rosterEntryFixture(), token: TOKEN }), /credential/);
});

test("unavailable supplier: every failure kind fails open with a reason and never throws", async () => {
  const cases = [
    [{ code: "plugin_not_found", status: 404 }, "absent"],
    [{ code: "plugin_disabled", status: 503 }, "disabled"],
    [{ code: "unknown_method", status: 404 }, "unknown-method"],
    [{ status: 500, message: `boom ${TOKEN}` }, "failed"],
  ];
  for (const [error, kind] of cases) {
    const client = createPeopleAccountsClient(sdkFor(async () => { throw error; }));
    const r = await resolveAttributionFailOpen(client, { inputs: ["ada"], participants: ["Dee"] });
    assert.equal(r.source, "unavailable"); assert.equal(r.error, kind);
    assert.equal(r.attribution.postAs, null);
    assert.equal(r.attribution.fallbackReason, `People accounts were unavailable (${kind}), so authorship defaulted to the default account. Named: "ada". Thread participants seen: Dee.`);
    assert.equal(r.attribution.fallbackReason.includes(TOKEN), false);
  }
  const incompatible = await resolveAttributionFailOpen(createPeopleAccountsClient(sdkFor(async () => ({ protocol: "bb-people-accounts", versions: [2] }))), { inputs: [] });
  assert.equal(incompatible.error, "incompatible");
  const malformed = await resolveAttributionFailOpen(createPeopleAccountsClient(sdkFor(async ({ method }) => method === "peopleAccountsDescribe" ? { protocol: "bb-people-accounts", versions: [1] } : { version: 1, results: "nope" })), { inputs: ["ada"] });
  assert.equal(malformed.error, "malformed");
  const slow = await resolveAttributionFailOpen(createPeopleAccountsClient(sdkFor(() => new Promise(() => {})), undefined, { describeMs: 5 }), { inputs: ["ada"] });
  assert.equal(slow.error, "timeout");
  await assert.rejects(resolveAttributionFailOpen(createPeopleAccountsClient(sdkFor(async () => null)), { inputs: [], extra: 1 }));
});

test("client rejects results that do not echo inputs and recomputes attribution", async () => {
  const describe = { protocol: "bb-people-accounts", versions: [1] };
  const person = contract.personSummaryOf(ada);
  const lying = { postAs: "bea-bot", primary: null, others: [], skipped: [], assignees: ["someone"], coAuthors: [], fallbackReason: null };
  const reply = results => sdkFor(async ({ method }) => method === "peopleAccountsDescribe" ? describe : { version: 1, results, attribution: lying });
  const ok = await createPeopleAccountsClient(reply([{ input: "ada", status: "resolved", person, matchedBy: "nickname" }])).resolve({ inputs: ["ada"] });
  assert.equal(ok.attribution.postAs, "ada-bot");
  assert.deepEqual(ok.attribution.assignees, ["ada-human"]);
  for (const results of [[], [{ input: "other", status: "not-found" }], [{ input: "ada", status: "not-found" }, { input: "ada", status: "not-found" }]])
    await assert.rejects(createPeopleAccountsClient(reply(results)).resolve({ inputs: ["ada"] }), e => e.kind === "malformed");
  const failOpen = await resolveAttributionFailOpen(createPeopleAccountsClient(reply([])), { inputs: ["ada"] });
  assert.equal(failOpen.error, "malformed");
  const otherLogin = createPeopleAccountsClient(sdkFor(async () => ({ status: "available", botLogin: "bea-bot", token: TOKEN })));
  await assert.rejects(otherLogin.credential("ada-bot"), e => e.kind === "malformed");
});

test("call errors carry no transport cause, so a token in a failure body cannot be inspected or logged", async () => {
  const { inspect } = await import("node:util");
  const client = createPeopleAccountsClient(sdkFor(async () => { throw Object.assign(new Error(`upstream said ${TOKEN}`), { status: 500, body: { error: { message: TOKEN } } }); }));
  const error = await client.credential("ada-bot").catch(e => e);
  assert.equal(error.kind, "failed");
  assert.equal(error.cause, undefined);
  assert.equal(inspect(error, { depth: 10 }).includes(TOKEN), false);
  assert.equal(JSON.stringify(error).includes(TOKEN), false);
});

test("fallback reason keeps participants when skipped names are long and multibyte", () => {
  const long = i => `${"é".repeat(150)}${i}@x`.slice(0, 160);
  assert.ok(contract.utf8ByteLength(long(0)) <= contract.LIMITS.inputBytes);
  const results = Array.from({ length: 16 }, (_, i) => ({ input: long(i), status: "not-found" }));
  const participants = Array.from({ length: 32 }, (_, i) => `${"名".repeat(40)}${i}`);
  const a = contract.summarizeAttribution(results, participants);
  assert.ok(contract.utf8ByteLength(a.fallbackReason) <= contract.LIMITS.reasonBytes);
  assert.match(a.fallbackReason, /^Nobody named matched the roster/);
  assert.match(a.fallbackReason, /Skipped: /);
  assert.match(a.fallbackReason, /Thread participants seen: 名/);
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(a.fallbackReason), false, "no lone surrogate");
  const unavailable = contract.unavailableReason("timeout", results.map(r => r.input), participants);
  assert.ok(contract.utf8ByteLength(unavailable) <= contract.LIMITS.reasonBytes);
  assert.match(unavailable, /Named: .*Thread participants seen: 名/);
});

test("client validates before transport, targets the injected owner, enforces budgets and cancels", async () => {
  let calls = 0, seen;
  const client = createPeopleAccountsClient(sdkFor(async args => { calls++; seen = args; return { protocol: "bb-people-accounts", versions: [1] }; }), "alt-people");
  await assert.rejects(client.credential("bad login"));
  assert.equal(calls, 0);
  await client.describe();
  assert.equal(seen.pluginId, "alt-people"); assert.equal(seen.method, "peopleAccountsDescribe"); assert.equal(seen.input, null); assert.ok(seen.signal);
  await assert.rejects(createPeopleAccountsClient(sdkFor(async () => ({ protocol: "bb-people-accounts", versions: [1], pad: "a".repeat(contract.LIMITS.responseBytes) }))).describe(), e => e.kind === "malformed");
  let transport;
  const hanging = createPeopleAccountsClient(sdkFor(({ signal }) => { transport = signal; return new Promise(() => {}); }), undefined, { callMs: 10 });
  await assert.rejects(hanging.roster(), e => e.kind === "timeout");
  assert.equal(transport.aborted, true);
  const abort = new AbortController();
  const pending = hanging.resolve({ inputs: [] }, abort.signal); abort.abort();
  await assert.rejects(pending, e => e.kind === "cancelled");
  assert.throws(() => createPeopleAccountsClient(sdkFor(async () => null), undefined, { callMs: 5001 }), /Budget/);
  assert.equal(classifyCallError({ name: "AbortError" }), "cancelled");
  assert.equal(classifyCallError({ code: "invalid_input", status: 400 }), "incompatible");
});

test("normalizeAliasKey trims, NFC-normalizes, lower-cases and strips one leading @", () => {
  assert.equal(contract.normalizeAliasKey("  @Ada-L "), "ada-l");
  assert.equal(contract.normalizeAliasKey("é"), contract.normalizeAliasKey("é"));
  assert.equal(contract.normalizeAliasKey("@@x"), "@x");
});
