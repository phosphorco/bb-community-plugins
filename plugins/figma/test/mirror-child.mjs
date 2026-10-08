#!/usr/bin/env node
// Deterministic MCP stdio fixture. Contains no network or real credentials.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const controlPath = join(dirname(process.argv[1]), 'control.json');
const logPath = join(dirname(process.argv[1]), 'events.jsonl');
const control = () => JSON.parse(readFileSync(controlPath, 'utf8'));
const cachePath = join(process.cwd(), 'fixture-cache.json');
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const active = new Set();
const persist = () => writeFileSync(cachePath, JSON.stringify(cache));
const event = value => appendFileSync(logPath, JSON.stringify(value) + '\n');
event({ kind: 'start', pid: process.pid, cwd: process.cwd(), tokenMatches: process.env.FIGMA_TOKEN === control().expectedToken });
process.stderr.write('fixture confidential diagnostic ' + process.env.FIGMA_TOKEN + '\n');
if (control().mode === 'stderr-flood') process.stderr.write(Buffer.alloc(1100000, 120));
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
  const settings = control();
  if (request.method === 'initialize') {
    if (settings.mode === 'startup-hang') return;
    reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'figmog-fixture', version: '0.0.2' }, instructions: 'fixture' }); return;
  }
  if (request.method === 'ping') { reply({}); return; }
  if (request.method === 'tools/list') {
    if (Array.isArray(settings.tools)) reply({ tools: settings.tools, vendor: { unchanged: true } });
    else if (settings.catalogVersion) reply({ tools: [{ name: settings.catalogVersion, inputSchema: { type: 'object' } }], vendor: { unchanged: true } });
    else reply({ tools: [], vendor: { unchanged: true } });
    return;
  }
  if (request.method !== 'tools/call') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: process.env.FIGMA_TOKEN } }) + '\n'); return; }
  const { name, arguments: args = {} } = request.params;
  event({ kind: 'call', name, file: args.file });
  if (name === 'hang') return;
  if (name === 'exit') { process.exit(0); return; }
  if (name === 'huge') { reply({ padding: 'x'.repeat(17 * 1024 * 1024) }); return; }
  if (name === 'echo') { reply({ content: [{ type: 'image', data: 'AQID', mimeType: 'image/png', id: '1:1' }, { type: 'text', text: '<svg/>', mimeType: 'image/svg+xml', ref: 'a' }], structuredContent: { a: 1 }, _meta: { extension: true }, isError: false }); return; }
  if (name === 'figmog_files') { reply(toolResult([...active].map(key => ({ key, version: cache[key], default: active.size === 1 })))); return; }
  const key = args.file ?? [...active][0];
  if (!key) { reply({ content: [{ type: 'text', text: 'no file' }], isError: true }); return; }
  active.add(key);
  cache[key] ??= settings.versions[key] ?? '100'; persist();
  if (name === 'figmog_sync' || name === 'figmog_open') {
    if (settings.syncError || settings.syncErrors?.includes(key)) { reply({ content: [{ type: 'text', text: 'sync failed' }], isError: true }); return; }
    cache[key] = settings.versions[key] ?? cache[key]; persist(); reply(toolResult({ changed: 1 })); return;
  }
  if (name === 'figmog_status') { reply(toolResult({ version: cache[key], name: key, nodes: 1 })); return; }
  reply(toolResult({ version: cache[key], file: key, id: args.id ?? '1:1' }));
});
lines.on('close', () => { event({ kind: 'exit', pid: process.pid }); process.exit(0); });
