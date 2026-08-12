import { describe, expect, it, vi } from "vitest";
import {
  Statistics,
  type ExportedStats,
  type ServerApi,
  type StatisticsMode,
} from "@query-doctor/core";
import type { RpcStub } from "capnweb";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Remote } from "./remote.ts";
import { hookUpApiReporter } from "./api-client.ts";
import { DEFAULT_REFRESH_FLOOR_MS } from "./stats-drift.ts";

function makeRemote(): Remote {
  const remote = new Remote(
    Connectable.fromString("postgresql://postgres@localhost:5432/postgres"),
    ConnectionManager.forRemoteDatabase(),
  );
  vi.spyOn(remote.optimizer, "setStatistics").mockResolvedValue(undefined);
  vi.spyOn(remote.optimizer, "restart").mockResolvedValue(undefined);
  return remote;
}

function table(name: string, reltuples: number): ExportedStats {
  return {
    schemaName: "public",
    tableName: name,
    reltuples,
    relpages: 1,
    relallvisible: 0,
    columns: [],
    indexes: [],
  } as unknown as ExportedStats;
}

/** Both fields are private; read them the way the seeding tests do. */
function floorArmedAt(remote: Remote): number | undefined {
  return (remote as unknown as { lastStatsPushAt?: number }).lastStatsPushAt;
}
function backoffUntil(remote: Remote): number | undefined {
  return (remote as unknown as { retryStatsAfter?: number }).retryStatsAfter;
}

/** Lets the fire-and-forget push settle before the assertion reads the floor. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The connection manager the drift check reads row counts through. */
function sourceManagerOf(remote: Remote): ConnectionManager {
  return (remote as unknown as { sourceManager: ConnectionManager }).sourceManager;
}

/** The private dump the refresh calls, exposed so a poll can be counted. */
function dumperOf(
  remote: Remote,
): { dumpSourceStats(source: Connectable): Promise<StatisticsMode> } {
  return remote as unknown as {
    dumpSourceStats(source: Connectable): Promise<StatisticsMode>;
  };
}

/** One schema-poll tick. Private, like the tick that drives it in production. */
function poll(remote: Remote, source: Connectable): Promise<void> {
  return (
    remote as unknown as {
      refreshStatsIfStale(source: Connectable): Promise<void>;
    }
  ).refreshStatsIfStale(source);
}

function apiWithPushStats(
  pushStats: (stats: ExportedStats[]) => Promise<void>,
): RpcStub<ServerApi> {
  return { pushStats } as unknown as RpcStub<ServerApi>;
}

/**
 * The daily floor exists so a project's statistics can't go stale unnoticed.
 * `pushStats` is fire-and-forget over a socket that dies mid-flight, so arming
 * the floor when the dump is emitted rather than when the server accepts it
 * makes a lost push indistinguishable from a delivered one — and shelves the
 * retry for 24 hours. That is how a project went five days without a capture.
 */
describe("statistics push delivery", () => {
  it("does not arm the daily floor on the emit alone", async () => {
    const remote = makeRemote();

    await remote.applyStatistics(
      Statistics.statsModeFromExport([table("users", 10_000)]),
    );

    expect(floorArmedAt(remote)).toBeUndefined();
  });

  it("arms the daily floor once the server accepts the push, and lifts the backoff", async () => {
    const remote = makeRemote();
    hookUpApiReporter(
      apiWithPushStats(() => Promise.resolve()),
      remote,
    );
    // A previous attempt had failed, so there is a live backoff to clear.
    remote.markStatsPushFailed();
    expect(backoffUntil(remote)).toBeTypeOf("number");

    await remote.applyStatistics(
      Statistics.statsModeFromExport([table("users", 10_000)]),
    );
    await flush();

    expect(floorArmedAt(remote)).toBeTypeOf("number");
    expect(backoffUntil(remote)).toBeUndefined();
  });

  it("backs off for minutes, not a day, when the push fails", async () => {
    // The socket dropping mid-push must leave the floor where it was, so the
    // next poll re-dumps rather than believing the stale numbers were stored.
    const remote = makeRemote();
    hookUpApiReporter(
      apiWithPushStats(() => Promise.reject(new Error("WebSocket connection failed."))),
      remote,
    );

    await remote.applyStatistics(
      Statistics.statsModeFromExport([table("users", 10_000)]),
    );
    await flush();

    expect(floorArmedAt(remote)).toBeUndefined();
    // The bug was a lost push buying a full day of silence. Anything on the
    // order of the daily floor would reintroduce it, so pin the magnitude
    // rather than the exact constant.
    const backoff = backoffUntil(remote)! - Date.now();
    expect(backoff).toBeGreaterThan(60_000);
    expect(backoff).toBeLessThan(DEFAULT_REFRESH_FLOOR_MS / 10);
  });

  it("re-dumps on a later poll when a push was lost, and not before the backoff", async () => {
    // The regression test for the reported bug. Asserting on the floor field
    // alone would have passed while the analyzer still sat silent for a day —
    // what matters is whether the next poll actually dumps again.
    //
    // Only Date is faked: the push settles on a real microtask turn.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const remote = makeRemote();
      hookUpApiReporter(
        apiWithPushStats(() => Promise.reject(new Error("WebSocket connection failed."))),
        remote,
      );
      const source = Connectable.fromString(
        "postgresql://postgres@localhost:5432/source",
      );
      // Row counts match the baseline, so drift stays quiet and the daily floor
      // is the only thing that can earn a dump. That is the path that broke.
      vi.spyOn(sourceManagerOf(remote), "getConnectorFor").mockReturnValue({
        getReltuplesByTable: async () => new Map([["public.users", 10_000]]),
      } as never);
      const dump = vi
        .spyOn(dumperOf(remote), "dumpSourceStats")
        .mockResolvedValue(
          Statistics.statsModeFromExport([table("users", 10_000)]),
        );

      remote.seedStatsBaseline([table("users", 10_000)]);
      vi.setSystemTime(Date.now() + DEFAULT_REFRESH_FLOOR_MS + 1_000);

      await poll(remote, source);
      expect(dump).toHaveBeenCalledTimes(1);
      await flush();

      // Immediately after the lost push: backed off, so no second dump.
      await poll(remote, source);
      expect(dump).toHaveBeenCalledTimes(1);

      // Once the backoff lapses the analyzer tries again. Before this change the
      // floor had been armed by the attempt, and this call dumped nothing.
      vi.setSystemTime(backoffUntil(remote)! + 1_000);
      await poll(remote, source);
      expect(dump).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the local drift baseline even when the push is lost", async () => {
    // The baseline describes what this analyzer dumped, not what the server
    // stored. Rolling it back on a failed push would re-trigger Size Drift on
    // every poll and dump the source over and over.
    const remote = makeRemote();
    hookUpApiReporter(
      apiWithPushStats(() => Promise.reject(new Error("WebSocket connection failed."))),
      remote,
    );

    await remote.applyStatistics(
      Statistics.statsModeFromExport([table("users", 10_000)]),
    );
    await flush();

    const baseline = (remote as unknown as { statsBaseline?: unknown }).statsBaseline;
    expect(baseline).toBeDefined();
  });
});
