import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { PluginBrowserBbSdk } from '@get-bb/plugin-sdk/app';
import { createThreadMetricsDiscovery, createThreadMetricsClient, registerThreadMetricsOwner } from '@phosphorco/bb-thread-metrics/bb';
import type { MetricsPort } from '@phosphorco/bb-thread-metrics/bb';
import type { UsageVector, CoverageReason } from '@phosphorco/bb-thread-metrics';
import { runSupplierConformance } from '@phosphorco/bb-thread-metrics/testing';
declare const bb:BbPluginApi;
declare const browser:PluginBrowserBbSdk;
declare const port:MetricsPort;
createThreadMetricsClient(bb.sdk,'supplier');
createThreadMetricsClient(browser,'supplier');
createThreadMetricsDiscovery(bb.sdk).discover();
createThreadMetricsDiscovery(browser).discover();
registerThreadMetricsOwner(bb,port);
const vector:UsageVector={inputUncached:1,cacheRead:2,cacheWrite:3,output:4};
void vector;void runSupplierConformance;

const unattestedRoot:CoverageReason='root-unattested';
void unattestedRoot;

// Additive recent snapshot0.2 types narrow unchanged/full without altering readV1.
import type { RecentSnapshotInput, RecentSnapshotResult, ScoringConfigV2 } from '@phosphorco/bb-thread-metrics';
const recentRequest:RecentSnapshotInput={ifRevision:'instance:1'};
const recentConfig:ScoringConfigV2={schemaVersion:2,mode:'percentile',providerWeights:{codex:1},gates:{m20:.9,h24:.9,d7:.9}};
function checkRecent(result:RecentSnapshotResult){if(result.unchanged)return result.revision;return result.rows.map(row=>[row.threadId,row.own.windows.m20,row.family.scores.h24,row.configRevision]);}
void recentRequest;void recentConfig;void checkRecent;
// @ts-expect-error revision is an opaque string, never a numeric clock.
const invalidRecentRequest:RecentSnapshotInput={ifRevision:123};
void invalidRecentRequest;

import { DEFAULT_SCORING_CONFIG_V3,ROOT_FAMILY_HEAT_DOMAIN_V1,rootFamilyHeatV1,prepareRootFamilyMigration } from '@phosphorco/bb-thread-metrics';
import type { ScoringConfigV3,RootFamilyHeatContextV1,RootFamilyDecisionSetV1,RootTopologyV1,HeatConfigRecord,HeatSettingsSaveInput } from '@phosphorco/bb-thread-metrics';
const rootConfig:ScoringConfigV3=DEFAULT_SCORING_CONFIG_V3;
const rootTopology:RootTopologyV1={kind:'attested',parentThreadId:null,lifecycleOwnerThreadId:null,deleted:false};
const legacyRecord:HeatConfigRecord={version:'legacy',value:recentConfig};
const migration=prepareRootFamilyMigration(legacyRecord);
const saveRoot:HeatSettingsSaveInput={protocolVersion:1,baseConfigVersion:legacyRecord.version,operationKey:'migration',candidate:rootConfig};
void migration;void saveRoot;void ROOT_FAMILY_HEAT_DOMAIN_V1;
declare const rootContext:RootFamilyHeatContextV1;
declare const scoreInput:Parameters<typeof rootFamilyHeatV1>[0]['family'];
const decisions:RootFamilyDecisionSetV1=rootFamilyHeatV1({topology:rootTopology,context:rootContext,config:rootConfig,family:scoreInput});
void decisions.signals.d7;void decisions.winner;
// @ts-expect-error root-family domain is required, not inferred from a missing field.
const missingDomain:ScoringConfigV3={schemaVersion:3,mode:'percentile',providerWeights:{},gates:{m20:.9,h24:.8,d7:.8}};
// @ts-expect-error an unattested missing parent field is never a null parent proof.
const missingParent:RootTopologyV1={kind:'attested',lifecycleOwnerThreadId:null,deleted:false};
// @ts-expect-error legacy records remain readable but cannot be saved without explicit domain migration.
const legacySave:HeatSettingsSaveInput={protocolVersion:1,baseConfigVersion:'old',operationKey:'x',candidate:recentConfig};
void missingDomain;void missingParent;void legacySave;

import type {RecentUsage,RecentTokenValue} from '@phosphorco/bb-thread-metrics';
const unavailableTokens:RecentTokenValue={kind:'unavailable',value:null};
function observedTokens(usage:RecentUsage){const tokens=usage.windows.h24;return tokens.value===null?null:tokens.value.inputUncached;}
void unavailableTokens;void observedTokens;
// @ts-expect-error unavailable is explicit null, never a fabricated zero vector.
const fabricatedTokens:RecentTokenValue={kind:'unavailable',value:{inputUncached:0,cacheRead:0,cacheWrite:0,output:0}};
void fabricatedTokens;

import type {RecentHeatInputs,RecentRootInput,RecentPresentation} from '@phosphorco/bb-thread-metrics';
declare const capturedRootInputs:RecentHeatInputs;
const capturedInput:RecentRootInput|undefined=capturedRootInputs.rows[0];
const capturedMetadata:RecentPresentation|undefined=capturedInput?.presentation;
void capturedMetadata;void capturedInput?.family.attribution?.unpriced.d7;
// @ts-expect-error root input rows do not need a fabricated72h activity timestamp.
void capturedInput?.ownLastFoldAt;


import type {RecentPublicationIdentity} from '@phosphorco/bb-thread-metrics';
const committedPublication:RecentPublicationIdentity={instance:'opaque-writer',sequence:1};
function publicationOrder(value:RecentSnapshotResult){return value.unchanged?null:value.publication?.sequence??null;}
void committedPublication;void publicationOrder;
// @ts-expect-error publication sequence is numeric; opaque revision remains separate.
const stringSequence:RecentPublicationIdentity={instance:'writer',sequence:'1'};
void stringSequence;

// Retain this session in the selected native source resource, outside mounts.
import {createRecentSnapshotSession,RecentSnapshotNotStarted} from '@phosphorco/bb-thread-metrics/bb';
import type {RecentSnapshotSession,RecentSnapshotObservation,RecentSessionClock} from '@phosphorco/bb-thread-metrics/bb';
const sessionClient=createThreadMetricsClient(browser,'supplier');
const session:RecentSnapshotSession=createRecentSnapshotSession(sessionClient,{timeoutMs:2000});
const observation:Promise<RecentSnapshotObservation>=session.read({full:true});
session.updateSource(sessionClient);session.setActive(false);session.setActive(true);
void observation;void session.current?.publication.sequence;void session.outstandingReads;void RecentSnapshotNotStarted;
declare const sessionClock:RecentSessionClock;
createRecentSnapshotSession(sessionClient,{clock:sessionClock});
// @ts-expect-error selected source facade must expose the recent RPC method.
createRecentSnapshotSession({pluginId:'missing-method'});
// @ts-expect-error publication observations are readonly.
if(session.current)session.current.ownerGeneration=99;
