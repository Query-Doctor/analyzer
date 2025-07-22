import * as core from "@actions/core";
import { LOG_PATH, MAX_COST, POSTGRES_URL, STATISTICS_PATH } from "./env.ts";
import { Runner } from "./runner.ts";

async function main() {
  if (!POSTGRES_URL) {
    core.setFailed("POSTGRES_URL environment variable is not set");
    Deno.exit(1);
  }
  if (!LOG_PATH) {
    core.setFailed("LOG_PATH environment variable is not set");
    Deno.exit(1);
  }
  const runner = await Runner.build({
    postgresUrl: POSTGRES_URL,
    statisticsPath: STATISTICS_PATH,
    logPath: LOG_PATH,
    maxCost: MAX_COST ? Number(MAX_COST) : undefined,
  });
  await runner.run();
  Deno.exit();
}

if (import.meta.main) {
  await main();
}
