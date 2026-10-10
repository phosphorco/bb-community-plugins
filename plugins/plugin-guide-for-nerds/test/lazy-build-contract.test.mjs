import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const roots=[];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function fixture({ factory='() => import("./chunks/guide-content-fixture.js")', dependency=false, bb='0.45.0' }={}) {
  const root=mkdtempSync(join(tmpdir(),'nerd-guide-lazy-contract-')); roots.push(root);
  const generation='a'.repeat(32), artifact=join(root,'.bb-artifacts',generation); mkdirSync(join(artifact,'chunks'),{recursive:true});
  const markers=[...readFileSync(resolve('src/surfaces.ts'),'utf8').matchAll(/summary:\s*"([^"\n]{70,})"/g)].map(m=>m[1]).filter(v=>/^[\x20-\x7e]+$/.test(v)&&!v.includes('\\')).slice(0,3);
  const sources={'app.js':`export const load=${factory}; export const retry=url=>import(url);`, 'chunks/guide-content-fixture.js':`${dependency?'import "./extra.js";':''} export const data=${JSON.stringify(markers)};`};
  if(dependency) sources['chunks/extra.js']='export const extra=1;';
  const files=Object.entries(sources).map(([path,source])=>{writeFileSync(join(artifact,path),source);return{path,bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex')};});
  writeFileSync(join(root,'app.meta.json'),JSON.stringify({pluginId:'plugin-guide-for-nerds',artifactFormatVersion:2,sdkVersion:'0.6.29',builtWith:{pluginSdkVersion:'0.6.29',bbVersion:bb},appArtifact:{generation,files}}));
  return spawnSync(process.execPath,['scripts/check-lazy-build.mjs',root],{encoding:'utf8',env:{...process.env,BB_GUIDE_EXPECTED_BUILD_BB:'0.45.0',BB_GUIDE_EXPECTED_BUILD_SDK:'0.6.29'}});
}
it('accepts a reflectable generation-scoped leaf and exact selected compiler pair',()=>{const result=fixture();expect(result.status,result.stderr).toBe(0);});
it('rejects an unreflectable import factory',()=>{const result=fixture({factory:'async () => { return import("./chunks/guide-content-fixture.js"); }'});expect(result.status).not.toBe(0);expect(result.stderr).toContain('reflectable');});
it('rejects an unproven deferred static dependency',()=>{const result=fixture({dependency:true});expect(result.status).not.toBe(0);expect(result.stderr).toContain('Deferred dependency');});
it('rejects a compiler-pair mismatch even with otherwise valid bytes',()=>{const result=fixture({bb:'0.44.0'});expect(result.status).not.toBe(0);expect(result.stderr).toContain('0.44.0');});
