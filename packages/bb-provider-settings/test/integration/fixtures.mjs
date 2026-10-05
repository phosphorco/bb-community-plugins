export const policies={
  rosetta:{match:'model',routeQualifier:'must-equal-provider-when-present',candidates:'models',modelLoadError:'reject',tier:'non-default-requires-support'},
  perspectives:{match:'id-or-model',routeQualifier:'ignore',candidates:'models+selected-only',modelLoadError:'not-checked',tier:'not-validated'},
  rtd:{match:'model',routeQualifier:'must-equal-provider-when-present',candidates:'models',modelLoadError:'reject',tier:'any-non-null-requires-support-and-listed'},
};
export const provider=(id='p',extra={})=>({id,available:true,capabilities:{modelCatalogScope:'host',supportsServiceTier:true,permissionModes:['auto','accept-edits']},serviceTiers:[{id:'default'},{id:'fast'}],...extra});
export const row=(extra={})=>({id:'catalog-id',model:'exec-model',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],...extra});
export const catalog=(extra={})=>({providerId:'p',route:{kind:'host',hostId:'h'},modelLoadError:null,models:[row()],selectedOnlyModels:[],...extra});
export const selection={providerId:'p',model:'exec-model',reasoningLevel:'low',serviceTier:'default'};
export const capability=(extra={})=>({evidence:'test-only-role-witness-not-host-proof',boundaries:['fork-child'],providers:{p:{perBoundary:{'fork-child':{model:'demonstrated',reasoningLevel:'demonstrated',reasoningWithoutModel:'demonstrated'}}}},...extra});
export const descriptor=(extra={})=>{const role={id:'expert',label:'Expert',choiceKinds:['inherit','fields'],cascade:'caller-v1',providerPolicy:'any',saveValidation:'invocation',applies:'Used by the next invocation.',writable:true,...extra};if(!role.choiceKinds.includes('fields'))delete role.cascade;return role;};
