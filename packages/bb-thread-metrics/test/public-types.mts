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
