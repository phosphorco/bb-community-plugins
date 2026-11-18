import assert from "node:assert/strict";
import { test } from "vitest";
import { FleetClient } from "../fleet-client.ts";
import { MAX_TIMELINE_EVENTS, fleetOverviewResultSchema, machineTimelineResultSchema } from "../fleet-contract.ts";
import { createFleetPerformanceFixture } from "./fixtures/fleet-performance.fixture.ts";

test("the production cache bounds a 32-machine working set and rereads evicted detail", async () => {
  const fixture = createFleetPerformanceFixture();
  const machines = fixture.machines();
  const requests = new Map<string, number>();
  const client = new FleetClient({
    readOverview: async () => fleetOverviewResultSchema.parse(fixture.overview()),
    readTimeline: async ({ machine }) => {
      requests.set(machine.machineId, (requests.get(machine.machineId) ?? 0) + 1);
      const value = fixture.timelineFor(machine.machineId);
      // The browser stress fixture has 500 selected events. This transport
      // uses the real serving contract, including its 200-event ceiling.
      const events = value.events as { events: unknown[]; totalCount: number };
      return machineTimelineResultSchema.parse({
        ...value,
        events: {
          events: events.events.slice(0, MAX_TIMELINE_EVENTS),
          totalCount: events.totalCount,
          truncated: events.events.length > MAX_TIMELINE_EVENTS,
        },
      });
    },
  });
  const read = (machine: (typeof machines)[number]) => client.readTimeline(machine.machine, fixture.range, machine.generation);
  const cached = (machine: (typeof machines)[number]) => client.getTimeline(machine.machine, fixture.range, machine.generation);
  try {
    for (const machine of machines) await read(machine);
    assert.ok(client.timelineByteSize <= 8 * 1024 * 1024);
    assert.ok(client.timelineEntryCount > 0 && client.timelineEntryCount < machines.length);
    assert.equal(requests.size, machines.length);
    assert.equal(cached(machines[0]!), undefined, "the oldest detail was evicted");
    const newest = machines.at(-1)!;
    const newestValue = cached(newest);
    assert.ok(newestValue);
    assert.equal(await read(newest), newestValue);
    assert.equal(requests.get(newest.machine.machineId), 1, "resident detail does not make another request");

    const oldestResident = machines.find((machine) => cached(machine) !== undefined)!;
    await read(machines[0]!);
    assert.equal(requests.get(machines[0]!.machine.machineId), 2, "evicted detail is fetched again");
    assert.ok(cached(oldestResident), "recently accessed detail survives admission of another entry");
    assert.ok(client.timelineByteSize <= 8 * 1024 * 1024);
  } finally {
    client.dispose();
  }
  assert.equal(client.timelineByteSize, 0);
  assert.equal(client.timelineEntryCount, 0);
});
