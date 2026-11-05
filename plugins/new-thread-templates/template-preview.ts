import {defaultInputs,validateInputs,validateDefinition,renderText,validateTemplate,renderContextSchema,type TemplateDefinition,type Inputs,type RenderContext,type ValidationIssue} from './model';
import {nativeEditorSeedSchema} from './native-submission';
import {targetPreviewRequestSchema,type TargetPreviewRequest,type TargetPreviewResult,type PreviewResult} from './rpc-contract';
export interface TargetProjection {request:TargetPreviewRequest|null;issues:ValidationIssue[]}
function projected(request:TargetPreviewRequest):TargetProjection {const parsed=targetPreviewRequestSchema.safeParse(request);return parsed.success?{request:parsed.data,issues:[]}:{request:null,issues:parsed.error.issues.map(i=>({path:i.path.join('.'),message:i.message}))};}
export interface LocalTemplatePreview {inputs:Inputs;issues:ValidationIssue[];title:string|null;prompt:string|null}
/** Exact target business influence, independent of unrelated required prompt fields. */
export function projectTemplateTarget(definition:TemplateDefinition,submitted:Inputs,projectId:string|undefined,context:RenderContext):TargetProjection {
  const d=definition.destination;
  if(d.kind!=='new-project')return projected({destination:d,execution:definition.execution,...(d.kind==='choose-at-launch'&&projectId?{projectId}:{})});
  const issues=validateTemplate(d.nameTemplate,definition.fields.map(f=>f.key)).map(issue=>({path:'destination.nameTemplate',message:`${issue.message} (line ${issue.line}, column ${issue.column})`}));
  if(issues.length)return {request:null,issues};
  try{renderContextSchema.parse(context);const name=renderText(d.nameTemplate,{...defaultInputs(definition),...submitted},undefined,context).trim();if(!name)throw new Error('New projects need a name.');return projected({destination:{kind:'new-project',name,hostId:d.hostId,path:d.path,environment:d.environment},execution:definition.execution});}
  catch(error){return {request:null,issues:[{path:'destination.nameTemplate',message:error instanceof Error?error.message:String(error)}]};}
}
/** Local validation/rendering never discovers native state or advances the clock. */
export function renderTemplatePreview(definition:TemplateDefinition,submitted:Inputs,context:RenderContext):LocalTemplatePreview {
  const checked=validateInputs(definition,submitted),issues=[...validateDefinition(definition),...checked.issues];
  if(issues.length)return {inputs:checked.inputs,issues,title:null,prompt:null};
  try{renderContextSchema.parse(context);return {inputs:checked.inputs,issues:[],title:renderText(definition.titleTemplate,checked.inputs,4000,context),prompt:renderText(definition.promptTemplate,checked.inputs,undefined,context)};}
  catch(error){return {inputs:checked.inputs,issues:[{path:'promptTemplate',message:error instanceof Error?error.message:String(error)}],title:null,prompt:null};}
}
export function composeTemplatePreview(local:LocalTemplatePreview,target:TargetPreviewResult,renderContext:RenderContext):PreviewResult {
  const issues=[...local.issues,...target.issues];if(issues.length||!target.effects||local.title===null||local.prompt===null)return {renderContext,issues,effects:null,nativeSeed:null};
  const e={...target.effects,renderContext,title:local.title,prompt:local.prompt};
  const nativeSeed=e.projectId&&e.nativeEnvironment?nativeEditorSeedSchema.parse({defaultProjectId:e.projectId,defaultEnvironment:e.nativeEnvironment,initialPrompt:e.prompt,defaultProviderId:e.execution.providerId,defaultModel:e.execution.model,...(e.execution.reasoningLevel?{defaultReasoningLevel:e.execution.reasoningLevel}:{}),...(e.execution.serviceTier?{defaultServiceTier:e.execution.serviceTier}:{}),...(e.execution.permissionMode?{defaultPermissionMode:e.execution.permissionMode}:{})}):null;
  return {renderContext,issues:[],effects:e,nativeSeed};
}
