import * as core from "@actions/core";
import { Runner } from "./runner.ts";
import { env } from "./env.ts";
import { log } from "./log.ts";
import { createServer } from "./server/http.ts";
import { shutdown } from "./shutdown.ts";
import { Connectable } from "./sync/connectable.ts";

async function runInCI(
  postgresUrl: Connectable,
  logPath: string,
  statisticsPath?: string,
  maxCost?: number,
) {
  const runner = await Runner.build({
    postgresUrl,
    statisticsPath,
    logPath,
    maxCost,
  });
  log.info("main", "Running in CI mode. Skipping server creation");
  await runner.run();
}

function runOutsideCI() {
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  log.info(
    `Starting server (${os}-${arch}) on ${env.HOST}:${env.PORT}`,
    "main",
  );
  if (!env.POSTGRES_URL) {
    core.setFailed("POSTGRES_URL environment variable is not set");
    Deno.exit(1);
  }
  createServer(env.HOST, env.PORT, Connectable.fromString(env.POSTGRES_URL));
}

async function main() {
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);
  if (env.CI) {
    if (!env.POSTGRES_URL) {
      core.setFailed("POSTGRES_URL environment variable is not set");
      Deno.exit(1);
    }
    if (!env.LOG_PATH) {
      core.setFailed("LOG_PATH environment variable is not set");
      Deno.exit(1);
    }
    await runInCI(
      Connectable.fromString(env.POSTGRES_URL),
      env.LOG_PATH,
      env.STATISTICS_PATH,
      typeof env.MAX_COST === "number" ? env.MAX_COST : undefined,
    );
    Deno.exit();
  } else {
    runOutsideCI();
  }
}

if (import.meta.main) {
  await main();
}
