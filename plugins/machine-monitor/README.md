# Machine Monitor

Machine Monitor is a deliberately small BB community plugin that records CPU, memory, root-disk, and one-minute load average for the BB server and its authenticated persistent execution machines. Its server-owned fleet coordinator collects the local server and persistent enrolled hosts through the BB host boundary; BB-classified ephemeral machines are excluded and their retained telemetry is pruned. On BB versions that do not expose a host type, enrolled hosts retain the prior persistent-host behavior. Contradictory duplicate records for one host ID are quarantined rather than authorizing deletion. The plugin does not discover or call arbitrary machines. It also tracks the Go, Rust, Bun, pnpm, and npm caches, `/tmp`, `~/.bb`, and BB worktrees on each collected machine. The root-disk breakdown is exclusive: when a measured folder has a measured child, it becomes `Other <folder>`; the derived `Other /` value reconciles the measured root-disk usage with all configured directories. Configure up to 32 additional absolute paths (one per line, with a 16 KiB total setting limit) in Plugin Settings; paths on another filesystem are displayed but do not affect root-disk Other. A destination that contains unreadable protected entries remains visible and is marked partial rather than disappearing.

It samples CPU/RAM/root disk every 30 seconds and cache directories every 15 minutes, retains 30 days in the plugin SQLite database, and aggregates each requested range to no more than 720 ECharts points. A separate Linux memory diagnostic samples kernel pressure/reclaim counters every minute and increases only those lightweight measurements to five seconds while the kernel reports memory stalls. A bounded process ranking remains at once per minute, retaining seven days or at most 20,000 compact snapshots. The panel shows root disk and per-directory average growth per day over the selected history. The browser has no foreground polling: it refreshes from emitted collection changes.

## Machine context

Each selected machine also has a low-churn **Machine context** profile. It is
collected after operational telemetry is healthy, on daemon reconnect, and at
most daily; selecting a machine reads the committed local-server profile and
never probes the daemon directly. Linux reports logical CPU count/model/speed,
observed CPU topology when sysfs exposes it, visible/usable RAM, allowlisted
OS/kernel facts, bounded block-device capacities, and Linux `md` status. WSL
is explicitly labeled **guest-visible**: these are VM facts, not claims about
the Windows host. macOS reports the portable Node baseline plus a clearly
partial root-volume capacity; device and RAID topology are unavailable until a
future bounded native adapter is added.

The profile intentionally omits serial numbers, MAC addresses, WWNs, UUIDs,
raw filesystem paths, IP geolocation, cloud metadata, and arbitrary system
reports. “No Linux md array detected” does not mean there is no hardware RAID,
LVM, or ZFS. Data-center location is **Not reported** unless it arrives later
from trusted operator/enrollment metadata; Machine Monitor never infers it.

## Fleet timelines and event boundary

Fleet collection, `fleetOverview`, and `machineTimeline` are implemented. The strict, versioned contract in `fleet-contract.ts` is backed by the server-owned coordinator, durable fleet store, registered RPC methods, and selected-machine timeline UI.

- The BB server assigns each observation either the reserved `local-bb-server` identity or an authenticated enrolled-host ID. Host-worker responses never contain an identity field that can select their own server-side record.
- Every collection envelope preserves its collector session/sequence, host observation time, server send/receive times, normalized timeline time, and clock uncertainty. Metric IDs come only from the built-in catalog, whose unit, gauge/counter semantics, aggregation rule, platform availability, and small visualization hint are closed values—not ECharts configuration.
- A machine timeline is requested by machine, range, and cached generation. Its deterministic response carries range, fixed range-start bucket metadata, coverage, explicit gaps, min/average/max/last/count buckets, and an ordered bounded event lane. Required time-normalization metadata keeps the raw host-observed range, normalized range, closed basis, sample count, and maximum clock uncertainty visible; raw clock-skewed values are never rewritten. Event references can name an exact BB project and thread, and boundary-spanning intervals retain their exact endpoints when they overlap the requested range.
- `fleetOverview` and `machineTimeline` are separate bounded RPC methods registered alongside the legacy `health`, `snapshot`, and attachment methods, so those existing consumers remain compatible.
- The typed timeline event lane is a tested internal extension seam only. Its durable reader, renderer, and synthetic end-to-end test exercise producer identity, event deduplication, bounded reads, and linked-thread activation, but no production event producer is enabled.
- A production event producer must remain disabled until a server-owned admission and ingestion policy enforces quota, event retention, bounded timestamps and durations, explicit overflow/cursor behavior, and exact BB project/thread validation.
- Linked references are one manual attachment snapshot scoped to the whole fleet. Search can attach an active or archived BB thread, a pasted same-host BB thread URL resolves to that thread identity, and any other safe HTTP(S) URL can be attached with a user-supplied name. These references are not silently converted into per-machine timeline-event provenance.

The full data-boundary rationale and limits are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Screenshots

| Mobile dashboard | Plugin settings |
| --- | --- |
| <img src="./assets/machine-monitor-mobile.png" alt="Machine Monitor mobile dashboard showing utilization and load charts with cache usage" width="360"> | <img src="./assets/machine-monitor-settings-mobile.png" alt="Machine Monitor mobile settings showing warning thresholds and process attribution" width="360"> |

## Warning thresholds

Configure CPU, RAM, and root-disk warnings in **Extensions → Plugins → Machine Monitor**. Each threshold offers 70%, 80%, 90%, or 95%.

- CPU alerts use a rolling five-minute average, so normal short-lived agent bursts do not turn the UI into an alarm.
- RAM is calculated from Linux `MemAvailable`, so reclaimable filesystem cache is not treated as pressure.
- Disk is the filesystem mounted at `/`; cache directories are shown as growth diagnostics but do not independently alert.
- Five-minute load average remains context only. It includes runnable work and I/O waits, and its healthy value depends on CPU count, so it is intentionally not a generic warning knob.

## Install

```sh
bb plugin install npm:@phosphorco/bb-plugin-machine-monitor@^0.1.0
```

Open **Machine Monitor** from the BB navigation sidebar. Its Activity icon stays neutral by default; a small warning dot appears only when CPU, RAM, or root-disk usage reaches its configured threshold, or when the collector has failed. Hover the dot for a concise overview. The Memory pressure section treats high RSS as context and labels thrash only from kernel pressure, reclaim/refault, swap, or major-fault evidence. Process names, PIDs, and inferred workload labels are neither stored nor shown by default because they can reveal deployment-host details; enable **Show process attribution** in plugin settings for an operator-only view. Process rankings use a bounded local scan of up to 2,048 processes, and should be read as a sampled ranking rather than a full process inventory. On Linux it reads `/proc/meminfo`, `/proc/stat`, `/proc/pressure/memory`, `/proc/vmstat`, and root filesystem statistics; unavailable metrics are shown as `—` rather than causing the collector to fail.

## Development

```sh
npm install
npm run test --workspace @phosphorco/bb-plugin-machine-monitor
npm run typecheck --workspace @phosphorco/bb-plugin-machine-monitor
npm run build --workspace @phosphorco/bb-plugin-machine-monitor
```
