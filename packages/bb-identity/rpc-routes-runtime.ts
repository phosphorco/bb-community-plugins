/** Internal transport names. This module has no SDK/server dependencies so native
 * app adapters can share the exact registration map without importing server code. */
export const identityRoutes = Object.freeze({
  bootstrap: 'bb-identity/v1/bootstrap',
  selfProfile: 'bb-identity/v1/selfProfile',
  search: 'bb-identity/v1/search',
  profiles: 'bb-identity/v1/profiles',
  participants: 'bb-identity/v1/participants',
  participantPreviews: 'bb-identity/v1/participantPreviews',
} as const);

export const identityStateRoutes = Object.freeze({
  load: 'bb-identity/v1/state/load',
  save: 'bb-identity/v1/state/save',
  reconcile: 'bb-identity/v1/state/reconcile',
} as const);

export const identityStateRpcMethods = Object.freeze({
  [identityStateRoutes.load]: 'bb-identity.v1.state.load',
  [identityStateRoutes.save]: 'bb-identity.v1.state.save',
  [identityStateRoutes.reconcile]: 'bb-identity.v1.state.reconcile',
} as const);

export const identityRpcMethods = Object.freeze({
  [identityRoutes.bootstrap]: 'bb-identity.v1.bootstrap',
  [identityRoutes.selfProfile]: 'bb-identity.v1.selfProfile',
  [identityRoutes.search]: 'bb-identity.v1.search',
  [identityRoutes.profiles]: 'bb-identity.v1.profiles',
  [identityRoutes.participants]: 'bb-identity.v1.participants',
  [identityRoutes.participantPreviews]: 'bb-identity.v1.participantPreviews',
  ...identityStateRpcMethods,
} as const);
