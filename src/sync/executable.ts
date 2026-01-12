import { env } from "../env.ts";
import { log } from "../log.ts";

const decoder = new TextDecoder();

// Is there a way to get this working for windows?
function lookupBinary(
  os: typeof Deno.build.os,
  name: string,
): string | undefined {
  try {
    if (os === "linux" || os === "darwin") {
      const output = new Deno.Command("which", { args: [name] }).outputSync();
      return decoder.decode(output.stdout) || undefined;
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
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  const existing = lookupBinary(os, "pg_restore")?.trim();
  if (existing) {
    log.info(
      `Using pg_restore binary from PATH: ${existing.trim()}`,
      "schema:setup",
    );
    printVersion("pg_restore", existing);
    return existing;
  }
  const shippedPath = `./bin/pg_restore-${version}/pg_restore.${os}-${arch}`;
  if (!Deno.statSync(shippedPath).isFile) {
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
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  const existing = lookupBinary(os, "pg_dump")?.trim();
  if (existing) {
    log.info(
      `Using pg_dump binary from PATH: ${existing}`,
      "schema:setup",
    );
    printVersion("pg_dump", existing);
    return existing;
  }
  const shippedPath = `./bin/pg_dump-${version}/pg_dump.${os}-${arch}`;
  if (!Deno.statSync(shippedPath).isFile) {
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
  const version = new Deno.Command(executable, {
    args: ["--version"],
    stdout: "piped",
    // we want to be able to see the errors directly
    stderr: "inherit",
  });
  return new TextDecoder().decode((version.outputSync()).stdout).trim();
}
