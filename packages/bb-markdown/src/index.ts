import { z } from 'zod';

/** All limits are owner-local. No clock, SDK, parser or React enters this entry. */
export const MARKDOWN_LIMITS = Object.freeze({ requests: 16, textChars: 1_048_576, parseChars: 262_144, recognitionChars: 65_536, sources: 128, metadata: 256, resources: 256, cacheChars: 4_194_304, inflight: 64, concurrency: 4, metadataMs: 1500, enrichMs: 6000, treeNodes: 8192, treeDepth: 32, treeBytes: 2_097_152 });
const token = z.string().min(1).max(256).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const threadId = z.string().regex(/^thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);
const projectId = z.string().regex(/^proj_[a-z0-9]+$/).max(128);
const environmentId = z.string().regex(/^env_[a-z0-9]+$/).max(128);
export const MarkdownSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread-message'), instance: z.literal('local'), threadId, messageId: token, revision: token, projectId: projectId.optional(), environmentId: environmentId.optional() }).strict(),
  z.object({ kind: z.literal('detached'), producer: token, sourceKey: token, revision: token, origin: z.enum(['foreign', 'unknown']) }).strict(),
]);
export type MarkdownSource = z.infer<typeof MarkdownSourceSchema>;
export const MarkdownRequestSchema = z.object({ source: MarkdownSourceSchema, intent: z.literal('prose'), content: z.string().max(MARKDOWN_LIMITS.textChars) }).strict();
export type MarkdownRequest = z.infer<typeof MarkdownRequestSchema>;
export const MarkdownPrepareInputSchema = z.object({ phase: z.enum(['base', 'enrich']), requests: z.array(MarkdownRequestSchema).max(MARKDOWN_LIMITS.requests) }).strict();
export type MarkdownPrepareInput = z.infer<typeof MarkdownPrepareInputSchema>;
export interface MarkdownDiagnostic { code: string; message: string }
export interface MarkdownDocument { threadId: string; rootPath: string; target: { kind: 'workspace'; environmentId: string; path: string } }
export interface PreparedMarkdown {
  key: string;
  source: MarkdownSource | null;
  intent: 'prose';
  original: string;
  content: string;
  format: 'markdown' | 'literal';
  phase: 'base' | 'enrich';
  status: 'ready' | 'partial' | 'invalid';
  /** null requires a supported inert adapter or literal text; never delegate with ambient routing. */
  document: MarkdownDocument | null;
  tree: MarkdownTree | null;
  diagnostics: MarkdownDiagnostic[];
}
/** Exact, unambiguous browser demand identity. Server caches hash these bytes. */
export function markdownRequestKey(request: MarkdownRequest): string {
  const parsed = MarkdownRequestSchema.parse(request);
  return JSON.stringify([parsed.source, parsed.intent, parsed.content]);
}
/** Immediate readable fallback; callers render literal content as text, never Markdown. */
export function createLiteralMarkdown(request: MarkdownRequest): PreparedMarkdown {
  const decoded = MarkdownRequestSchema.safeParse(request);
  const original = typeof request?.content === 'string' ? request.content : '';
  return { key: decoded.success ? markdownRequestKey(decoded.data) : JSON.stringify(['invalid', original]), source: decoded.success ? decoded.data.source : null, intent: 'prose', original, content: original, format: 'literal', phase: 'base', status: decoded.success ? 'partial' : 'invalid', document: null, tree: null, diagnostics: [{ code: decoded.success ? 'unprepared' : 'invalid-request', message: decoded.success ? 'Source validation has not completed.' : 'A valid source and prose intent are required.' }] };
}

export const MarkdownDiagnosticSchema = z.object({ code: z.string().min(1).max(128), message: z.string().max(512) }).passthrough();
export const MarkdownDocumentSchema = z.object({ threadId, rootPath: z.string().min(1).max(4096).refine(value=>value.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(value)), target: z.object({ kind: z.literal('workspace'), environmentId, path: z.string().min(1).max(4096) }).strict() }).strict();
export const MARKDOWN_TAGS = ['a','b','blockquote','br','code','dd','del','details','div','dl','dt','em','h1','h2','h3','h4','h5','h6','hr','i','input','ins','kbd','li','ol','p','picture','q','rp','rt','ruby','s','samp','section','small','span','strike','strong','sub','summary','sup','table','tbody','td','th','thead','tr','tt','ul','var'] as const;
export type MarkdownTag = typeof MARKDOWN_TAGS[number];
export interface MarkdownFileTarget { kind: 'workspace'; environmentId: string; path: string }
export interface MarkdownFileLocation { kind: 'range'; startLine: number; endLine: number }
export type MarkdownNode =
  | { kind: 'text'; value: string }
  | { kind: 'element'; tag: MarkdownTag; children: MarkdownNode[]; href?: string; title?: string; start?: number; checked?: boolean; align?: 'left'|'center'|'right'; colSpan?: number; rowSpan?: number }
  | { kind: 'file'; target: MarkdownFileTarget; children: MarkdownNode[]; title?: string; location?: MarkdownFileLocation }
  | { kind: 'image'; src: string; alt: string; title?: string }
  | { kind: 'local-image'; target: MarkdownFileTarget; alt: string; title?: string }
  | { kind: 'code-block'; value: string; language?: string }
  | { kind: 'math'; value: string; display: boolean };
export interface MarkdownTree { version: 1; children: MarkdownNode[] }
const outputHref = z.string().max(8192).refine(value => {
  if (/[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  if (/^\/projects\/proj_[a-z0-9]+\/threads\/thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}(?:[?#][^\s\\<>]*)?$/u.test(value) || /^#[^\s\\]*$/u.test(value)) return true;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password; } catch { return false; }
});
const childrenSchema = z.array(z.unknown()).max(MARKDOWN_LIMITS.treeNodes);
const titleSchema = z.string().max(4096).optional();
export const MarkdownFileTargetSchema = z.object({kind:z.literal('workspace'),environmentId,path:z.string().min(1).max(4096).refine(value=>!value.startsWith('/')&&!/[\\\u0000-\u001f\u007f:?%#]/u.test(value)&&!value.split('/').some(part=>part==='..'||part==='.'||!part))}).strict();
const nodeEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('text'),value:z.string().max(MARKDOWN_LIMITS.textChars)}).strict(),
  z.object({kind:z.literal('element'),tag:z.enum(MARKDOWN_TAGS),children:childrenSchema,href:outputHref.optional(),title:titleSchema,start:z.number().int().min(0).max(1_000_000).optional(),checked:z.boolean().optional(),align:z.enum(['left','center','right']).optional(),colSpan:z.number().int().min(1).max(1000).optional(),rowSpan:z.number().int().min(1).max(1000).optional()}).strict(),
  z.object({kind:z.literal('file'),target:MarkdownFileTargetSchema,children:childrenSchema,title:titleSchema,location:z.object({kind:z.literal('range'),startLine:z.number().int().min(1).max(10_000_000),endLine:z.number().int().min(1).max(10_000_000)}).strict().refine(value=>value.endLine>=value.startLine).optional()}).strict(),
  z.object({kind:z.literal('local-image'),target:MarkdownFileTargetSchema,alt:z.string().max(4096),title:titleSchema}).strict(),
  z.object({kind:z.literal('image'),src:outputHref.refine(value=>/^https?:/u.test(value)),alt:z.string().max(4096),title:titleSchema}).strict(),
  z.object({kind:z.literal('code-block'),value:z.string().max(MARKDOWN_LIMITS.parseChars),language:z.string().regex(/^[a-zA-Z0-9_+-]{1,64}$/u).optional()}).strict(),
  z.object({kind:z.literal('math'),value:z.string().max(16384),display:z.boolean()}).strict(),
]);
function validNodes(nodes: unknown[], initialDepth=1): boolean {
  const pending=nodes.map(node=>({node,depth:initialDepth}));let count=0;
  while(pending.length){const {node,depth}=pending.pop()!;if(++count>MARKDOWN_LIMITS.treeNodes||depth>MARKDOWN_LIMITS.treeDepth)return false;
    const result=nodeEnvelopeSchema.safeParse(node);if(!result.success)return false;
    if('children' in result.data)for(const child of result.data.children)pending.push({node:child,depth:depth+1});
  }
  return true;
}
export const MarkdownNodeSchema = z.custom<MarkdownNode>(value=>validNodes([value]),'Invalid or unbounded Markdown node.');
export const MarkdownTreeSchema = z.custom<MarkdownTree>(value=>{
  const root=z.object({version:z.literal(1),children:childrenSchema}).strict().safeParse(value);if(!root.success||!validNodes(root.data.children))return false;
  try{return new TextEncoder().encode(JSON.stringify(value)).length<=MARKDOWN_LIMITS.treeBytes;}catch{return false;}
},'Invalid or unbounded Markdown tree.');
export const PreparedMarkdownSchema = z.object({
  key: z.string().max(MARKDOWN_LIMITS.textChars * 6 + 4096), source: MarkdownSourceSchema.nullable(), intent: z.literal('prose'),
  original: z.string().max(MARKDOWN_LIMITS.textChars), content: z.string().max(MARKDOWN_LIMITS.textChars * 2),
  format: z.enum(['markdown', 'literal']), phase: z.enum(['base', 'enrich']), status: z.enum(['ready', 'partial', 'invalid']),
  document: MarkdownDocumentSchema.nullable(), tree: MarkdownTreeSchema.nullable(), diagnostics: z.array(MarkdownDiagnosticSchema).max(32),
}).passthrough().superRefine((value,ctx)=>{
  const issue=(message:string)=>ctx.addIssue({code:'custom',message});
  if(value.format==='markdown'?value.tree===null:value.tree!==null)issue('Formatted Markdown requires a bounded prepared tree.');
  if(value.source){
    if(value.key!==markdownRequestKey({source:value.source,intent:'prose',content:value.original}))issue('Prepared source identity does not match original content.');
  }else if(value.tree||value.document||value.format!=='literal'||value.status!=='invalid')issue('Invalid source must remain literal and inert.');
  if(value.document){
    if(value.source?.kind!=='thread-message'||value.document.threadId!==value.source.threadId||(value.source.environmentId&&value.document.target.environmentId!==value.source.environmentId))issue('Document does not belong to the asserted local source frame.');
  }
  const pending=[...(value.tree?.children??[])];
  while(pending.length){const node=pending.pop()!;
    if((node.kind==='file'||node.kind==='local-image')&&(!value.document||value.source?.kind!=='thread-message'||node.target.environmentId!==value.document.target.environmentId))issue('File and local-image targets require the validated source document environment.');
    if('children' in node)pending.push(...node.children);
  }
});
export const MarkdownPrepareOutputSchema = z.array(PreparedMarkdownSchema).max(MARKDOWN_LIMITS.requests);
