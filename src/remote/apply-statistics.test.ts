import { describe, expect, it, vi } from "vitest";
import { Statistics, type ExportedStats } from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Remote } from "./remote.ts";

function makeRemote(): Remote {
  return new Remote(
    Connectable.fromString("postgresql://postgres@localhost:5432/postgres"),
    ConnectionManager.forRemoteDatabase(),
  );
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

/**
 * `applyStatistics` decides what reaches the server's stored snapshot, so what
 * it emits matters more than what it applies locally. The optimizer runs
 * against a copy restored without table data, so its own metadata reports
 * `reltuples = -1` everywhere — pushing that would replace a project's real
 * production statistics with an empty snapshot.
 */
describe("Remote.applyStatistics", () => {
  it("pushes the source dump, not the optimizer's own metadata", async () => {
    const remote = makeRemote();
    const sourceDump = [table("users", 5_000_000)];
    // The optimizing database is empty; its dump is what must NOT be pushed.
    vi.spyOn(remote.optimizer, "setStatistics").mockResolvedValue(undefined);
    vi.spyOn(remote.optimizer, "restart").mockResolvedValue(undefined);
    vi.spyOn(remote.optimizer, "ownMetadata", "get").mockReturnValue([
      table("users", -1),
    ]);
    const pushed: ExportedStats[][] = [];
    remote.on("statsApplied", (stats) => pushed.push(stats));

    await remote.applyStatistics(Statistics.statsModeFromExport(sourceDump));

    expect(pushed).toEqual([sourceDump]);
    expect(pushed[0][0].reltuples).toBe(5_000_000);
  });

  it("pushes nothing for synthetic statistics", async () => {
    // resetStats applies fromAssumption. Those numbers are invented, so
    // publishing them as production statistics would be a lie.
    const remote = makeRemote();
    vi.spyOn(remote.optimizer, "setStatistics").mockResolvedValue(undefined);
    vi.spyOn(remote.optimizer, "restart").mockResolvedValue(undefined);
    vi.spyOn(remote.optimizer, "ownMetadata", "get").mockReturnValue([
      table("users", -1),
    ]);
    let pushed = false;
    remote.on("statsApplied", () => {
      pushed = true;
    });

    await remote.applyStatistics(Statistics.defaultStatsMode);

    expect(pushed).toBe(false);
  });
});
