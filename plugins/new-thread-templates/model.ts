import { z } from 'zod';
import { nativeSubmissionSchema, nativeEditorSeedSchema } from './native-submission';
import type { Codec, PluginId } from '@phosphorco/bb-identity/model';
import type { StateResource } from '@phosphorco/bb-identity/state';

export const PLUGIN_ID = 'new-thread-templates';
const id = z.string().min(1).max(120);
export const inputValueSchema = z.union([z.string().max(100000), z.number().finite(), z.boolean()]);
export const INPUT_BYTES_LIMIT=64*1024;
export const RENDER_BYTES_LIMIT=256*1024;
const bytes=(s:string)=>new TextEncoder().encode(s).length;
export const inputsSchema = z.record(z.string(), inputValueSchema).superRefine((value,ctx)=>{if(bytes(JSON.stringify(value))>INPUT_BYTES_LIMIT)ctx.addIssue({code:'custom',message:'Total input exceeds the 64 KiB limit'});});
export type Inputs = z.infer<typeof inputsSchema>;
export const fieldSchema = z.object({
  key: z.string().max(80), label: z.string().max(200),
  type: z.enum(['text', 'textarea', 'url', 'number', 'select', 'checkbox']),
  order: z.number().int(), help: z.string().max(2000).optional(), required: z.boolean().default(false),
  default: inputValueSchema.optional(), options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).max(100).optional(),
  validation: z.object({ min: z.number().optional(), max: z.number().optional(), minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional() }).strict().optional(),
}).strict();
export type TemplateField = z.infer<typeof fieldSchema>;
export const environmentPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project-default') }).strict(),
  z.object({ kind: z.literal('reuse'), environmentId: z.string() }).strict(),
  z.object({ kind: z.literal('local-source'), branch: z.string().optional() }).strict(),
  z.object({ kind: z.literal('worktree'), baseBranch: z.string() }).strict(),
]);
export const destinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing-project'), projectId: z.string(), hostId:z.string().min(1).max(1000).optional(), environment: environmentPolicySchema }).strict(),
  z.object({ kind: z.literal('choose-at-launch'), hostId:z.string().min(1).max(1000).optional(), environment: environmentPolicySchema }).strict(),
  z.object({ kind: z.literal('new-project'), nameTemplate: z.string(), hostId: z.string(), path: z.string(), environment: environmentPolicySchema }).strict(),
]);
export const executionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project-default') }).strict(),
  z.object({ kind: z.literal('explicit'), providerId: z.string(), model: z.string(), reasoningLevel: z.string().optional(), serviceTier: z.string().optional() }).strict(),
]);
export const definitionSchema = z.object({
  id, name: z.string().max(200), description: z.string().max(2000), fields: z.array(fieldSchema).max(50),
  destination: destinationSchema, execution: executionSchema,
  titleTemplate: z.string().max(1000), promptTemplate: z.string().max(100000),
}).strict();
export type TemplateDefinition = z.infer<typeof definitionSchema>;
export const actorSchema = z.object({ key: z.string(), name: z.string() }).strict();
export type TemplateActor = z.infer<typeof actorSchema>;
export const revisionSchema = z.object({ templateId: id, revision: z.number().int().positive(), definition: definitionSchema, publishedAt: z.number(), publishedBy: actorSchema }).strict();
export type PublishedRevision = z.infer<typeof revisionSchema>;
export const draftSchema = z.object({ templateId: id, generation: z.number().int().nonnegative(), definition: definitionSchema, editedAt: z.number(), editedBy: actorSchema }).strict();
export type EditorDraft = z.infer<typeof draftSchema>;
export const entrySchema = z.object({ id, draft: draftSchema.nullable(), published: revisionSchema.nullable(), latestRevision: z.number().int() }).strict();
export type TemplateEntry = z.infer<typeof entrySchema>;
export const issueSchema = z.object({ path: z.string(), message: z.string() }).strict();
export type ValidationIssue = z.infer<typeof issueSchema>;
export const nativeEditorOriginSchema=z.object({
  editorDraftId:z.string().uuid(),instanceId:z.string(),actor:z.string(),templateId:id,revision:z.number().int().positive(),
  inputs:inputsSchema,projectId:z.string().optional(),seed:nativeEditorSeedSchema,title:z.string(),createdAt:z.number(),
}).strict();
export type NativeEditorOrigin=z.infer<typeof nativeEditorOriginSchema>;
export const nativeOperationSchema=z.object({
  templateId:id,revision:z.number().int().positive(),inputs:inputsSchema,projectId:z.string().optional(),nativeSubmission:nativeSubmissionSchema,
}).strict();
// Saved before dispatch; lifecycle freshness is supplied separately when explicitly resuming.
export const launchRequestSchema = z.object({ operationId: z.string().uuid(), templateId: id, revision: z.number().int().positive(), inputs: inputsSchema, projectId: z.string().optional(), expectedActor: z.string().min(1), expectedSession: z.string().min(1),nativeSubmission:nativeSubmissionSchema.optional() }).strict();
export type LaunchRequest = z.infer<typeof launchRequestSchema>;
export const launchCheckpointSchema=z.object({version:z.literal(1),request:launchRequestSchema}).strict();
export type LaunchCheckpoint=z.infer<typeof launchCheckpointSchema>;
export const personalDraftSchema = z.object({ inputs: inputsSchema, projectId: z.string().optional(), operationId: z.string().optional(), revision: z.number().int().optional(),nativeEditor:nativeEditorOriginSchema.optional(),nativeOperation:nativeOperationSchema.optional(),launchCheckpoint:launchCheckpointSchema.optional() }).strict();
export type PersonalDraft = z.infer<typeof personalDraftSchema>;
export function schemaCodec<T>(schema: z.ZodType<T>): Codec<T> {
  return { decode(value) { const r = schema.safeParse(value); return r.success ? { ok: true, value: r.data } : { ok: false, error: { code: 'invalid-input', message: r.error.message, retry: 'never' } }; }, encode(value) { return JSON.parse(JSON.stringify(schema.parse(value))); } };
}
export const inputDraftResource: StateResource<PersonalDraft> = {
  pluginId: PLUGIN_ID as PluginId,
  definition: { collection: 'input-drafts', schemaVersion: 1, codec: schemaCodec(personalDraftSchema), initialValue: () => ({ inputs: {} }), equal: (a,b) => JSON.stringify(a) === JSON.stringify(b) },
};
export function emptyDefinition(templateId: string): TemplateDefinition {
  return { id: templateId, name: '', description: '', fields: [], destination: { kind: 'choose-at-launch', environment: { kind: 'project-default' } }, execution: { kind: 'project-default' }, titleTemplate: '', promptTemplate: '' };
}
export function defaultInputs(definition: TemplateDefinition): Inputs {
  return Object.fromEntries(definition.fields.filter(f => f.default !== undefined || f.type === 'checkbox').map(f => [f.key, f.default ?? false]));
}
// Tokens support {{field}} and a literal fallback {{field|fallback}}. No evaluation.
const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)(?:\|([^{}]*))?\s*\}\}/g;
export function renderText(template: string, inputs: Inputs,limit=RENDER_BYTES_LIMIT): string {
  let size=bytes(template);if(size>limit)throw new Error('Rendered text exceeds the size limit');
  return template.replace(TOKEN, (all, key: string, fallback: string | undefined) => {
    const value = inputs[key];const replacement=value === undefined || value === '' ? (fallback ?? '') : String(value);
    size+=bytes(replacement)-bytes(all);if(size>limit)throw new Error('Rendered text exceeds the size limit');return replacement;
  });
}
export function validateInputs(definition: TemplateDefinition, submitted: Inputs): { inputs: Inputs; issues: ValidationIssue[] } {
  const inputs = { ...defaultInputs(definition), ...submitted }; const issues: ValidationIssue[] = [];
  if(bytes(JSON.stringify(submitted))>INPUT_BYTES_LIMIT)issues.push({path:'inputs',message:'Total input exceeds the 64 KiB limit'});
  const keys = new Set(definition.fields.map(f=>f.key));
  for (const key of Object.keys(submitted)) if (!keys.has(key)) issues.push({ path: key, message: 'Unknown field' });
  for (const f of definition.fields) {
    const v = inputs[f.key]; const absent = v === undefined || v === '';
    const error = (message: string) => issues.push({ path: f.key, message });
    if (absent) { if (f.required) error('Required'); continue; }
    if (f.type === 'checkbox') { if (typeof v !== 'boolean') error('Choose checked or unchecked'); }
    else if (f.type === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) error('Enter a finite number'); }
    else if (typeof v !== 'string') error('Enter text');
    if (f.type === 'url' && typeof v === 'string') { try { const u = new URL(v); if (!['https:', 'http:'].includes(u.protocol)) error('Use an HTTP or HTTPS URL'); } catch { error('Enter a valid URL'); } }
    if (f.type === 'select' && !f.options?.some(o=>o.value === v)) error('Choose an available option');
    if (typeof v === 'number') { if (f.validation?.min !== undefined && v < f.validation.min) error(`Minimum ${f.validation.min}`); if (f.validation?.max !== undefined && v > f.validation.max) error(`Maximum ${f.validation.max}`); }
    if (typeof v === 'string') { if (f.validation?.minLength !== undefined && v.length < f.validation.minLength) error(`Minimum length ${f.validation.minLength}`); if (f.validation?.maxLength !== undefined && v.length > f.validation.maxLength) error(`Maximum length ${f.validation.maxLength}`); }
  }
  return { inputs, issues };
}
export function validateDefinition(definition: TemplateDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = []; const add=(path:string,message:string)=>issues.push({path,message});
  if (!definition.name.trim()) add('name','Name is required');
  if (!definition.promptTemplate.trim()) add('promptTemplate','First message is required');
  const keys = new Set<string>();
  for (const [i,f] of definition.fields.entries()) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.key) || ['__proto__','constructor','prototype'].includes(f.key)) add(`fields.${i}.key`,'Use a stable letter-led key');
    if (keys.has(f.key)) add(`fields.${i}.key`,'Keys must be unique'); keys.add(f.key);
    if (!f.label.trim()) add(`fields.${i}.label`,'Label is required');
    if (f.type === 'select' && (!f.options?.length || new Set(f.options.map(o=>o.value)).size !== f.options.length)) add(`fields.${i}.options`,'Provide unique options');
    if (f.validation?.min !== undefined && f.validation.max !== undefined && f.validation.min > f.validation.max) add(`fields.${i}.validation`,'Minimum exceeds maximum');
    if (f.validation?.minLength !== undefined && f.validation.maxLength !== undefined && f.validation.minLength > f.validation.maxLength) add(`fields.${i}.validation`,'Minimum length exceeds maximum');
    if (f.default !== undefined) for (const issue of validateInputs({ ...definition, fields: [f] }, { [f.key]: f.default }).issues) add(`fields.${i}.default`,issue.message);
  }
  const texts: [string,string][] = [['promptTemplate',definition.promptTemplate],['titleTemplate',definition.titleTemplate]];
  const d=definition.destination;
  if (d.kind === 'new-project') { texts.push(['destination.nameTemplate',d.nameTemplate]); if (!d.nameTemplate.trim() || !d.hostId || !d.path.trim().startsWith('/') || /^\/+$/u.test(d.path.trim())) add('destination','Provide project name, enrolled host and absolute existing source path'); if(d.environment.kind === 'reuse' || d.environment.kind === 'project-default') add('destination.environment','New projects require local-source or worktree environment'); }
  if(d.kind === 'existing-project' && !d.projectId) add('destination.projectId','Choose a project');
  if(d.kind!=='new-project'&&d.hostId&&d.environment.kind==='project-default')add('destination.environment','A specific machine requires a source checkout or worktree. Use BB default machine to keep automatic environment selection.');
  if(d.environment.kind === 'reuse' && !d.environment.environmentId) add('destination.environment','Choose an environment');
  if(d.environment.kind === 'worktree' && !d.environment.baseBranch.trim()) add('destination.environment','Choose a base branch');
  if(definition.execution.kind === 'explicit' && (!definition.execution.providerId || !definition.execution.model)) add('execution','Choose provider and model');
  for (const [path,t] of texts) { for(const match of t.matchAll(TOKEN)) if(!keys.has(match[1]!)) add(path,`Unknown field ${match[1]}`); if(t.replace(TOKEN,'').includes('{{') || t.replace(TOKEN,'').includes('}}')) add(path,'Invalid template token'); }
  return issues;
}
/** Exact pre-customer seed, retained solely for preserving installed authored work. */
export function legacyPrReviewDefinition(): TemplateDefinition {
  return {...emptyDefinition('review-pr'),name:'Review a PR',description:'Find bugs, risks, and missing tests in a pull request.',fields:[{key:'pr_url',label:'Pull request URL',type:'url',required:true,order:0},{key:'focus',label:'Focus',type:'textarea',required:false,order:1}],titleTemplate:'Review {{pr_url}}',promptTemplate:'Review {{pr_url}} in this project.\nFocus: {{focus|bugs, risks, and missing tests}}\nReport actionable findings with file references.'};
}
export function prReviewDefinition(templateId='review-pr'): TemplateDefinition {
  return {
    ...emptyDefinition(templateId),name:'PR Review',
    description:'Commission an independent review, post findings, and work through initial feedback.',
    fields:[
      {key:'pr_url',label:'Pull request URL',type:'url',required:true,order:0},
      {key:'subject',label:'Main change or review goal',type:'text',required:true,order:1},
      {key:'focus',label:'Important context or concerns',type:'textarea',required:false,order:2},
    ],
    titleTemplate:'PR Review: {{subject}}',
    promptTemplate:[
      'For {{pr_url}}, the main subject is {{subject}}.',
      'Important context and review focus:',
      "{{focus|Assess correctness, regressions, and missing tests against the PR's intended change.}}",
      '',
      'Commission an independent second mate to run and post a /github-pr-review',
      'according to the /pr-review process, using /bb-delegation-mode.',
      'Keep the review grounded in the subject and important context above.',
      'Address initial feedback thoughtfully before any squash-merge step.',
    ].join('\n'),
  };
}
export function feedbackSessionDefinition(): TemplateDefinition {
  return {
    ...emptyDefinition('feedback-session'),name:'Feedback Session',
    description:'Prepare a rapid-fire feedback session with clear context and a shared feedback log.',
    fields:[
      {key:'subject',label:'What are we giving feedback on?',type:'text',required:true,order:0},
      {key:'target_url',label:'Deployed site or preview URL',type:'url',required:false,order:1},
      {key:'focus',label:'Main focus and context',type:'textarea',required:true,order:2},
      {key:'contributors',label:'Feedback contributors',type:'textarea',required:false,order:3},
    ],
    titleTemplate:'Feedback Session: {{subject}}',
    promptTemplate:[
      'Set up a rapid-fire feedback session for {{subject}}.',
      "Target: {{target_url|Use the selected project's current environment/context.}}",
      'Main focus and context:',
      '{{focus}}',
      '',
      'Feedback contributors: {{contributors|Multiple people may contribute. Attribute each item to its source.}}',
      '',
      'Use /rapid-fire-feedback-in-bb-mode. Start /thread-brief and /workbench-plan.',
      "Prepare a numbered feedback log that preserves each item's subject, intent,",
      'feedback giver and reviewer. Track implementation completion separately from',
      'review and approval. Support feedback arriving from multiple contributors.',
      'Set up the session and be ready to receive the first feedback item.',
    ].join('\n'),
  };
}
export function starterDefinitions(): TemplateDefinition[] {
  return [feedbackSessionDefinition(),prReviewDefinition()];
}
// Historical seed values remain available for exact audit/comparison, never fresh seeding.
export function legacyGenericStarterDefinitions(): TemplateDefinition[] {
  return [
    {...emptyDefinition('fix-bug'),name:'Fix a bug',description:'Reproduce a problem, fix its cause, and verify the result.',fields:[{key:'bug',label:'What is going wrong?',type:'textarea',required:true,order:0},{key:'reproduction',label:'How to reproduce',type:'textarea',required:false,order:1}],titleTemplate:'Fix bug',promptTemplate:'Investigate and fix this problem in the selected project:\n{{bug}}\nReproduction: {{reproduction|Determine a minimal reproduction.}}\nPreserve unrelated work and verify the fix.'},
    {...emptyDefinition('explore-idea'),name:'Explore an idea',description:'Assess an idea against the real project and identify next steps.',fields:[{key:'idea',label:'What would you like to explore?',type:'textarea',required:true,order:0}],titleTemplate:'Explore idea',promptTemplate:'Explore this idea in the context of the selected project:\n{{idea}}\nInspect relevant code and constraints. Explain tradeoffs and concrete next steps.'},
    {...emptyDefinition('start-project'),name:'Start a project',description:'Configure an enrolled host and existing local source directory before publishing.',fields:[{key:'goal',label:'What should this project do?',type:'textarea',required:true,order:0}],destination:{kind:'new-project',nameTemplate:'New project',hostId:'',path:'',environment:{kind:'local-source'}},titleTemplate:'Start project',promptTemplate:'Start work toward this goal in the configured project source:\n{{goal}}\nInspect the existing context and instructions, then implement and verify a useful first step.'},
    {...emptyDefinition('implement-change'),name:'Implement a change',description:'Make a focused change and verify the result.',fields:[{key:'request',label:'What should change?',type:'textarea',required:true,order:0}],titleTemplate:'Implement change',promptTemplate:'Implement this change in the selected project:\n{{request}}\nRead its instructions, preserve unrelated work, and run relevant checks.'},
  ];
}
