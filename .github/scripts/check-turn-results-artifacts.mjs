import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkArtifacts(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ids = new Map([
    ['@phosphorco/bb-plugin-turn-results', 'turn-results'],
    ['@phosphorco/bb-plugin-turn-result-images', 'turn-result-images'],
  ]);
  const id = ids.get(manifest.name);
  if (!id) throw new Error('Unsupported Turn Results artifact package');
  const metadata = entry => {
    const value = JSON.parse(readFileSync(join(root, 'dist', `${entry}.meta.json`), 'utf8'));
    if (value.sdkVersion !== '0.6.52' || value.builtWith?.pluginSdkVersion !== '0.6.52'
      || value.pluginId !== id || value.pluginVersion !== manifest.version) {
      throw new Error(`Wrong selected SDK/package metadata: ${entry}`);
    }
    return value;
  };
  const server = metadata('server');
  if (server.artifactFormatVersion !== 1 || !statSync(join(root, 'dist/server.js')).isFile()) {
    throw new Error('Invalid server artifact');
  }
  if (!manifest.bb?.app) return { id, version: manifest.version, sdk: '0.6.52' };
  const app = metadata('app');
  const artifact = app.appArtifact;
  if (app.artifactFormatVersion !== 2 || !/^[a-f0-9]{32}$/.test(artifact?.generation ?? '')
    || !Array.isArray(artifact.files) || artifact.files.length < 1 || artifact.files.length > 256) {
    throw new Error('Invalid selected frontend generation');
  }
  const base = join(root, 'dist/.bb-artifacts', artifact.generation);
  const names = new Set();
  for (const file of artifact.files) {
    if (typeof file.path !== 'string' || !/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(file.path)
      || file.path.split('/').some(part => part === '.' || part === '..') || names.has(file.path)) {
      throw new Error('Invalid or duplicate frontend asset path');
    }
    names.add(file.path);
    const path = resolve(base, file.path);
    if (!path.startsWith(base + sep)) throw new Error('Frontend asset outside generation');
    const bytes = readFileSync(path);
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`Frontend asset digest mismatch: ${file.path}`);
    }
  }
  if (!names.has('app.js')) throw new Error('Missing frontend entry');
  return { id, version: manifest.version, sdk: '0.6.52', generation: artifact.generation, files: artifact.files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkArtifacts(process.argv[2]), null, 2));
}
