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
