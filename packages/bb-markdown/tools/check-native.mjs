import { createRequire } from 'node:module';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Test-only source oracle. Never imported by a package runtime entry.
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(pkg, '../../..');
const host = resolve(process.env.BB_NATIVE_HOST_ROOT ?? resolve(workspace, 'fork/build/bb'));
const app = resolve(host, 'apps/app');
const requireHost = createRequire(resolve(app, 'package.json'));
let jsdomPath;
try { jsdomPath = requireHost.resolve('jsdom'); }
catch {
  const candidate = (await readdir(resolve(host, 'node_modules/.pnpm'))).find(name=>name.startsWith('jsdom@'));
  if (!candidate) throw Error('Native oracle requires the already-installed host jsdom dependency; it never installs dependencies.');
  jsdomPath = requireHost.resolve(resolve(host, 'node_modules/.pnpm', candidate, 'node_modules/jsdom'));
}
const { build } = createRequire(resolve(host, 'package.json'))('esbuild');
const ts=createRequire(resolve(app,'package.json'))('typescript');
const impl=await readFile(resolve(app,'src/lib/plugin-sdk-app-impl.tsx'),'utf8');
const ast=ts.createSourceFile('plugin-sdk-app-impl.tsx',impl,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const markdownFunction=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='PluginMarkdown');
if(!markdownFunction) throw Error('Actual host PluginMarkdown function was not found; refusing substitute implementation.');
const wrapperSource=`import {useCallback,useMemo} from 'react';
import {MarkdownPreview} from '@native/preview';
import {buildMarkdownMessageLinkRouting} from '@native/message';
import {buildMarkdownDocumentLinkRouting} from '@native/document';
const useThreadTimelineNavigation=()=>globalThis.__nativeTimeline;
const useAppNavigationHost=()=>globalThis.__nativeNavigation;
${markdownFunction.getText(ast)}
export function Markdown(props){globalThis.__nativeDelegated.push(props);return <PluginMarkdown {...props}/>;}
export function useRpc(){throw Error('Plugin transport hook is outside the injected-transport native oracle');}
export function useRealtimeConnectionState(){throw Error('Realtime hook is outside the native oracle');}
export function experimental_FileLink({target,location,children,...props}){
 globalThis.__nativePublicFiles.push({target,location});
 return <a {...props} data-oracle-sdk="FileLink" href={'file://oracle.invalid/'+encodeURIComponent(target.path)} onClick={event=>{event.preventDefault();globalThis.__nativePublicActions.push({kind:'file',target,location});}}>{children}</a>;
}
export function UrlLink({href,children,...props}){
 globalThis.__nativePublicUrls.push(href);
 return <a {...props} data-oracle-sdk="UrlLink" href={href} onClick={event=>{event.preventDefault();globalThis.__nativePublicActions.push({kind:'url',href});}}>{children}</a>;
}`;
const scratch = await mkdtemp(resolve(process.env.BB_THREAD_STORAGE ?? '/tmp', 'native-oracle-'));
const seams = {
  '@/hooks/useTheme': 'export const usePreferredTheme = () => "light";',
  '@/hooks/useAppTheme': 'export const useAppThemeEpoch = () => 0;',
  '@/lib/localhost-link-rewrite-preference': 'export const useRewriteLocalhostLinksPreference=()=>[false,()=>{}]; export const rewriteLocalhostLinkHref=({href})=>href;',
  '@/lib/clipboard': 'export const useClipboardCopy=({text})=>({copied:false,copy:async()=>{globalThis.__nativeCopied=text;}});',
  '@/components/workspace-open-target/WorkspaceOpenTargetIcon': 'export const WorkspaceOpenTargetIcon=()=>null;',
  '@/components/plugin/PluginSlotMount': 'export const PluginSlotMount=()=>{throw Error("No plugin mounts in native oracle")};',
  '@/components/plugin/plugin-thread-panel-navigation': 'export const PluginThreadPanelNavigationProvider=({children})=>children;',
  '@/lib/plugin-slot-resolvers': 'export const resolveCodeFenceRendererRegistry=()=>new Map(); export const resolveMessageDirectiveRegistry=()=>new Map();',
  '@/components/thread/timeline/ConversationMessageMentions': 'export const PromptMentionPill=()=>null; export const MessageMentionPill=()=>null; export const resolveThreadMentionResource=()=>null;',
  '@/components/thread/ThreadTitleMentions': 'export const RawThreadMentionBatchProvider=({children})=>children; export const useRawThreadMentionResources=()=>new Map(); export const useRawThreadMentionResource=()=>null; export const useSidebarThreadMentionResource=()=>null; export const useThreadMentionResource=()=>null; export const isMentionBoundary=()=>true; export const isMentionEndBoundary=()=>true; export const isRawThreadIdBoundary=()=>true; export const isRawThreadIdEndBoundary=()=>true;',
  './app-route-anchor.js': 'import {createElement} from "react"; export const RouteAnchor=props=>createElement("a",props);',
  './image-lightbox.js': 'export const ImageLightbox=()=>null; export const getWrappedImageIndex=()=>0;',
  './markdown-mermaid-loader.js': 'export const loadMermaid=()=>{throw Error("SVG layout is outside the DOM oracle")};',
};
try {
  const outfile = resolve(scratch, 'native.test.cjs');
  await build({
    entryPoints: [resolve(pkg, 'test/native.test.mjs')], outfile,
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    conditions: ['source'], loader: { '.css': 'empty' }, logLevel: 'warning',
    define: { 'import.meta.url': JSON.stringify(new URL('../test/native.test.mjs',import.meta.url).href), 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    plugins: [{ name: 'native-oracle-only', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        const key = args.path.replace(/\.js$/, '');
        const seam = seams[args.path] ?? seams[key];
        if (seam) return { path: args.path, namespace: 'oracle-seam', pluginData: seam };
        if(args.path==='@get-bb/plugin-sdk/app') return {path:args.path,namespace:'actual-sdk-wrapper'};
        if(args.path==='@native/technical') return {path:resolve(pkg,'src/native.tsx')};
        if(args.path==='@native/adapter') return {path:resolve(pkg,'src/react.tsx')};
        if(args.path==='@native/server') return {path:resolve(pkg,'src/server.ts')};
        if(args.path==='@native/browser-sdk') return {path:resolve(host,'packages/sdk/src/browser.ts')};
        if (args.path === '@native/preview') return {path: resolve(app, 'src/components/ui/markdown-preview.tsx')};
        if (args.path === '@native/document') return {path: resolve(app, 'src/components/ui/markdown-document-link-routing.ts')};
        if (args.path === '@native/message') return {path: resolve(app, 'src/components/ui/markdown-message-link-routing.ts')};
        if (args.path === '@native/html') return {path: resolve(app, 'src/components/ui/lazy-markdown-html.tsx')};
        if (args.path === '@native/context') return {path: resolve(app, 'src/components/ui/markdown-link-routing.ts')};
        if (args.path === '@native/root') return {path: args.path, namespace:'oracle-root'};
        if (/^(react(?:\/.+)?|react-dom(?:\/.+)?|jsdom)$/.test(args.path)) return {path: args.path === 'jsdom' ? jsdomPath : requireHost.resolve(args.path), external:true};
        if (args.path.startsWith('@/')) return b.resolve(args.path.replace('@/', resolve(app, 'src') + '/'), {kind:args.kind,resolveDir:app});
        return null;
      });
      b.onLoad({filter:/.*/, namespace:'oracle-seam'}, args=>({contents:args.pluginData, loader:'jsx',resolveDir:app}));
      b.onLoad({filter:/\/markdown-katex-loader\.ts$/},async args=>{
        const source=await readFile(args.path,'utf8');
        const needle='rehypeKatexImportPromise = import("./markdown-katex.js")';
        if(!source.includes(needle))throw Error('Actual math loader import boundary changed; refusing a substitute renderer.');
        return {contents:source.replace(needle,'rehypeKatexImportPromise = (globalThis.__nativeHoldMath ? new Promise(() => {}) : import("./markdown-katex.js"))'),loader:'ts',resolveDir:dirname(args.path)};
      });
      b.onLoad({filter:/.*/, namespace:'actual-sdk-wrapper'}, ()=>({contents:wrapperSource,loader:'tsx',resolveDir:app}));
      b.onLoad({filter:/.*/, namespace:'oracle-root'}, ()=>({contents:`export const hostRoot=${JSON.stringify(host)}; export const packageRoot=${JSON.stringify(pkg)}; export const environmentSeams=${JSON.stringify(Object.keys(seams))};`}));
    }}],
  });
  const childEnv={...process.env,BB_NATIVE_ORACLE_BUNDLED:'1'};
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), outfile], { stdio: 'inherit', env:childEnv, timeout:30_000, killSignal:'SIGKILL' });
  if(result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} finally {
  await rm(scratch, { recursive:true, force:true });
}
