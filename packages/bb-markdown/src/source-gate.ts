/** Node-only source conformance. Never import this entry from a browser entry.
 * Syntax coverage is deliberately conservative; it is not whole-program dataflow.
 */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, existsSync, lstatSync } from 'node:fs';
import { join, relative, resolve, dirname, extname } from 'node:path';

export type SourceRoot = { id: string; path: string };
export type Finding = {
  root: string; path: string; line: number; column: number; rule: string;
  sha256: string; message: string; excerpt: string;
};
export type DebtEntry = {
  root: string; path: string; rule: string; sha256: string; count: number;
  kind: 'debt' | 'parser-only' | 'reviewed-exception'; intent: string;
};
export type DebtManifest = { version: 1; entries: DebtEntry[] };
export type GateResult = {
  ok: boolean; findings: Finding[]; debt: Finding[]; exceptions: Finding[];
  stale: DebtEntry[];
  coverage: { files: number; templates: number; excluded: number; candidates: number;
    debt: number; exceptions: number; violations: number; byRule: Record<string, number> };
};
export type InspectInput = { root: string; path: string; source: string };
const sdk = (s: string) => /^@get-bb\/plugin-sdk(?:\/|$)/.test(s);
const parser = (s: string) => /^(?:marked|unified|react-markdown|markdown-it|(?:remark|rehype|mdast-util|micromark)(?:[-/]|$))/.test(s);
const shared = (s: string) => /^@phosphorco\/bb-markdown(?:\/react)?$/.test(s);
const nativePath = 'packages/bb-markdown/src/native.tsx';
const grammarPath = 'packages/bb-markdown/src/grammar.ts';
const reactPath = 'packages/bb-markdown/src/react.tsx';
const oraclePath = 'packages/bb-markdown/tools/check-native.mjs';
const exclusions = new Set(['node_modules', '.git', 'dist', 'build', 'artifacts', '.references', '.cache', 'coverage', 'test', 'tests', '__tests__', 'type-tests', 'fixture', 'fixtures', 'spec', 'specs', 'plans', 'evidence']);
const extension = /\.(?:[cm]?[jt]sx?|html?)$/;
export const sourceFingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');
const prop = (n: ts.Node | undefined): string | undefined => n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) ? n.text : undefined;
function access(n: ts.Node): string | undefined {
  return ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : undefined;
}
function unwrap(n: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
  return n;
}
function outer(n: ts.Node): ts.Node {
  let p = n;
  while (p.parent) {
    const parent = p.parent;
    if (ts.isJsxSelfClosingElement(parent) || ts.isJsxOpeningElement(parent) || ts.isJsxAttribute(parent) || ts.isCallExpression(parent)) return parent;
    if (ts.isExportSpecifier(parent)) return parent.parent.parent;
    if (ts.isVariableDeclaration(parent) || ts.isStatement(parent) || ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isFunctionLike(parent)) return p;
    p = parent;
  }
  return p;
}
function isValueReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if ((ts.isPropertyAccessExpression(p) && p.name === n)
    || (ts.isPropertyAssignment(p) && p.name === n)
    || (ts.isJsxAttribute(p) && p.name === n)
    || (ts.isBindingElement(p) && (p.name === n || p.propertyName === n))
    || (ts.isVariableDeclaration(p) && p.name === n)
    || (ts.isParameter(p) && p.name === n)
    || (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) && p.name === n) return false;
  for (let at: ts.Node | undefined = p; at && !ts.isExpression(at) && !ts.isStatement(at); at = at.parent) if (ts.isTypeNode(at)) return false;
  return true;
}
export function inspectSource(input: InspectInput): { findings: Finding[]; templates: number } {
  const findings: Finding[] = [];
  let templates = 0;
  const unique = new Set<string>();
  const emit = (rule: string, text: string, at: number, message: string, identityAt = at) => {
    const sha256 = sourceFingerprint(text);
    const key = `${rule}:${identityAt}:${sha256}`;
    if (unique.has(key)) return;
    unique.add(key);
    const prefix = input.source.slice(0, at);
    findings.push({ root: input.root, path: input.path, line: prefix.split('\n').length,
      column: at - prefix.lastIndexOf('\n'), rule, sha256, message,
      excerpt: text.replace(/\s+/g, ' ').slice(0, 180) });
  };
  function scan(source: string, offset: number, embedded = false) {
    const sf = ts.createSourceFile(input.path + (embedded ? '.embedded.js' : ''), source,
      ts.ScriptTarget.Latest, true, embedded ? ts.ScriptKind.JS : /\.[cm]?tsx?$/.test(input.path) ? /tsx$/.test(input.path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS : ts.ScriptKind.JSX);
    const add = (rule: string, node: ts.Node, message: string) => emit(rule, node.getText(sf), embedded ? offset : offset + node.getStart(sf),
      embedded ? `${message} [Embedded script line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}; source location is the containing template.]` : message, offset + node.getStart(sf));
    // Parse failures fail closed, including malformed embedded JavaScript.
    for (const d of (sf as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics) {
      emit('syntax', source.slice(d.start, d.start + Math.max(1, d.length)), embedded ? offset : offset + d.start, ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    }
    const sdkNames = new Set<string>(), namespaces = new Set<string>(), parsers = new Set<string>(), diagrams = new Set<string>(), sharedNames = new Set<string>();
    const declarations = new Set<ts.Node>();
    const all: ts.Node[] = [];
    function collect(n: ts.Node) {
      all.push(n);
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const module = n.moduleSpecifier.text, clause = n.importClause;
        if (!clause && parser(module)) add('parser-import', n, `Side-effect parser import ${module} requires an exact reviewed purpose.`);
        if (module === 'mermaid' && !clause?.isTypeOnly) { add('diagram-import', n, 'Diagram-only native delegate: review exact import and generated-SVG boundary.'); if (clause?.name) diagrams.add(clause.name.text); }
        if (!clause?.isTypeOnly) {
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) {
            if (e.isTypeOnly) continue;
            const name = (e.propertyName ?? e.name).text;
            declarations.add(e.name);
            if (sdk(module) && name === 'Markdown') { sdkNames.add(e.name.text); add('sdk-markdown', e, 'Use @phosphorco/bb-markdown with captured source and intent.'); }
            if (parser(module)) { parsers.add(e.name.text); add('parser-import', e, `Review exact parser-only purpose for ${module}; UI must use the shared adapter.`); }
            if (shared(module) && name === 'Markdown') sharedNames.add(e.name.text);
          }
          if (clause?.name) {
            declarations.add(clause.name);
            if (parser(module)) { parsers.add(clause.name.text); add('parser-import', n, `Review exact parser-only purpose for ${module}.`); }
            if (sdk(module)) { namespaces.add(clause.name.text); add('sdk-default', n, 'SDK default imports conceal Markdown access; use explicit named imports.'); }
            if (shared(module)) sharedNames.add(clause.name.text);
          }
          if (bindings && ts.isNamespaceImport(bindings)) {
            declarations.add(bindings.name);
            if (sdk(module)) namespaces.add(bindings.name.text);
            if (parser(module)) { parsers.add(bindings.name.text); add('parser-import', n, `Review exact parser-only purpose for ${module}.`); }
            if (shared(module)) add('shared-namespace', n, 'Use the explicit shared Markdown export so source and intent are checked.');
          }
        }
      }
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && n.moduleReference.expression && ts.isStringLiteral(n.moduleReference.expression)) {
        const module = n.moduleReference.expression.text;
        if (sdk(module) || parser(module) || shared(module)) add('renderer-load', n, 'TypeScript import=require renderer loads require explicit ESM boundaries.');
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) {
        const module = n.moduleSpecifier.text;
        if ((sdk(module) && (!n.exportClause || !ts.isNamedExports(n.exportClause) || n.exportClause.elements.some(e => !e.isTypeOnly && (e.propertyName ?? e.name).text === 'Markdown'))) || parser(module))
          add('renderer-reexport', n, 'Do not reexport SDK Markdown or parser implementations.');
      }
      ts.forEachChild(n, collect);
    }
    collect(sf);
    const nativeDependencies = new Set(['safeCodeFence', 'safeMathSource', 'NODE_CHARS']);
    if (input.root === 'community' && input.path === nativePath) {
      // Native delegates are a small defensive module. Pin every top-level helper
      // and limit so extracting a validator cannot make it mutable outside review.
      for (const statement of sf.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) nativeDependencies.add(statement.name.text);
        if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) nativeDependencies.add(d.name.text);
      }
    }
    // Bounded intra-module propagation covers aliases, memo/HOC calls and maps.
    // Cross-module helpers must enter through the shared public entry.
    const contains = (n: ts.Node, names: Set<string>): boolean => {
      if (ts.isIdentifier(n) && names.has(n.text) && isValueReference(n)) return true;
      if (names === sdkNames && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && ts.isIdentifier(unwrap(n.expression)) && namespaces.has((unwrap(n.expression) as ts.Identifier).text)
        && (access(n) === 'Markdown' || access(n) === undefined)) return true;
      let found = false; ts.forEachChild(n, c => { if (contains(c, names)) found = true; }); return found;
    };
    for (let pass = 0; pass < all.length; pass++) {
      let changed = false;
      for (const n of all) if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
        for (const names of [sdkNames, parsers, sharedNames]) {
          if (!names.size && !(names === sdkNames && namespaces.size)) continue;
          const value = unwrap(n.initializer);
          const name = ts.isCallExpression(value) ? ts.isIdentifier(value.expression) ? value.expression.text : access(value.expression) : undefined;
          // A shared consumer may derive its frame from its own domain props.
          // Only component aliases inherit the shared source+intent prop shape;
          // functions containing a shared child keep their own prop contracts.
          if (names === sharedNames && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)
            || ts.isCallExpression(value) && value.arguments.some(a => ts.isArrowFunction(unwrap(a)) || ts.isFunctionExpression(unwrap(a))))) continue;
          const identity = ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)
            || names !== parsers && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
            || ts.isNewExpression(value) || ts.isObjectLiteralExpression(value)
            || ts.isCallExpression(value) && (names === parsers ? name === 'use' || name === 'unified' : /^(?:memo|forwardRef|with[A-Z])/.test(name ?? ''));
          if (identity && !names.has(n.name.text) && contains(value, names)) { names.add(n.name.text); declarations.add(n.name); changed = true; }
        }
      }
      if (!changed) break;
    }
    for (const n of all) {
      if (ts.isCallExpression(n)) {
        const isLoad = n.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(n.expression) && n.expression.text === 'require';
        if (isLoad && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
          const module = n.arguments[0].text;
          if ((sdk(module) && module !== '@get-bb/plugin-sdk/testing/app') || parser(module) || shared(module)) add('renderer-load', n, 'Dynamic/CJS renderer loads require review; use explicit ESM named imports.');
        }
        const name = ts.isIdentifier(n.expression) ? n.expression.text : access(n.expression);
        if (['insertAdjacentHTML', 'parseFromString', 'createContextualFragment', 'setHTML', 'setHTMLUnsafe'].includes(name ?? '') || ['write', 'writeln'].includes(name ?? '') && /^(?:window\.)?document(?:\.|\[)/.test(n.expression.getText(sf))) add('html-sink', n, 'Local HTML parsing/insertion must use a reviewed adapter boundary.');
        if (name === 'setAttribute' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text.toLowerCase() === 'srcdoc') add('html-sink', n, 'Iframe HTML source attributes bypass shared prose rendering.');
        if (name === 'createElement' && n.arguments[0] && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
          const tag = n.arguments[0].getText(sf);
          const attrs = n.arguments[1].properties.map(p => prop(p.name));
          if (sharedNames.has(tag)) {
            if ((!attrs.includes('source') || !attrs.includes('intent')) && !n.arguments[1].properties.some(ts.isSpreadAssignment)) add('shared-context', n, 'Shared Markdown requires captured source and explicit intent.');
          } else if (attrs.some(a => ['content', 'markdown'].includes(a ?? ''))) add('local-prose-component', n, 'Injected createElement prose components must use the shared Markdown contract.');
        }
        if (name === 'createElement' && n.arguments[0] && !ts.isStringLiteralLike(n.arguments[0]) && !ts.isArrowFunction(n.arguments[0]) && !/^[A-Z][\w]*(?:\.[A-Z]\w*)?$/.test(n.arguments[0].getText(sf))) add('dynamic-element', n, 'Dynamic element trees can bypass shared prose rendering; review this exact subtree.');
      }
      if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && ts.isIdentifier(unwrap(n.expression)) && namespaces.has((unwrap(n.expression) as ts.Identifier).text)
        && (access(n) === 'Markdown' || access(n) === undefined)) add('sdk-access', outer(n), 'SDK namespace Markdown/computed access bypasses the shared adapter.');
      if (ts.isIdentifier(n) && isValueReference(n) && namespaces.has(n.text) && !declarations.has(n)) {
        const p = n.parent;
        const staticMember = ts.isPropertyAccessExpression(p) && p.expression === n;
        const literalMember = ts.isElementAccessExpression(p) && p.expression === n && p.argumentExpression && ts.isStringLiteralLike(p.argumentExpression);
        if (!staticMember && !literalMember) add('sdk-namespace-escape', outer(n), 'SDK namespace destructuring/alias/injection conceals Markdown; use explicit named imports.');
      }
      if (ts.isIdentifier(n) && isValueReference(n) && !declarations.has(n) && !(ts.isImportSpecifier(n.parent) || ts.isExportSpecifier(n.parent) && n.parent.isTypeOnly)) {
        if (diagrams.has(n.text)) add('diagram-use', outer(n), 'Review Mermaid configuration/render call as a generated-SVG-only exception.');
        if (sdkNames.has(n.text)) add('sdk-use', outer(n), 'SDK Markdown alias/wrapper/injection must migrate or have exact reviewed debt.');
        if (parsers.has(n.text)) add('parser-use', outer(n), 'Review exact extraction/grammar purpose; parser aliases must not add UI rendering.');
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && ['innerHTML', 'outerHTML', 'srcdoc'].includes(access(n.left) ?? '')) add('html-sink', n, 'Local HTML assignment must use a reviewed adapter boundary.');
      if ((ts.isPropertyAssignment(n) || ts.isJsxAttribute(n)) && ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'srcdoc'].includes(prop(n.name) ?? '')) add('html-sink', n, 'HTML props bypass shared prose rendering.');
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = n.tagName.getText(sf);
        const attrs = n.attributes.properties.filter(ts.isJsxAttribute).map(a => prop(a.name));
        if (sharedNames.has(tag)) {
          if ((!attrs.includes('source') || !attrs.includes('intent')) && !n.attributes.properties.some(ts.isJsxSpreadAttribute)) add('shared-context', n, 'Shared Markdown requires captured source and explicit intent (spread values also require type/runtime proof).');
        } else if (!(input.root === 'community' && input.path === nativePath && sdkNames.has(tag)) && /^[A-Z]/.test(tag) && (/(?:Markdown|MarkdownView)$/.test(tag) || attrs.some(a => ['content', 'markdown'].includes(a ?? '')))) add('local-prose-component', n, 'Prose component injection/wrappers must use the shared Markdown contract.');
      }
      if (input.root === 'community' && input.path === nativePath) {
        if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && (['NativeCodeBlock', 'NativeMath', 'NativeImage', 'safeCodeFence', 'safeMathSource', 'NODE_CHARS'].includes(n.name.getText(sf)) || nativeDependencies.has(n.name.getText(sf)))) add('native-delegate', n, 'Review the defensive technical-leaf function/helper/limit; original prose is not permitted at this boundary.');
        if (ts.isIdentifier(n) && isValueReference(n) && nativeDependencies.has(n.text)) add('native-helper-use', outer(n), 'Review exact native fence/math helper dependencies and mutation/alias sites.');
      }
      if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && (ts.isFunctionDeclaration(n) || !!n.initializer) && /^(?:md|(?:render|parse|compile).*markdown|safeMermaidFence)$/i.test(n.name.getText(sf))) add('local-renderer', n, 'Review this local renderer/code-only delegate boundary; prose must use the shared package.');
      if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
        const text = ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map(s => ' __BB_TEMPLATE_VALUE__ ' + s.literal.text).join('') : n.text;
        if (!embedded && /(?:\b(?:innerHTML|outerHTML|srcdoc)\s*(?:=|:)|\b(?:insertAdjacentHTML|createContextualFragment|setHTMLUnsafe)\s*\(|<script\b|function\s+md\b)/i.test(text)) {
          templates++;
          add('served-template', n, 'Active embedded JavaScript is fingerprinted separately; review template changes and its nested findings.');
          // The outer fingerprint pins all escaping/interpolation. Inner diagnostics
          // anchor to the exact outer token and identify the cooked script line.
          const at = offset + n.getStart(sf) + 1;
          if (/<script\b/i.test(text)) {
            for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) if (match[1]?.trim()) scan(match[1], at + match.index! + match[0].indexOf('>') + 1, true);
          } else scan(text, at, true);
        } else if (/<(?:p|h[1-6]|blockquote|ul|ol|li|table|a)(?:\s|>)/i.test(text)) add('html-template', n, 'HTML prose templates bypass the shared adapter; review this exact literal/template.');
      }
    }
  }
  // These exact shared modules own the complete compiler/native/React policy.
  // Whole-module fingerprints keep helpers, configuration, mutation and aliases
  // inside review even when a particular change adds no recognized syntax.
  if (input.root === 'community' && [grammarPath, nativePath, reactPath].includes(input.path)) emit('shared-policy-boundary', input.source, 0,
    input.path === grammarPath ? 'Review the complete shared server compiler policy: destinations, containment, mapping, sanitization and parser configuration. This is a renderer boundary, not extraction-only.'
      : input.path === reactPath ? 'Review the complete shared prepared-tree React renderer and source/intent admission policy; this is the authoritative shared renderer, not a consumer bypass.'
      : 'Review the complete generated technical-leaf native module policy, helpers, limits, aliases and mutations; original prose is forbidden.');
  if (input.root === 'community' && input.path === oraclePath) emit('technical-oracle-boundary', input.source, 0, 'Review the exact development-only actual-SDK technical oracle: host-source extraction, routing seams, generated wrapper and scratch cleanup; never a shipped prose rendering exception.');
  if (/\.html?$/.test(input.path)) {
    templates++;
    emit('served-template', input.source, 0, 'Served HTML requires exact reviewed coverage.');
    for (const match of input.source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) if (match[1]?.trim()) scan(match[1], match.index! + match[0].indexOf('>') + 1, true);
  } else scan(input.source, 0);
  // Only the native delegate may import the SDK renderer. Its uses/defensive
  // technical-leaf functions still require exact reviewed fingerprints. No blanket
  // exception for HTML sinks, parser code, reexports, namespace or dynamic loads.
  return { findings: findings.filter(f => !(input.root === 'community' && input.path === nativePath && f.rule === 'sdk-markdown')), templates };
}

/** Reads explicit repository roots; never imports consumer source across repos.
 * Deletions pass and are reported in stale. Changed/duplicated subtrees fail.
 */
export function checkSources(options: { roots: SourceRoot[]; debt?: DebtManifest }): GateResult {
  if (!options.roots.length || new Set(options.roots.map(r => r.id)).size !== options.roots.length) throw new Error('Provide nonempty, uniquely named repository roots.');
  const manifest = options.debt ?? { version: 1, entries: [] };
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('Unsupported Markdown debt manifest.');
  const keys = new Set<string>();
  const key = (f: Pick<Finding, 'root' | 'path' | 'rule' | 'sha256'>) => `${f.root}\0${f.path}\0${f.rule}\0${f.sha256}`;
  for (const e of manifest.entries) {
    if (!e.intent?.trim() || !['debt', 'parser-only', 'reviewed-exception'].includes(e.kind) || !Number.isSafeInteger(e.count) || e.count < 1
      || !/^[a-f0-9]{64}$/.test(e.sha256) || e.path.startsWith('/') || e.path.split('/').some(p => p === '..' || /[*?]/.test(p)) || keys.has(key(e))) throw new Error('Invalid or duplicate exact Markdown debt entry.');
    if (['excluded-source-import', 'relative-source-outside-root', 'relative-source-specifier', 'source-symlink'].includes(e.rule)) throw new Error('Production source closure violations cannot be authorized by Markdown debt entries.');
    if (e.kind === 'parser-only' && !['parser-import', 'parser-use', 'local-renderer'].includes(e.rule)) throw new Error('Parser-only intent cannot exempt a rendering/HTML boundary.');
    keys.add(key(e));
  }
  const candidates: Finding[] = [];
  const coverage = { files: 0, templates: 0, excluded: 0, candidates: 0, debt: 0, exceptions: 0, violations: 0, byRule: {} as Record<string, number> };
  for (const root of options.roots) {
    const base = resolve(root.path), visited = new Set<string>();
    const queue: string[] = [];
    const MAX_CLOSURE_FILES = 20_000;
    const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
    const generatedDependencies = new Set(['node_modules', 'dist', 'build', 'artifacts', '.git']);
    const excludedPath = (path: string) => path.split('/').some(p => (exclusions.has(p) && !generatedDependencies.has(p)) || p.startsWith('.'))
      || /\.(?:test|spec|fixture)\.[cm]?[jt]sx?$/.test(path);
    const sourcePath = (file: string) => relative(base, file).split('\\').join('/');
    const record = (path: string, source: string, at: number, rule: string, text: string, message: string) => {
      const prefix = source.slice(0, at);
      candidates.push({root: root.id, path, line: prefix.split('\n').length,
        column: at - prefix.lastIndexOf('\n'), rule, sha256: sourceFingerprint(text), excerpt: text.replace(/\s+/g, ' ').slice(0,180), message});
    };
    function enqueue(file: string) {
      const normalized = resolve(file);
      if (visited.has(normalized)) return;
      visited.add(normalized);
      if (visited.size > MAX_CLOSURE_FILES) throw new Error(`Markdown production source closure exceeds ${MAX_CLOSURE_FILES} files at ${base}; review source roots.`);
      queue.push(normalized);
    }
    function walk(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(dir, e.name), path = sourcePath(file);
        if (exclusions.has(e.name) || e.name.startsWith('.')) { coverage.excluded++; continue; }
        if (e.isSymbolicLink()) {
          const target = readlinkSync(file);
          record(path, '', 0, 'source-symlink', target, 'Production source symlinks require review; source coverage does not traverse them.');
        } else if (e.isDirectory()) walk(file);
        else if (extension.test(e.name) && !/\.d\.[cm]?ts$|\.(?:test|spec|fixture)\.[cm]?[jt]sx?$/.test(e.name)) enqueue(file);
      }
    }
    let sourceRoots = 0;
    for (const part of ['plugins', 'packages', 'shared']) {
      const entry = readdirSync(base, { withFileTypes: true }).find(e => e.name === part && e.isDirectory());
      if (entry) { sourceRoots++; walk(join(base, part)); }
    }
    if (!sourceRoots) throw new Error(`No plugins/, packages/ or shared/ source directories at ${base}. Pass repository roots, not the workspace parent.`);
    function resolveRelative(file: string, specifier: string): string | undefined {
      const target = resolve(dirname(file), specifier), ext = extname(target);
      const variants = [target];
      // Bundlers/TS commonly resolve authored .js specifiers to TS source.
      if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        const stem = target.slice(0, -ext.length);
        variants.push(...(ext === '.mjs' ? ['.mts'] : ext === '.cjs' ? ['.cts'] : ['.ts', '.tsx']).map(e => stem + e));
      }
      if (!ext) variants.push(...sourceExtensions.map(e => target + e), ...sourceExtensions.map(e => join(target, 'index' + e)));
      for (const candidate of variants) if (existsSync(candidate) && !lstatSync(candidate).isDirectory()) return candidate;
      return undefined;
    }
    for (let index = 0; index < queue.length; index++) {
      const file = queue[index]!, path = sourcePath(file), source = readFileSync(file, 'utf8');
      coverage.files++;
      const result = inspectSource({root: root.id, path, source});
      coverage.templates += result.templates; candidates.push(...result.findings);
      if (/\.html?$/.test(file)) continue;
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function edge(specifier: string, node: ts.Node) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) return;
        const text = node.getText(sf), at = node.getStart(sf);
        let localSpecifier: string;
        try { localSpecifier = decodeURIComponent(specifier.split(/[?#]/, 1)[0]!); }
        catch { record(path, source, at, 'relative-source-specifier', text, 'Invalid encoded relative runtime module path requires review.'); return; }
        const target = resolve(dirname(file), localSpecifier), requestedPath = sourcePath(target);
        // JSON/CSS/image fixtures are data, not executable rendering modules.
        // Generated outputs/dependencies retain the declared source-only boundary.
        if (extname(target) && !extension.test(target)) return;
        if (requestedPath.split('/').some(p => generatedDependencies.has(p))) return;
        if (requestedPath === '..' || requestedPath.startsWith('../')) {
          record(path, source, at, 'relative-source-outside-root', text, `Relative runtime source ${specifier} leaves the explicit repository root; provide a package boundary instead.`); return;
        }
        if (excludedPath(requestedPath)) {
          record(path, source, at, 'excluded-source-import', text, `Production runtime dependency ${specifier} enters excluded source ${requestedPath}; move it to reviewed production source.`); return;
        }
        const resolved = resolveRelative(file, localSpecifier);
        if (!resolved) return; // Non-source assets/external resolution remain build-owned.
        const resolvedPath = sourcePath(resolved);
        if (excludedPath(resolvedPath)) {
          record(path, source, at, 'excluded-source-import', text, `Production runtime dependency ${specifier} resolves to excluded source ${resolvedPath}.`); return;
        }
        // Do not traverse source symlinks (including an intermediate directory).
        let current = base;
        for (const segment of resolvedPath.split('/')) {
          current = join(current, segment);
          if (lstatSync(current).isSymbolicLink()) {
            record(path, source, at, 'source-symlink', text, `Runtime dependency ${specifier} traverses source symlink ${sourcePath(current)}; review the source boundary.`); return;
          }
        }
        if (extension.test(resolved) && !/\.d\.[cm]?ts$/.test(resolved)) enqueue(resolved);
      }
      function visit(n: ts.Node) {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && !n.importClause?.isTypeOnly) {
          const bindings = n.importClause?.namedBindings;
          if (!(bindings && ts.isNamedImports(bindings) && !n.importClause?.name && bindings.elements.length > 0 && bindings.elements.every(e => e.isTypeOnly))) edge(n.moduleSpecifier.text, n);
        }
        if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
          if (!(n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.length > 0 && n.exportClause.elements.every(e => e.isTypeOnly))) edge(n.moduleSpecifier.text, n);
        }
        if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(n.expression) && n.expression.text === 'require') && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) edge(n.arguments[0].text, n);
        if (ts.isImportEqualsDeclaration(n) && !n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference) && n.moduleReference.expression && ts.isStringLiteral(n.moduleReference.expression)) edge(n.moduleReference.expression.text, n);
        ts.forEachChild(n, visit);
      }
      visit(sf);
    }
  }
  const counts = new Map<string, number>(), entries = new Map(manifest.entries.map(e => [key(e), e]));
  const findings: Finding[] = [], debt: Finding[] = [], exceptions: Finding[] = [];
  for (const f of candidates) {
    coverage.byRule[f.rule] = (coverage.byRule[f.rule] ?? 0) + 1;
    const k = key(f), count = (counts.get(k) ?? 0) + 1; counts.set(k, count);
    const entry = entries.get(k);
    if (!entry || count > entry.count) findings.push(f);
    else if (entry.kind === 'debt') debt.push(f);
    else exceptions.push(f);
  }
  const rootIds = new Set(options.roots.map(r => r.id));
  const stale = manifest.entries.filter(e => rootIds.has(e.root) && (counts.get(key(e)) ?? 0) < e.count);
  coverage.candidates = candidates.length; coverage.debt = debt.length; coverage.exceptions = exceptions.length; coverage.violations = findings.length;
  return { ok: !findings.length, findings, debt, exceptions, stale, coverage };
}

// Exported metadata keeps CLI/report consumers honest about the intended boundary.
export const sourceGateCoverage = {
  version: 1, grammarPath, nativePath, reactPath, oraclePath,
  includes: 'plugins/, packages/, shared/ seeds plus in-root relative runtime source closure: TS/TSX/JS/JSX/MJS/CJS/CTS/MTS, active vendor and served HTML/script templates',
  excludes: [...exclusions],
  limits: 'Bounded relative runtime source closure (20,000 files/root) plus syntax/intra-module aliases; computed module names, bare-module/package resolution, cross-module value flow, renamed hand-built DOM/text renderers and runtime-generated code require review. Spread source/intent values require type/runtime conformance. Embedded diagnostics anchor to the exact containing template plus a cooked script line; interpolation assembly is not evaluated.',
} as const;
