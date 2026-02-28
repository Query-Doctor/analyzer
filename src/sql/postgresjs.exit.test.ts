import { test, expect } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFile } from "node:child_process";

function runScript(
  script: string,
): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      ["--import=tsx", "--input-type=module", "-e", script],
      { timeout: 5_000 },
      (error) => {
        resolve({
          exitCode: error ? Number(error.code ?? 1) : 0,
          timedOut: error?.killed === true,
        });
      },
    );
    // Pipe to a pipe (not inherit) to mimic CI where SIGPIPE can occur
    child.stdout?.resume();
    child.stderr?.resume();
  });
}

/**
 * Verifies that a process with an idle source pool connection exits
 * naturally without hanging. Without allowExitOnIdle, pg-pool keeps
 * idle connections ref'd, which blocks Node from exiting.
 */
test("process exits without hanging when source pool has idle connections", async () => {
  const pg = await new PostgreSqlContainer("postgres:17").start();

  const script = `
    import { connectToSource } from "./src/sql/postgresjs.ts";
    import { Connectable } from "./src/sync/connectable.ts";
    const db = connectToSource(Connectable.fromString("${pg.getConnectionUri()}"));
    await db.exec("SELECT 1");
    // Intentionally do NOT call db.close() — idle connection stays in pool.
    // With allowExitOnIdle, the process should still exit promptly.
    // Without it, the idle connection's ref'd socket blocks exit.
  `;

  try {
    const { exitCode, timedOut } = await runScript(script);

    expect(timedOut, "process should not hang on idle pool connections").toBe(
      false,
    );
    expect(exitCode, "process should exit 0, not SIGPIPE (13)").toBe(0);
  } finally {
    await pg.stop();
  }
});

/**
 * Verifies that a process exits cleanly (code 0) after explicitly
 * closing the source pool. This guards against SIGPIPE (exit 13)
 * caused by process.exit() killing I/O mid-flush.
 */
test("process exits with code 0 after explicit pool close", async () => {
  const pg = await new PostgreSqlContainer("postgres:17").start();

  const script = `
    import { connectToSource } from "./src/sql/postgresjs.ts";
    import { Connectable } from "./src/sync/connectable.ts";
    const db = connectToSource(Connectable.fromString("${pg.getConnectionUri()}"));
    await db.exec("SELECT 1");
    await db.close();
  `;

  try {
    const { exitCode, timedOut } = await runScript(script);

    expect(timedOut, "process should not hang after pool.end()").toBe(false);
    expect(exitCode, "process should exit 0, not SIGPIPE (13)").toBe(0);
  } finally {
    await pg.stop();
  }
});
