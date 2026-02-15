import * as core from "@actions/core";
import { Runner } from "./runner.ts";
import { env } from "./env.ts";
import { log } from "./log.ts";
import { createServer } from "./server/http.ts";
import { Connectable } from "./sync/connectable.ts";
import { shutdownController } from "./shutdown.ts";

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

async function runOutsideCI() {
  const os = process.platform;
  const arch = process.arch;
  log.info(
    `Starting server (${os}-${arch}) on ${env.HOST}:${env.PORT}`,
    "main",
  );
  if (!env.POSTGRES_URL) {
    core.setFailed("POSTGRES_URL environment variable is not set");
    process.exit(1);
  }
  const server = await createServer(
    env.HOST,
    env.PORT,
    Connectable.fromString(env.POSTGRES_URL),
  );

  const shutdown = async () => {
    shutdownController.abort();
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function main() {
  if (env.CI) {
    if (!env.POSTGRES_URL) {
      core.setFailed("POSTGRES_URL environment variable is not set");
      process.exit(1);
    }
    if (!env.LOG_PATH) {
      core.setFailed("LOG_PATH environment variable is not set");
      process.exit(1);
    }
    await runInCI(
      Connectable.fromString(env.POSTGRES_URL),
      env.LOG_PATH,
      env.STATISTICS_PATH,
      typeof env.MAX_COST === "number" ? env.MAX_COST : undefined,
    );
    process.exit();
  } else {
    await runOutsideCI();
  }
}

await main();
