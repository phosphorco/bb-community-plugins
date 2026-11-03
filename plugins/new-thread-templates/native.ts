import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {nativeEnvironmentSchema,nativeInputSchema,nativeSubmissionSchema,executionSourcesSchema,type NativeSubmission,type NativeEditorSeed,nativeEditorSeedSchema} from './native-submission';
import { PLUGIN_ID, renderText, validateDefinition, validateInputs, type Inputs, type TemplateDefinition, type RenderContext,createRenderContext,renderContextSchema,isValidTimeZone } from './model';
import {projectTemplateTarget,renderTemplatePreview,composeTemplatePreview} from './template-preview';
import {targetPreviewRequestSchema} from './rpc-contract';
import type { TargetPreviewRequest,TargetPreviewResult,TargetEffects,TemplatesChoices,PreviewResult, ResolvedEffects, TemplatesContext } from './rpc-contract';
import type { LaunchRecord } from './store';
import { canonical } from './store';

// Public SDK only; this deliberately requests no host raw RPC or private hooks.
type Sdk = BbPluginApi['sdk'];
export type NativeApi = {
  projects: Pick<Sdk['projects'],'list'|'get'|'create'|'defaultExecutionOptions'>;
  hosts: Pick<Sdk['hosts'],'list'|'get'|'pathsExist'|'directory'|'experimental_listProviders'>;
  environments: Pick<Sdk['environments'],'list'|'get'|'listProviders'>;
  providers: Pick<Sdk['providers'],'list'|'models'|'catalog'>;
  system: Pick<Sdk['system'],'config'>;
  threads: Pick<Sdk['threads'],'spawn'|'list'|'getPluginMetadata'|'experimental_listPluginMetadata'>;
};
const nativeRequestFields={
  projectId:z.string().min(1),title:z.string().min(1).optional(),environment:nativeEnvironmentSchema,
  providerId:z.string().optional(),model:z.string().optional(),reasoningLevel:z.string().optional(),serviceTier:z.string().optional(),
  permissionMode:z.enum(['auto','full','accept-edits']).optional(),sessionOptions:z.record(z.string(),z.union([z.string(),z.boolean()])).optional(),sendAt:z.number().int().nonnegative().optional(),
  executionInputSources:executionSourcesSchema.optional(),pluginMetadata:z.record(z.string(),z.json()),
};
export const nativeRequestSchema=z.union([
  z.object({...nativeRequestFields,prompt:z.string().min(1),input:z.never().optional()}).strict(),
  z.object({...nativeRequestFields,input:nativeInputSchema,prompt:z.never().optional()}).strict(),
]).superRefine((value,ctx)=>{
  if(new TextEncoder().encode(JSON.stringify(value.pluginMetadata)).length>240*1024)ctx.addIssue({code:'custom',message:'Launch metadata exceeds the size limit'});
  if(value.prompt&&new TextEncoder().encode(value.prompt).length>256*1024)ctx.addIssue({code:'custom',message:'Rendered first message exceeds the size limit'});
  if(value.input&&new TextEncoder().encode(JSON.stringify(value.input)).length>1048576)ctx.addIssue({code:'custom',message:'Native input exceeds the size limit'});
});
export type NativeRequest=z.infer<typeof nativeRequestSchema>;
export interface Preparation {
  effects:ResolvedEffects;
  environment:NativeRequest['environment'];
  execution:Pick<NativeRequest,'providerId'|'model'|'reasoningLevel'|'serviceTier'|'executionInputSources'|'permissionMode'|'sessionOptions'|'sendAt'>;
  creation:{name:string;hostId:string;path:string}|null;
}
export interface NativePort {
  resolve(definition:TemplateDefinition,inputs:Inputs,projectId?:string,confirmedProjectId?:string,renderContext?:RenderContext):Promise<Preparation>;
  resolveNative(definition:TemplateDefinition,inputs:Inputs,submission:NativeSubmission,originProjectId?:string,renderContext?:RenderContext):Promise<Preparation>;
  createProject(creation:NonNullable<Preparation['creation']>):Promise<string>;
  findProject(creation:NonNullable<Preparation['creation']>):Promise<string|null>;
  spawn(request:NativeRequest):Promise<string>;
  findThread(record:LaunchRecord):Promise<{threadId:string|null;message:string;candidate?:{threadId:string;state:'pending'|'failed'}}>;
}
// Matches public native POSIX project-path normalization: trim and remove trailing slash.
// Dot segments/symlinks are not invented aliases. Unsupported paths are rejected.
export function normalizeSourcePath(path:string):string {const p=path.trim();return p==='/'?p:p.replace(/\/+$/u,'');}
export function matchesNativeReceipt(metadata:unknown,record:LaunchRecord):boolean {
  const parsed=z.record(z.string(),z.json()).safeParse(metadata);if(!parsed.success)return false;const m=parsed.data;
  return m.operationId===record.status.operationId&&m.fingerprint===record.fingerprint&&m.revision===record.revision.revision&&m.templateId===record.revision.templateId&&canonical(m.actor)===canonical(record.capturedActor)&&canonical(m.inputs)===canonical(record.status.inputs);
}
export class NativeTemplates implements NativePort {
  constructor(readonly sdk:NativeApi) {}
  private renderingContext(definition:TemplateDefinition,provided?:RenderContext):RenderContext {if(!isValidTimeZone(definition.timeZone??'UTC'))throw new Error('Use a valid IANA time zone');return provided?renderContextSchema.parse(provided):createRenderContext(definition.timeZone??'UTC');}
  async findProject(creation:NonNullable<Preparation['creation']>) {
    const matches=(await this.sdk.projects.list()).filter(p=>p.sources.some(s=>s.hostId===creation.hostId&&normalizeSourcePath(s.path)===normalizeSourcePath(creation.path)));
    if(matches.length>1)throw new Error('Multiple projects match the local source; provisioning remains unknown.');
    return matches[0]?.id??null;
  }
  async createProject(c:NonNullable<Preparation['creation']>) {return (await this.sdk.projects.create({name:c.name,source:{hostId:c.hostId,path:c.path,type:'local_path'}})).id;}
  async resolve(definition:TemplateDefinition,inputs:Inputs,projectId?:string,confirmedProjectId?:string,providedContext?:RenderContext):Promise<Preparation> {
    const renderContext=this.renderingContext(definition,providedContext),projection=projectTemplateTarget(definition,inputs,projectId,renderContext);
    if(!projection.request)throw new Error(projection.issues.map(i=>i.message).join('; '));
    const target=await this.resolveTarget(projection.request,confirmedProjectId);
    return {...target,effects:{...target.effects,renderContext,title:renderText(definition.titleTemplate,inputs,4000,renderContext),prompt:renderText(definition.promptTemplate,inputs,undefined,renderContext)}};
  }
  async targetPreview(input:TargetPreviewRequest):Promise<TargetPreviewResult> {
    try{const prepared=await this.resolveTarget(input);return {issues:[],effects:prepared.effects};}
    catch(error){return {issues:[{path:'destination',message:error instanceof Error?error.message:String(error)}],effects:null};}
  }
  async resolveTarget(input:TargetPreviewRequest,confirmedProjectId?:string):Promise<Omit<Preparation,'effects'>&{effects:TargetEffects}> {
    input=targetPreviewRequestSchema.parse(input);
    const d=input.destination,projectId=input.projectId;const warnings:string[]=[];
    if(d.kind!=='new-project'&&d.hostId&&d.environment.kind==='project-default')throw new Error('A specific machine requires a source checkout or worktree. Use BB default machine to keep automatic environment selection.');
    let creation:Preparation['creation']=null;
    let finalId=confirmedProjectId??(d.kind==='existing-project'?d.projectId:d.kind==='choose-at-launch'?projectId:undefined);
    if(d.kind==='new-project') {
      const c={name:d.name.trim(),hostId:d.hostId,path:normalizeSourcePath(d.path)};
      if(!c.name || !c.hostId || !c.path.startsWith('/') || c.path==='/')throw new Error('New projects need a name, enrolled host and existing absolute project directory.');
      finalId=confirmedProjectId??await this.findProject(c)??undefined;
      if(!finalId)creation=c;
    } else if(!finalId)throw new Error('Choose a destination project.');
    const project=finalId?await this.sdk.projects.get({projectId:finalId}):null;
    const config=await this.sdk.system.config();
    let hostId:string;let path:string|null=null;let routing:ResolvedEffects['routing'];let environment:NativeRequest['environment'];let environmentLabel:string;
    if(d.environment.kind==='reuse') {
      if(!project)throw new Error('A reusable environment requires an existing project.');
      const env=await this.sdk.environments.get({environmentId:d.environment.environmentId});
      if(env.projectId!==project.id || env.status!=='ready' || env.lifecycle.phase!=='active' || env.hostLifecycle!=='active')throw new Error('The selected environment is unavailable or belongs to a different project.');
      if(d.hostId&&d.hostId!==env.hostId)throw new Error('The selected machine does not match the reusable environment. Choose its actual machine or another environment.');
      hostId=env.hostId;path=env.path;routing={kind:'environment',environmentId:env.id};environment={type:'reuse',environmentId:env.id};environmentLabel=`Reuse ${env.name??env.id}`;
    } else {
      // Native project-default always routes to the primary host, not a source's order/default flag.
      hostId=d.environment.kind==='project-default' ? (config.primaryHostId??'') : d.hostId??creation?.hostId??project?.sources.find(s=>s.isDefault)?.hostId??project?.sources[0]?.hostId??'';
      if(!hostId)throw new Error('No target host is configured. Select a local source or connect the primary host.');
      const source=project?.sources.find(s=>s.hostId===hostId);
      if(project && !source && project.kind!=='personal')throw new Error('The destination project has no source on the target host. Choose an environment or add a source.');
      path=creation?.path??source?.path??null;routing={kind:'host',hostId};
      if(d.environment.kind==='project-default') {
        environment={type:'project-default'};environmentLabel='Project default (native checkout or worktree)';
        warnings.push('BB chooses the checkout or a new worktree when the thread starts.');
      } else if(d.environment.kind==='worktree') {
        if(!path)throw new Error('A worktree requires a local source.');
        environment={type:'host',hostId,workspace:{type:'managed-worktree',baseBranch:{kind:'named',name:d.environment.baseBranch}}};environmentLabel=`New worktree from ${d.environment.baseBranch}`;
      } else {
        if(!path)throw new Error('A local-source environment requires a project source path.');
        environment={type:'host',hostId,workspace:{type:'unmanaged',path,...(d.environment.branch?{branch:{kind:'existing' as const,name:d.environment.branch}}:{})}};
        environmentLabel=d.environment.branch?`Source checkout, branch ${d.environment.branch}`:'Source checkout';
      }
    }
    const host=await this.sdk.hosts.get({hostId});
    if(host.status!=='connected' || host.lifecycle.phase!=='active')throw new Error('The target host is unavailable. Connect it before starting a thread.');
    if(d.hostId&&d.environment.kind!=='reuse'&&path&&!creation)await this.sdk.hosts.directory({hostId,path});
    if(creation) {
      const exists=await this.sdk.hosts.pathsExist({hostId,paths:[creation.path]});
      if(exists.existence[creation.path]!==true)throw new Error('The source path does not exist on the selected host. Templates does not bootstrap remote repositories.');
      await this.sdk.hosts.directory({hostId,path:creation.path});
      warnings.push('Uses the project’s settings after creation. If this source already belongs to a project, that project will be used.');
    }
    const defaults=finalId?await this.sdk.projects.defaultExecutionOptions({projectId:finalId}):null;
    const route=routing.kind==='environment'?{environmentId:routing.environmentId}:{hostId, ...(finalId?{projectId:finalId}:{})};
    const providers=(await this.sdk.providers.list(routing.kind==='environment'?{environmentId:routing.environmentId}:{hostId})).filter(p=>p.available);
    const explicit=input.execution.kind==='explicit'?input.execution:null;
    const enabledCatalog=await this.sdk.providers.catalog();
    const storedDefaults=defaults&&enabledCatalog.some(p=>p.id===defaults.providerId&&p.enabled)?defaults:null;
    const defaultProvider=storedDefaults?.providerId??config.generalSettings.defaultProviderId;
    const candidateIds=explicit?[explicit.providerId]:storedDefaults?[storedDefaults.providerId]:[...(defaultProvider?[defaultProvider]:[]),...providers.map(p=>p.id)];
    let selected:Awaited<ReturnType<NativeApi['providers']['models']>>|null=null;
    let providerId='';let lastError='No agent provider is available on the target host.';
    for(const candidate of [...new Set(candidateIds)]) {
      if(!providers.some(p=>p.id===candidate)){lastError=`Provider ${candidate} is unavailable on the target host.`;continue;}
      const catalog=await this.sdk.providers.models({...route,providerId:candidate});
      if(catalog.modelLoadError){lastError=`Cannot load ${candidate} models: ${catalog.modelLoadError.detail??catalog.modelLoadError.code}`;if(explicit||storedDefaults)throw new Error(lastError);continue;}
      if(!catalog.models.length&&!catalog.selectedOnlyModels.length){lastError=`No ${candidate} models available on the target host.`;if(explicit||storedDefaults)throw new Error(lastError);continue;}
      selected=catalog;providerId=candidate;break;
    }
    if(!selected)throw new Error(lastError);
    const inheritedDefaults=storedDefaults?.providerId===providerId?storedDefaults:null;
    const desiredModel=explicit?.model??inheritedDefaults?.model;
    const chosen=desiredModel?[...selected.models,...selected.selectedOnlyModels].find(m=>m.model===desiredModel):selected.models.find(m=>m.isDefault)??selected.models[0];
    if(!chosen)throw new Error(`Model ${desiredModel??'(default)'} is unavailable on the target host.`);
    const reasoning=explicit?.reasoningLevel??inheritedDefaults?.reasoningLevel??null;
    const tier=config.generalSettings.allowFastServiceTier?(explicit?.serviceTier??inheritedDefaults?.serviceTier??null):'default';
    if(!config.generalSettings.allowFastServiceTier&&explicit?.serviceTier&&explicit.serviceTier!=='default')throw new Error('Non-default service tiers are disabled in BB settings.');
    if(explicit?.reasoningLevel && !chosen.supportedReasoningEfforts.some(r=>r.reasoningEffort===explicit.reasoningLevel))throw new Error('The selected reasoning level is unavailable for this model.');
    const provider=providers.find(p=>p.id===providerId);
    const tierOptions=provider?.capabilities.supportsServiceTier?(provider.serviceTiers??[]).filter(t=>chosen.supportedServiceTiers===undefined||chosen.supportedServiceTiers.some(m=>m.id===t.id)):[];
    if(explicit?.serviceTier && explicit.serviceTier!=='default' && !tierOptions.some(t=>t.id===explicit.serviceTier))throw new Error('The selected service tier is unavailable for this model.');
    const execution:Preparation['execution']=explicit?{providerId,model:chosen.model,...(explicit.reasoningLevel?{reasoningLevel:explicit.reasoningLevel}:{}),...(explicit.serviceTier?{serviceTier:explicit.serviceTier}:{}),executionInputSources:{providerId:'explicit',model:'explicit',...(explicit.reasoningLevel?{reasoningLevel:'explicit' as const}:{}),...(explicit.serviceTier?{serviceTier:'explicit' as const}:{})}}:{};
    if(!explicit)warnings.push('Uses this project’s model and environment defaults at launch.');
    return {creation,environment,execution,effects:{projectId:finalId??null,projectName:project?.name??creation?.name??'',hostId,hostName:host.name,path,environment:environmentLabel,mode:'template',nativeEnvironment:environment,createsProject:creation!==null,routing,execution:{providerId,model:chosen.model,reasoningLevel:reasoning,serviceTier:tier,permissionMode:inheritedDefaults?.permissionMode??null,inherited:!explicit},warnings}};
  }
  async resolveNative(definition:TemplateDefinition,inputs:Inputs,raw:NativeSubmission,originProjectId?:string,providedContext?:RenderContext):Promise<Preparation> {
    const renderContext=this.renderingContext(definition,providedContext);
    const submission=nativeSubmissionSchema.parse(raw),environment=submission.environment;
    // Opening eligibility belongs to preview; the submitted native destination is final.
    // Original source changes cannot retarget or invalidate this immutable origin.
    const project=await this.sdk.projects.get({projectId:submission.projectId});
    const config=await this.sdk.system.config(),warnings:string[]=[];
    let hostId:string|null=null,path:string|null=null,environmentLabel='',routing:ResolvedEffects['routing']=null;
    if(environment.type==='reuse') {
      const env=await this.sdk.environments.get({environmentId:environment.environmentId});
      if(env.projectId!==project.id||env.status!=='ready'||env.lifecycle.phase!=='active'||env.hostLifecycle!=='active')throw new Error('The selected native environment is unavailable or belongs to another project.');
      hostId=env.hostId;path=env.path;routing={kind:'environment',environmentId:env.id};environmentLabel='Reuse '+(env.name??env.id);
    } else if(environment.type==='provider') {
      hostId=environment.machine?.type==='existing'?environment.machine.hostId:null;
      const available=await this.sdk.environments.listProviders({projectId:project.id,...(hostId?{hostId}:{})});
      const provider=available.find(p=>p.id===environment.environmentProviderId);
      if(!provider||(environment.machine?.type!=='new'&&(provider.availability?.status==='unavailable'||provider.availability?.status==='setup-required')))throw new Error('The selected native environment provider is unavailable or needs setup.');
      environmentLabel=provider.displayName;
      if(!environment.machine&&!provider.machineProviderId)throw new Error('The selected native environment provider requires a machine selection.');
      if(provider.machineProviderId&&environment.machine?.type==='existing')throw new Error('The selected native composition requires a new machine.');
      const machineId=environment.machine?.type==='new'?environment.machine.machineProviderId:!environment.machine?provider.machineProviderId:null;
      if(machineId) {
        if(!(await this.sdk.hosts.experimental_listProviders()).some(p=>p.id===machineId))throw new Error('The selected native machine provider is unavailable.');
        if(provider.machineProviderId&&provider.machineProviderId!==machineId)throw new Error('The selected native composition requires a different machine provider.');
      }
      // machineAvailability is indexed by existing host ID, never machine-provider ID.
      const availability=hostId?provider.machineAvailability[hostId]:null;
      if(availability?.status==='unavailable'||availability?.status==='setup-required')throw new Error('The native environment is unavailable on the selected machine.');
      if(hostId){path=project.sources.find(s=>s.hostId===hostId)?.path??null;routing={kind:'host',hostId};}
      else warnings.push('The selected native provider will create or choose its machine. Model availability and permission limits are checked during native admission.');
    } else {
      hostId=environment.type==='host'?environment.hostId??config.primaryHostId:config.primaryHostId;
      if(!hostId)throw new Error('No target host is configured for this native request.');
      routing={kind:'host',hostId};
      const source=project.sources.find(s=>s.hostId===hostId);
      if(environment.type==='host'&&environment.workspace.type==='personal') {
        if(project.kind!=='personal')throw new Error('A personal workspace requires the native personal project.');
        environmentLabel='Personal workspace';
      } else {
        if(project.kind==='personal'&&environment.type==='host')throw new Error('Use the native personal workspace for the personal project.');
        path=environment.type==='host'&&environment.workspace.type==='unmanaged'&&environment.workspace.path!==null?environment.workspace.path:source?.path??null;
        if(!path&&project.kind!=='personal')throw new Error('The chosen project has no source on the selected native host.');
        if(environment.type==='project-default')environmentLabel='Project default (native checkout or worktree)';
        else if(environment.workspace.type==='managed-worktree')environmentLabel='New native worktree';
        else environmentLabel='Native source checkout';
      }
      if(environment.type==='host'&&environment.workspace.type==='unmanaged'&&environment.workspace.path!==null) {
        if(!/^(?:\/|[A-Za-z]:[\\/])/.test(environment.workspace.path))throw new Error('The native source path must be absolute.');
        await this.sdk.hosts.directory({hostId,path:environment.workspace.path});
      }
    }
    let hostName:string|undefined;
    if(hostId) {
      const host=await this.sdk.hosts.get({hostId});if(host.status!=='connected'||host.lifecycle.phase!=='active')throw new Error('The selected native host is unavailable.');
      hostName=host.name;
    }
    const globalProvider=(await this.sdk.providers.catalog()).find(p=>p.id===submission.providerId);
    if(!globalProvider?.enabled||!globalProvider.available)throw new Error('The selected agent provider is unavailable.');
    if(submission.serviceTier&&submission.serviceTier!=='default'&&!config.generalSettings.allowFastServiceTier)throw new Error('Non-default service tiers are disabled in BB settings.');
    if(hostId) {
      const route=routing?.kind==='environment'?{environmentId:routing.environmentId}:{hostId,projectId:project.id};
      const providers=await this.sdk.providers.list(routing?.kind==='environment'?{environmentId:routing.environmentId}:{hostId});
      const provider=providers.find(p=>p.id===submission.providerId&&p.available);
      if(!provider)throw new Error('The selected provider is unavailable on the native target.');
      const catalog=await this.sdk.providers.models({...route,providerId:submission.providerId});
      if(catalog.modelLoadError)throw new Error('Cannot validate the native target model: '+(catalog.modelLoadError.detail??catalog.modelLoadError.code));
      const model=[...catalog.models,...catalog.selectedOnlyModels].find(m=>m.model===submission.model);
      if(!model)throw new Error('The selected model is unavailable on the native target.');
      if(model.supportedReasoningEfforts.length&&!model.supportedReasoningEfforts.some(r=>r.reasoningEffort===submission.reasoningLevel))throw new Error('The selected reasoning level is unavailable for the native model.');
      const modes=['accept-edits','auto','full'];
      if(modes.indexOf(submission.permissionMode)>modes.indexOf(catalog.permissionCeiling)||!provider.capabilities.permissionModes.includes(submission.permissionMode))throw new Error('The selected native permission mode exceeds target policy or provider support.');
      if(submission.serviceTier&&submission.serviceTier!=='default') {
        if(!config.generalSettings.allowFastServiceTier)throw new Error('Non-default service tiers are disabled in BB settings.');
        const options=provider.capabilities.supportsServiceTier?(provider.serviceTiers??[]).filter(t=>model.supportedServiceTiers===undefined||model.supportedServiceTiers.some(m=>m.id===t.id)):[];
        if(!options.some(t=>t.id===submission.serviceTier))throw new Error('The selected service tier is unavailable on the native target.');
      }
      if(provider.capabilities.modelCatalogScope==='workspace'&&environment.type==='host'&&environment.workspace.type==='unmanaged'&&environment.workspace.path!==null&&normalizeSourcePath(environment.workspace.path)!==normalizeSourcePath(project.sources.find(s=>s.hostId===hostId)?.path??'')) {
        throw new Error('This provider needs an existing environment to validate the custom native workspace model. Choose an existing environment or the project checkout.');
      }
    }
    const {input:_input,environment:_environment,projectId:_projectId,...execution}=submission;
    return {
      creation:null,environment,execution,
      effects:{renderContext,projectId:project.id,projectName:project.name,hostId,...(hostName?{hostName}:{}),path,environment:environmentLabel,createsProject:false,routing,mode:'native',nativeEnvironment:environment,validation:hostId?'target-host':'deferred-native',
        execution:{providerId:submission.providerId,model:submission.model,reasoningLevel:submission.reasoningLevel,serviceTier:submission.serviceTier??null,permissionMode:submission.permissionMode,inherited:false},
        title:renderText(definition.titleTemplate,inputs,4000,renderContext),prompt:submission.input.filter(p=>p.type==='text').map(p=>p.text).join('\n'),warnings},
    };
  }
  async preview(definition:TemplateDefinition,submitted:Inputs,projectId?:string,providedContext?:RenderContext):Promise<PreviewResult> {
    const definitionIssues=validateDefinition(definition);if(definitionIssues.length)return {issues:definitionIssues,effects:null};
    try{
      const renderContext=this.renderingContext(definition,providedContext),local=renderTemplatePreview(definition,submitted,renderContext);
      if(local.issues.length)return {renderContext,issues:local.issues,effects:null};
      const projection=projectTemplateTarget(definition,local.inputs,projectId,renderContext);
      if(!projection.request)return {renderContext,issues:projection.issues,effects:null};
      return composeTemplatePreview(local,await this.targetPreview(projection.request),renderContext);
    }catch(error){return {issues:[{path:'destination',message:error instanceof Error?error.message:String(error)}],effects:null};}
  }
  async choices(input:{projectId?:string}):Promise<TemplatesChoices> {
    const [projects,hosts,environments,config]=await Promise.all([this.sdk.projects.list({includePersonal:true}),this.sdk.hosts.list(),this.sdk.environments.list({...(input.projectId?{projectId:input.projectId}:{}),limit:200}),this.sdk.system.config()]);
    return {primaryHostId:config.primaryHostId,projects:projects.map(p=>({id:p.id,name:p.name,sources:p.sources.map(s=>({hostId:s.hostId,path:s.path,isDefault:s.isDefault}))})),hosts:hosts.map(h=>({id:h.id,name:h.name,online:h.status==='connected'&&h.lifecycle.phase==='active'})),environments:environments.filter(e=>e.lifecycle.phase==='active'&&e.status==='ready').map(e=>({id:e.id,projectId:e.projectId,hostId:e.hostId,name:e.name??e.id,path:e.path})),warnings:[]};
  }
  async context(input:{projectId?:string;hostId?:string;environmentId?:string}) {
    // Compatibility shape only: no product consumer used this model list. Native
    // pickers and final target resolution own routed model discovery.
    return {...await this.choices(input),models:[]};
  }
  async threadMetadata(threadId:string) {return this.sdk.threads.getPluginMetadata({pluginId:PLUGIN_ID,threadId});}
  async spawn(request:NativeRequest) {return (await this.sdk.threads.spawn(nativeRequestSchema.parse(request))).id;}
  async findThread(record:LaunchRecord) {
    const found=new Set<string>();const candidates=new Map<string,'pending'|'failed'>();let truncated=false;
    // Public listing omits deleted records. Absence is never a negative receipt.
    for(const archived of [false,true]) {
      for(let page=0;page<20;page++) {
        const rows=await this.sdk.threads.list({projectId:record.status.projectId??undefined,originPluginId:PLUGIN_ID,archived,includeHidden:true,limit:100,offset:page*100});
        if(rows.length) {
          const metadata=await this.sdk.threads.experimental_listPluginMetadata({pluginId:PLUGIN_ID,threadIds:rows.map(r=>r.id)});
          for(const row of metadata.threads) {
            const m=row.metadata;
            if(matchesNativeReceipt(m,record)) {
              const nativeRow=rows.find(thread=>thread.id===row.threadId);
              if(nativeRow?.deletedAt===null&&(nativeRow.status==='active'||nativeRow.status==='idle'))found.add(row.threadId);
              else candidates.set(row.threadId,nativeRow?.status==='error'?'failed':'pending');
            }
          }
        }
        if(rows.length<100)break;
        if(page===19)truncated=true;
      }
    }
    if(found.size===1&&candidates.size===0)return {threadId:[...found][0]!,message:'Confirmed native thread metadata receipt.'};
    if(found.size+candidates.size>1)return {threadId:null,message:'Multiple native receipts match this launch. Outcome remains indeterminate; inspect the matching threads.'};
    if(candidates.size===1){const [threadId,state]=[...candidates][0]!;return {threadId:null,candidate:{threadId,state},message:'A matching provisional thread exists without confirmed admission. This launch remains indeterminate and will not be sent again.'};}
    return {threadId:null,message:truncated?'Receipt scan coverage is incomplete. Launch remains indeterminate; no resend is allowed.':'No matching native receipt is visible (deleted records are not listed). Launch remains indeterminate; no resend is allowed.'};
  }
}
