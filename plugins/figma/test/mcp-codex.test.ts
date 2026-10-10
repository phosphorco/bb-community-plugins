import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexManager } from "../mcp/codex.ts";
import type { CodexConfig } from "../contract.ts";
const binaryPath = fileURLToPath(new URL("./codex-child.mjs", import.meta.url));
async function fixture(t: TestContext, name = "figma") {
  const scratch = await mkdtemp(join(tmpdir(), "bb-codex-test-"));
  const directory = join(scratch, "connections", "codex");
  let c: CodexConfig = { binaryPath, serverName: name };
  const manager = createCodexManager({ directory, config: async () => c });
  t.after(async () => { await manager.close(); await rm(scratch, { recursive: true, force: true }); });
  return { manager, directory, config: (next: CodexConfig) => { c = next; }, audit: async () => (await readFile(join(directory,"codex-audit.jsonl"),"utf8")).trim().split("\n").map(x=>JSON.parse(x)) };
}
test("one initialized ephemeral no-turn thread; paginated full catalogs and honest capabilities", async t => {
  const {manager,audit,directory}=await fixture(t,"pagination");
  const peers=await Promise.all([manager.peer(),manager.peer(),manager.peer()]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(peers[0],peers[1]); assert.equal(peers[1],peers[2]);
  const peer=peers[0]!;
  assert.deepEqual(peer.info().capabilities,{tools:{},resources:{}});
  assert.match(peer.info().instructions!,/Prompts, completion, tasks/);
  const tool=((await peer.request("tools/list")).tools as any[])[0];
  assert.equal(tool.extension,"retained"); assert.equal(tool.outputSchema.type,"object"); assert.equal(tool.annotations.readOnlyHint,true); assert.equal(tool.icons.length,1);
  assert.equal((await peer.request("resources/list")).resources instanceof Array,true);
  assert.equal(((await peer.request("resources/templates/list")).resourceTemplates as any[])[0].extension,"kept");
  const records=await audit();
  assert.equal(records.filter(x=>x.spawn).length,1);
  assert.equal(records.filter(x=>x.method==="mcpServerStatus/list").length,2);
  assert.equal(records.filter(x=>x.method==="thread/start").length,1);
  assert.equal(records.some(x=>String(x.method).startsWith("turn/")),false);
  assert.equal(records.find(x=>x.method==="initialize").params.clientInfo.name,"bb_figma_plugin");
  assert.equal(records.find(x=>x.method==="thread/start").params.ephemeral,true);
  assert.equal(records.some(x=>x.method==="initialized"),true);
});
test("ordered envelopes, errors, images, structured content, resources and unavailable methods",async t=>{
  const {manager}=await fixture(t); const peer=await manager.peer();
  const r=await peer.request("tools/call",{name:"whoami",arguments:{error:true},_meta:{trace:1}});
  assert.deepEqual((r.content as any[]).map(x=>x.type),["text","image","resource_link"]);
  assert.deepEqual(r.structuredContent,{ok:true}); assert.equal(r.isError,true); assert.equal(r.extension,"retained"); assert.deepEqual(r._meta,{custom:"kept"});
  assert.equal((await peer.request("resources/read",{uri:"figma://test"})).extension,"retained");
  for(const method of ["prompts/list","prompts/get","completion/complete","tasks/list","resources/subscribe","logging/setLevel"]) await assert.rejects(peer.request(method),/supports tools and resource reads only/);
  await assert.rejects(peer.request("tools/call",{name:"whoami",task:{}}),/supports tools/);
  await assert.rejects(peer.request("tools/call",{name:"missing"}),/Unknown Figma tool/);
});
test("startup, auth and toolsError failures and pagination loops are secret-safe",async t=>{
  for(const name of ["startfail","noauth","toolserror","loop"]){
    const {manager}=await fixture(t,name);
    await assert.rejects(manager.peer(),e=>e instanceof Error && !/secret/.test(e.message));
    assert.doesNotMatch(manager.status().detail??"",/secret/);
  }
});
test("borrowed disposal and disconnect fence; connect reuses grant without login",async t=>{
  const {manager,audit}=await fixture(t); const peer=await manager.peer();
  await peer.close(); await assert.rejects(peer.request("tools/list"),/changed/);
  const next=await manager.peer(); assert.notEqual(next,peer);
  let changes=0; next.onCatalogChanged!(()=>changes++);
  await manager.disconnect(); assert.equal(changes,1);
  await assert.rejects(manager.peer(),/Test Figma/); await assert.rejects(next.request("tools/list"),/disconnected/);
  await manager.connect(); assert.equal(manager.status().phase,"connected"); assert.equal((await audit()).some(x=>x.login),false);
  await manager.close(); await assert.rejects(manager.connect(),/closed/);
});
test("concurrent single dispatch; caller cancellation preserves healthy sibling",async t=>{
  const {manager,audit}=await fixture(t); const peer=await manager.peer(); const abort=new AbortController();
  const cancelled=peer.request("tools/call",{name:"whoami",arguments:{delay:100}},abort.signal);
  const sibling=peer.request("tools/call",{name:"whoami",arguments:{delay:50}});
  abort.abort(); await assert.rejects(cancelled,/outcome is unknown.*official canvas/); await sibling;
  assert.equal(manager.status().phase,"connected");
  const pre=new AbortController(); pre.abort(); await assert.rejects(peer.request("tools/call",{name:"whoami"},pre.signal),/cancelled/);
  assert.equal((await audit()).filter(x=>x.method==="mcpServer/tool/call").length,2);
});
test("protocol errors sanitized, elicitation denied, no replay after process death",async t=>{
  const {manager,audit}=await fixture(t); const peer=await manager.peer();
  await assert.rejects(peer.request("tools/call",{name:"whoami",arguments:{protocol:true}}),e=>e instanceof Error && /JSON-RPC -32001/.test(e.message) && /Invalid nodeId: 12:34/.test(e.message) && !/secret/.test(e.message));
  await peer.request("tools/call",{name:"whoami",arguments:{elicit:true}});
  await assert.rejects(peer.request("tools/call",{name:"whoami",arguments:{crash:true}}),/outcome is unknown/);
  assert.equal((await audit()).filter(x=>x.method==="mcpServer/tool/call").length,3);
  await assert.rejects(peer.request("tools/list"),/changed/);
});
test("server status change fences catalog; changed config replaces transport",async t=>{
  const {manager,config}=await fixture(t); const peer=await manager.peer(); let changes=0; peer.onCatalogChanged!(()=>changes++);
  await peer.request("tools/call",{name:"whoami",arguments:{change:true,delay:30}});
  assert.equal(changes,1); await assert.rejects(peer.request("tools/list"),/changed/);
  const next=await manager.peer(); config({binaryPath,serverName:"pagination"});
  const newer=await manager.peer(); assert.notEqual(newer,next); await assert.rejects(next.request("tools/list"),/changed/);
});
test("close kills in-progress startup",async t=>{
  const {manager}=await fixture(t,"slowstart"); const p=manager.peer();
  await new Promise(resolve=>setTimeout(resolve,80)); await manager.close(); await assert.rejects(p,/closed|disconnected/);
});
test("piped no-browser DCR handoff validates callback, preserves issuer and normalizes quotes",async t=>{
  const {manager,audit}=await fixture(t); const old=await manager.peer();
  const started=await manager.beginAuth(); assert.equal(started.callbackRequired,true); assert.match(started.authorizationUrl,/https:\/\/www.figma.com\/oauth\/mcp/);
  for(const bad of ["https://evil.test/callback?code=secret-code&state=test-state","http://127.0.0.1:45678/callback?code=secret-code&state=wrong","http://127.0.0.1:45678/callback?code=secret-code&state=test-state&state=test-state"]){
    await assert.rejects(manager.finishCallback(bad),e=>e instanceof Error && /does not match/.test(e.message) && !/secret-code|test-state/.test(e.message));
  }
  assert.equal(manager.status().phase,"authorizing");
  await manager.finishCallback("  '127.0.0.1:45678/callback?code=secret-code&state=test-state&iss=https%3A%2F%2Fapi.figma.com'  ");
  assert.equal(manager.status().phase,"connected"); await assert.rejects(old.request("tools/list"),/disconnected/);
  const records=await audit(); const login=records.find(x=>x.login);
  assert.deepEqual(login.args.slice(-5),["--no-browser","--oauth-client-registration","dcr","--scopes","mcp:connect"]);
  assert.doesNotMatch(JSON.stringify(records),/secret-code|test-state/);
  await assert.rejects(manager.finishAuth({code:"x",state:"x"}),/complete browser callback URL/);
});
test("disconnect/close cancel pending login; raw child failure output is discarded",async t=>{
  for(const op of ["disconnect","close"] as const){
    const {manager}=await fixture(t); await manager.beginAuth(); await manager[op](); await assert.rejects(manager.finishCallback("anything"),/No pending/);
  }
  const {manager}=await fixture(t,"authfail"); await assert.rejects(manager.beginAuth(),e=>e instanceof Error && !/secret/.test(e.message));
});
test("only absolute native binary config accepted",async t=>{
  const {manager,config}=await fixture(t);
  for(const path of ["codex","/home/ubuntu/.local/share/mise/shims/codex","/tmp/router.mjs"]){config({binaryPath:path,serverName:"figma"}); await assert.rejects(manager.peer(),/native Codex binary/);}
});

test("bounded queue rejects before dispatch and timeout never replays or kills sibling", async t => {
  const {manager,audit}=await fixture(t); const peer=await manager.peer();
  t.mock.timers.enable({apis:["setTimeout"]});
  const calls = Array.from({length:32}, () => peer.request("tools/call",{name:"whoami",arguments:{hang:true}}));
  const settled = Promise.allSettled(calls);
  await assert.rejects(peer.request("tools/call",{name:"whoami"}),/queue is full/);
  t.mock.timers.tick(180_001);
  for (const r of await settled) { assert.equal(r.status,"rejected"); if(r.status==="rejected") assert.match(r.reason.message,/outcome is unknown/); }
  t.mock.timers.reset();
  await peer.request("tools/call",{name:"whoami"});
  assert.equal((await audit()).filter(x=>x.method==="mcpServer/tool/call").length,33);
});
test("asynchronous initialization waits for ready; duplicate ready notification keeps transport",async t=>{
  const {manager,audit}=await fixture(t,"initializing"); const peer=await manager.peer();
  assert.equal((await audit()).filter(x=>x.method==="mcpServerStatus/list").length,2);
  await peer.request("tools/call",{name:"whoami",arguments:{connected:true}});
  assert.equal(manager.status().phase,"connected"); await peer.request("tools/list");
});
test("concurrent sign-in starts are refused; invalid callbacks retain actionable authorizing state",async t=>{
  const {manager,audit}=await fixture(t); const started=manager.beginAuth();
  await assert.rejects(manager.beginAuth(),/already starting/); await started;
  await assert.rejects(manager.finishCallback("invalid"),/does not match/);
  assert.equal(manager.status().phase,"authorizing"); assert.match(manager.status().detail!,/does not match/);
  assert.equal((await audit()).filter(x=>x.login).length,1);
});

test("received delayed tool results survive health echoes and failure invalidation; rediscovery shares process",async t=>{
  const {manager,audit}=await fixture(t); const peer=await manager.peer();
  const slow=peer.request("tools/call",{name:"whoami",arguments:{delay:70}});
  await peer.request("tools/call",{name:"whoami",arguments:{starting:true,connected:true,delay:20}});
  await peer.request("tools/call",{name:"whoami",arguments:{change:true,delay:20}});
  const result=await slow; assert.equal(result.extension,"retained");
  await assert.rejects(peer.request("tools/list"),/changed/);
  const next=await manager.peer(); assert.notEqual(next,peer);
  assert.equal((await audit()).filter(x=>x.spawn).length,1);
  assert.equal((await audit()).filter(x=>x.method==="mcpServer/tool/call").length,3);
});
test("upstream timeout error envelope is preserved with unknown-outcome guidance",async t=>{
  const {manager,audit}=await fixture(t); const peer=await manager.peer();
  const result=await peer.request("tools/call",{name:"whoami",arguments:{timeout:true}});
  assert.equal(result.extension,"retained"); assert.equal(result.isError,true); assert.deepEqual(result.structuredContent,{ok:true});
  assert.equal((result.content as any[]).length,4); assert.match((result.content as any[])[3].text,/outcome is unknown/);
  const args=(await audit()).find(x=>x.spawn).args;
  assert.ok(args.includes("mcp_servers.figma.tool_timeout_sec=180")); assert.ok(args.includes("mcp_servers.figma.startup_timeout_sec=60"));
});
test("native localhost direct callback success reconnects without pasted callback",async t=>{
  const {manager,audit}=await fixture(t,"directauth"); await manager.beginAuth();
  for(let i=0;i<100 && manager.status().phase!=="connected";i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(manager.status().phase,"connected");
  await assert.rejects(manager.finishCallback("anything"),/No pending/);
  assert.equal((await audit()).filter(x=>x.login).length,1);
});

test("internal errors require inspection, clear invalid params are actionable",async t=>{
  const {manager}=await fixture(t); const peer=await manager.peer();
  await assert.rejects(peer.request("tools/call",{name:"whoami",arguments:{internal:true}}),/outcome is unknown.*JSON-RPC -32603.*timed out/);
  await assert.rejects(peer.request("tools/call",{name:"whoami",arguments:{invalidparams:true}}),e=> e instanceof Error && /JSON-RPC -32602.*Invalid nodeId/.test(e.message) && !/outcome is unknown/.test(e.message));
});
test("sign-in timeout is bounded; post-URL flood cannot leave login alive",async t=>{
  const {manager}=await fixture(t);
  t.mock.timers.enable({apis:["setTimeout"]}); await manager.beginAuth();
  t.mock.timers.tick(300_001); t.mock.timers.reset();
  assert.equal(manager.status().phase,"error"); await assert.rejects(manager.finishCallback("unused"),/No pending/);
  const flooded=await fixture(t,"authflood"); await flooded.manager.beginAuth();
  for(let i=0;i<100 && flooded.manager.status().phase==="authorizing";i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(flooded.manager.status().phase,"error"); await assert.rejects(flooded.manager.finishCallback("unused"),/No pending/);
});
test("failed callback token exchange preserves the existing live borrowed transport",async t=>{
  const {manager,audit}=await fixture(t,"authreject"); const peer=await manager.peer(); await manager.beginAuth();
  await assert.rejects(manager.finishCallback("http://127.0.0.1:45678/callback?code=secret-code&state=test-state&iss=https%3A%2F%2Fapi.figma.com"),e=>e instanceof Error && !/secret-code|test-state/.test(e.message));
  assert.equal(manager.status().phase,"connected"); await peer.request("tools/list");
  assert.equal((await audit()).filter(x=>x.spawn).length,1);
});

test("cancelled remote requests retain queue slots until response or deadline",async t=>{
  const {manager,audit}=await fixture(t); const peer=await manager.peer();
  const controllers=Array.from({length:32},()=>new AbortController());
  const calls=controllers.map(c=>peer.request("tools/call",{name:"whoami",arguments:{hang:true}},c.signal));
  const settled=Promise.allSettled(calls); for(const c of controllers)c.abort(); await settled;
  await assert.rejects(peer.request("tools/call",{name:"whoami"}),/queue is full/);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await audit()).filter(x=>x.method==="mcpServer/tool/call").length,32);
});
