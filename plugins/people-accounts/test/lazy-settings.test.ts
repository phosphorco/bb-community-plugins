import { expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

// Follow emitted static imports too: a shared chunk can accidentally pull the
// settings implementation back into an otherwise small registration entry.
test('unopened registration excludes settings reads, actions and recovery code', async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../app.tsx')],
    target: 'browser', splitting: true, minify: true,
    external: ['react', 'react/*', '@get-bb/plugin-sdk/*'],
  });
  expect(built.success).toBe(true);
  const files = new Map(await Promise.all(built.outputs.filter(file => file.path.endsWith('.js')).map(async file => [resolve(file.path), await file.text()] as const)));
  const entry = built.outputs.find(file => file.kind === 'entry-point')!;
  const seen = new Set<string>();
  function visit(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    const source = ts.createSourceFile(path, files.get(path)!, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) visit(resolve(dirname(path), specifier.text));
    }
  }
  visit(resolve(entry.path));
  const eager = [...seen].map(path => files.get(path)).join('\n');
  const deferred = [...files].filter(([path]) => !seen.has(path)).map(([, source]) => source).join('\n');
  expect(eager).toContain('people-accounts-health');
  for (const marker of ['peopleAccountsStatus', 'peopleAccountsCheck', 'peopleAccountsDirectory', 'Retrying automatically', 'personal-access-tokens/new']) {
    expect(eager).not.toContain(marker);
    expect(deferred).toContain(marker);
  }
});
