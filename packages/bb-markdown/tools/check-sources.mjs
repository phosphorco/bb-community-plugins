#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkSources, sourceGateCoverage } from '../dist/testing-source-gate.js';

// Explicit ids keep the same manifest usable from either independent repository.
const roots = [];
let debtPath = new URL('./markdown-debt.json', import.meta.url), json = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--root') {
    const value = process.argv[++i], split = value?.indexOf('=') ?? -1;
    if (split < 1 || split === value.length - 1) throw new Error('--root requires id=/absolute/or/relative/repository');
    roots.push({ id: value.slice(0, split), path: resolve(value.slice(split + 1)) });
  } else if (arg === '--debt') {
    const value = process.argv[++i]; if (!value) throw new Error('--debt requires a file'); debtPath = resolve(value);
  } else if (arg === '--json') json = true;
  else throw new Error(`Unknown argument ${arg}. Usage: check-sources --root org=PATH [--root community=PATH] [--debt FILE] [--json]`);
}
const result = checkSources({ roots, debt: JSON.parse(readFileSync(debtPath, 'utf8')) });
if (json) console.log(JSON.stringify({ ...result, scope: sourceGateCoverage }, null, 2));
else {
  for (const f of result.findings) console.error(`${f.root}/${f.path}:${f.line}:${f.column} [${f.rule}] ${f.message}\n  ${f.excerpt}\n  sha256:${f.sha256}`);
  for (const e of result.stale) console.log(`Stale/decreased debt (deletion allowed): ${e.root}/${e.path} [${e.rule}] ${e.sha256}; remove or reduce reviewed entry.`);
  console.log(`Markdown source gate: ${result.ok ? 'PASS' : 'FAIL'}; ${result.coverage.files} source files, ${result.coverage.templates} templates, ${result.coverage.candidates} candidates, ${result.coverage.debt} debt, ${result.coverage.exceptions} exact exceptions, ${result.coverage.violations} violations; ${result.coverage.excluded} excluded directories/symlinks.`);
  console.log(sourceGateCoverage.limits);
}
if (!result.ok) process.exitCode = 1;
