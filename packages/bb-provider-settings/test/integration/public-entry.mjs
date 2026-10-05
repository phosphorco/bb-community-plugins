import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
// Exercise the actual public emitted target, never a copied resolver or SDK alias.
export function publicTarget(entry = '.') {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const target = manifest.exports?.[entry];
  const runtime = typeof target === 'string' ? target : target?.import;
  if (typeof runtime !== 'string') throw new Error(`Missing emitted public entry ${entry}`);
  return pathToFileURL(resolve(root, runtime)).href;
}
export async function loadPublic(entry = '.') { return import(publicTarget(entry)); }
export function required(api, name) {
  if (typeof api[name] !== 'function') throw new Error(`Missing public API ${name}`);
  return api[name];
}
