import {assignmentStatusSchema} from './inbox-assignment-contract';
export {assignmentStatusSchema,type AssignmentStatus} from './inbox-assignment-contract';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { nativeSubmissionSchema, nativeEditorSeedSchema, nativeEnvironmentSchema } from './native-submission';
import { launchRequestSchema, launchCheckpointSchema, renderContextSchema, invocationSampleSchema, actorSchema, definitionSchema, draftSchema, entrySchema, inputsSchema, issueSchema, revisionSchema } from './model';

const id = z.string().min(1).max(120);
export {launchRequestSchema,launchCheckpointSchema,type LaunchRequest,type LaunchCheckpoint} from './model';
export const launchStatusSchema = z.object({
  operationId: z.string(), templateId: z.string(), revision: z.number().int(),
  phase: z.enum(['preparing','project-claimed','project-unknown','ready','spawn-claimed','indeterminate','succeeded','failed','rejected']),
  projectId: z.string().nullable(), threadId: z.string().nullable(), message: z.string().nullable(),
  candidate:z.object({threadId:z.string(),state:z.enum(['pending','failed','deleted'])}).strict().nullable().optional(),
  assignment:assignmentStatusSchema.optional(),
  renderContext:renderContextSchema.optional(),
  sampleCapture:z.object({state:z.enum(['saved','unavailable']),message:z.string().nullable()}).strict().optional(),
  retryable: z.boolean(), actor: actorSchema, inputs: inputsSchema,
  nativeAttribution: z.literal('plugin-origin'), createdAt: z.number(), updatedAt: z.number(),
}).strict();
export type LaunchStatus = z.infer<typeof launchStatusSchema>;
export const projectChoiceSchema = z.object({ id: z.string(), name: z.string(), sources: z.array(z.object({ hostId: z.string(), path: z.string(), isDefault: z.boolean() }).strict()) }).strict();
export const hostChoiceSchema = z.object({ id: z.string(), name: z.string(), online: z.boolean() }).strict();
export const environmentChoiceSchema = z.object({ id: z.string(), projectId: z.string(), hostId: z.string(), name: z.string(), path: z.string().nullable() }).strict();
export const modelChoiceSchema = z.object({ providerId: z.string(), model: z.string(), label: z.string(), reasoningLevels: z.array(z.string()), serviceTiers: z.array(z.string()) }).strict();
export const resolvedEffectsSchema = z.object({
  renderContext:renderContextSchema.optional(),
  projectId: z.string().nullable(), projectName: z.string(), hostId: z.string().nullable(),hostName:z.string().optional(),mode:z.enum(['template','native']).optional(),validation:z.enum(['target-host','deferred-native']).optional(),nativeEnvironment:nativeEnvironmentSchema.optional(), path: z.string().nullable(),
  environment: z.string(), createsProject: z.boolean(),
  routing: z.union([z.object({ kind: z.literal('host'), hostId: z.string() }).strict(), z.object({ kind: z.literal('environment'), environmentId: z.string() }).strict()]).nullable(),
  execution: z.object({ providerId: z.string(), model: z.string(), reasoningLevel: z.string().nullable(), serviceTier: z.string().nullable(), permissionMode: z.string().nullable(), inherited: z.boolean() }).strict(),
  title: z.string(), prompt: z.string(), warnings: z.array(z.string()),
}).strict();
export type ResolvedEffects = z.infer<typeof resolvedEffectsSchema>;
export const previewRequestSchema = z.object({ renderContext:renderContextSchema.optional(), definition: definitionSchema, inputs: inputsSchema, projectId: z.string().optional() }).strict();
export const previewResultSchema = z.object({ renderContext:renderContextSchema.optional(), issues: z.array(issueSchema), effects: resolvedEffectsSchema.nullable(),nativeSeed:nativeEditorSeedSchema.nullable().optional() }).strict();
export type PreviewResult = z.infer<typeof previewResultSchema>;
export const contextResultSchema = z.object({ projects: z.array(projectChoiceSchema), hosts: z.array(hostChoiceSchema), environments: z.array(environmentChoiceSchema), models: z.array(modelChoiceSchema), actor: actorSchema, session: z.string(), primaryHostId:z.string().nullable(), warnings: z.array(z.string()) }).strict();
export type TemplatesContext = z.infer<typeof contextResultSchema>;
export const recentLaunchSchema=z.object({renderContext:renderContextSchema.optional(),requestedRenderContext:renderContextSchema.optional(),status:launchStatusSchema,revision:revisionSchema,requestedProjectId:z.string().optional(),effects:resolvedEffectsSchema.nullable(),nativeSubmission:nativeSubmissionSchema.optional()}).strict();
export type RecentLaunch=z.infer<typeof recentLaunchSchema>;
export const removeRequestSchema=z.object({templateId:id,expectedGeneration:z.number().int().nonnegative().nullable(),expectedRevision:z.number().int().positive().nullable(),expectedLatestRevision:z.number().int().nonnegative()}).strict();
export const removalSchema=z.object({templateId:id,removedAt:z.number(),removedBy:actorSchema}).strict();
export type RemoveRequest=z.infer<typeof removeRequestSchema>;
export type TemplateRemoval=z.infer<typeof removalSchema>;
export const templatesContract = defineRpcContract({
  catalog: { input: z.object({}).strict(), output: z.object({ entries: z.array(entrySchema) }).strict() },
  context: { input: z.object({ projectId: z.string().optional(), environmentId: z.string().optional(), hostId: z.string().optional() }).strict(), output: contextResultSchema },
  saveDraft: { input: z.object({ definition: definitionSchema, expectedGeneration: z.number().int().nonnegative().nullable() }).strict(), output: draftSchema },
  publish: { input: z.object({ templateId: id, expectedGeneration: z.number().int().nonnegative() }).strict(), output: z.object({ entry: entrySchema, issues: z.array(issueSchema) }).strict() },
  unpublish: { input: z.object({ templateId: id, expectedRevision: z.number().int().positive() }).strict(), output: entrySchema },
  duplicate: { input: z.object({ templateId: id, newId: id }).strict(), output: draftSchema },
  remove: {input:removeRequestSchema,output:removalSchema},
  preview: { input: previewRequestSchema, output: previewResultSchema },
  launch: { input: launchRequestSchema, output: launchStatusSchema },
  resumeLaunch:{input:z.object({checkpoint:launchCheckpointSchema,expectedActor:z.string().min(1),expectedSession:z.string().min(1)}).strict(),output:launchStatusSchema},
  recentSamples:{input:z.object({templateId:id}).strict(),output:z.object({samples:z.array(invocationSampleSchema).max(5)}).strict()},
  recentLaunches: {input:z.object({offset:z.number().int().nonnegative().optional()}).strict(),output:z.object({launches:z.array(recentLaunchSchema),nextOffset:z.number().int().nullable()}).strict()},
  retryAssignment:{input:z.object({operationId:z.string().uuid(),expectedActor:z.string().min(1),expectedSession:z.string().min(1)}).strict(),output:launchStatusSchema},
  launchStatus: { input: z.object({ operationId: z.string().uuid() }).strict(), output: launchStatusSchema.nullable() },
});
export const contract = templatesContract;
export const TEMPLATES_CHANGED = 'new-thread-templates:changed';
