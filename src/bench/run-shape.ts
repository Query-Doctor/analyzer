import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { QueryOptimizer } from "../remote/query-optimizer.ts";
import { instrument, permutationCount } from "./instrument.ts";
import { reportFromChild } from "./measure.ts";
import { PG_COMMAND, setupDatabase, WORKLOAD_VERSION } from "./workload.ts";

/**
 * Runs one shape and prints what it cost. Spawned by `measureShape`, one
 * process per shape, so its peak memory is its own and running out of it is a
 * result rather than the end of the run.
 *
 * Deliberately a standalone entrypoint rather than a vitest bench. It is copied
 * onto whichever commit is being measured, and vitest's own version is one more
 * thing that would have to agree across six months of history.
 *
 *   node --import tsx src/bench/run-shape.ts --shape=breadth --tables=20 --queries=100
 */

type Args = {
  shape: string;
  tables: number;
  queries: number;
  image: string;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string) => {
    const found = argv.find((arg) => arg.startsWith(`--${name}=`));
    const value = found?.split("=")[1] ?? fallback;
    if (value === undefined) throw new Error(`Missing --${name}`);
    return value;
  };
  return {
    shape: get("shape"),
    tables: Number(get("tables")),
    queries: Number(get("queries")),
    // Pinned by the caller. A moving tag would make two runs months apart
    // disagree about what they were measuring.
    image: get("image", "postgres:17"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const container = await new PostgreSqlContainer(args.image)
    .withCommand(PG_COMMAND)
    .start();

  const recording = instrument(QueryOptimizer);
  let context: Awaited<ReturnType<typeof setupDatabase>> | undefined;
  try {
    context = await setupDatabase(
      container.getConnectionUri(),
      `bench_${args.shape.replace(/\W/g, "_")}`,
      args.tables,
      args.queries,
    );
    await context.optimizer.start(context.queries, context.stats);
  } finally {
    recording.restore();
    context?.optimizer.stop();
    await context?.manager.closeAll().catch(() => {});
    await container.stop().catch(() => {});
  }

  // Sorted by hash so the order is the same on every run, which is what lets
  // two runs be paired without carrying the hashes around.
  const hashes = [...recording.timings.keys()].sort();

  process.stdout.write(
    `${reportFromChild({
      shape: args.shape,
      // Two runs of different workload versions measure different work.
      workloadVersion: WORKLOAD_VERSION,
      hashes,
      perQueryMs: hashes.map((hash) => recording.timings.get(hash)!),
      // Work outside the query loop. Without it a run is sampled, not
      // accounted for, and a change to statistics dumping moves nothing.
      phases: Object.fromEntries(recording.phases),
      counts: {
        queriesMeasured: hashes.length,
        candidatesTotal: [...recording.candidates.values()].reduce(
          (sum, count) => sum + count,
          0,
        ),
        maxCandidatesPerTable: recording.maxCandidatesPerTable,
        // The number the optimizer would build from the worst table. This is
        // the count that decides whether a run is cheap or impossible.
        worstTablePermutations: permutationCount(
          recording.maxCandidatesPerTable,
        ),
      },
      missing: recording.missing,
    })}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
