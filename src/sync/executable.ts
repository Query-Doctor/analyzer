import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { env } from "../env.ts";
import { log } from "../log.ts";

function lookupBinary(
  platform: typeof process.platform,
  name: string,
): string | undefined {
  try {
    if (platform === "linux" || platform === "darwin") {
      const output = spawnSync("which", [name]);
      return output.stdout.toString() || undefined;
    }
  } catch (_error) {
    // it's not in path. No problem
  }
}

export function findPgRestoreBinary(version: string): string {
  const forcePath = env.PG_RESTORE_BINARY;
  if (forcePath) {
    log.info(
      `Using pg_restore binary from env(PG_RESTORE_BINARY): ${forcePath}`,
      "schema:setup",
    );
    printVersion("pg_restore", forcePath);
    return forcePath;
  }
  const platform = process.platform;
  const arch = process.arch;
  const os = platformToOs(platform);
  const existing = lookupBinary(platform, "pg_restore")?.trim();
  if (existing) {
    log.info(
      `Using pg_restore binary from PATH: ${existing.trim()}`,
      "schema:setup",
    );
    printVersion("pg_restore", existing);
    return existing;
  }
  const shippedPath = `./bin/pg_restore-${version}/pg_restore.${os}-${arch}`;
  if (!statSync(shippedPath).isFile()) {
    throw new Error(`pg_restore binary not found at ${shippedPath}`);
  }
  log.info(
    `Using built-in "pg_restore" binary: ${shippedPath}`,
    "schema:setup",
  );
  printVersion("pg_restore", shippedPath);
  return shippedPath;
}

export function findPgDumpBinary(version: string): string {
  const forcePath = env.PG_DUMP_BINARY;
  if (forcePath) {
    log.info(
      `Using pg_dump binary from env(PG_DUMP_BINARY): ${forcePath}`,
      "schema:setup",
    );
    printVersion("pg_dump", forcePath);
    return forcePath;
  }
  const platform = process.platform;
  const arch = process.arch;
  const os = platformToOs(platform);
  const existing = lookupBinary(platform, "pg_dump")?.trim();
  if (existing) {
    log.info(
      `Using pg_dump binary from PATH: ${existing}`,
      "schema:setup",
    );
    printVersion("pg_dump", existing);
    return existing;
  }
  const shippedPath = `./bin/pg_dump-${version}/pg_dump.${os}-${arch}`;
  if (!statSync(shippedPath).isFile()) {
    throw new Error(`pg_dump binary not found at ${shippedPath}`);
  }
  log.info(`Using built-in "pg_dump" binary: ${shippedPath}`, "schema:setup");
  printVersion("pg_dump", shippedPath);
  return shippedPath;
}

function printVersion(name: string, executable: string) {
  const version = getVersion(executable);
  log.info(`${name} version: ${version}`, "schema:setup");
}

function getVersion(executable: string) {
  const result = spawnSync(executable, ["--version"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  return result.stdout.toString().trim();
}

/** Map Node.js process.platform to the OS names used in binary paths */
function platformToOs(platform: typeof process.platform): string {
  if (platform === "win32") return "windows";
  return platform;
}
