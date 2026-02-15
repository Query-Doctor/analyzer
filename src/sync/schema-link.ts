import { SpanStatusCode, trace } from "@opentelemetry/api";
import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../log.ts";
import { shutdownController } from "../shutdown.ts";
import { withSpan } from "../otel.ts";
import { Connectable } from "./connectable.ts";
import { findPgDumpBinary, findPgRestoreBinary } from "./executable.ts";
import { EventEmitter } from "node:events";

export type TableStats = {
  name: string;
};

export type DumpTargetType = "pglite" | "native-postgres";

export type CommandStatus = {
  code: number | null;
  success: boolean;
};

export class PostgresSchemaLink {
  constructor(
    public readonly connectable: Connectable,
    public readonly targetType: DumpTargetType,
  ) {}

  excludedSchemas(): string[] {
    return DumpCommand.excludedSchemas(this.connectable);
  }

  /**
   * Dump schema to be consumed exclusively by pglite.
   */
  async dumpAsText(): Promise<string> {
    const command = DumpCommand.spawn(this.connectable, this.targetType);
    const { stdout } = await command.collectOutput();
    return this.sanitizeSchemaForPglite(stdout);
  }

  /**
   * Used to prepare data being returned to pglite.
   * Not necessary for when the target is another pg database
   */
  private sanitizeSchemaForPglite(schema: string): string {
    // strip CREATE SCHEMA statements and a little bit of extra whitespace.
    // Important: we ONLY want to remove the public schema directive.
    // If the user wants to dump a different schema it still needs to be created
    // we should also remove the comments describing the schema above but meh
    return schema.replace(/^CREATE SCHEMA public.*\n\n?/m, "")
      // strip unrestrict and restrict statements. They're only valid for psql
      // and will break things if imported by pglite
      // added in pg_dump 17.6+
      .replace(/^\\(un)?restrict\s+.*\n?/gm, "");
  }
}

export class DumpCommand
  extends EventEmitter<{ restore: [string]; dump: [string] }> {
  public static readonly binaryPath = findPgDumpBinary("17.2");
  // we're intentionally NOT excluding the "extensions" schema
  // because supabase has triggers on that schema that cannot be
  // omitted without manual schema finagling which we want to keep
  // to a minimum to reduce complexity.
  // Everything else is safe to exclude
  // https://gist.github.com/Xetera/067c613580320468e8367d9d6c0e06ad
  private static readonly supabaseExcludedSchemas = [
    "extensions",
    "graphql",
    "auth",
    "graphql_public",
    "pgsodium",
    "pgbouncer",
    "storage",
    "realtime",
    "vault",
  ];

  private static readonly supabaseExcludedExtensions = [
    "pgsodium",
    "pg_graphql",
    "supabase_vault",
    "extensions",
    // we want to create our own pg_stat_statements
    // supabase creates PSS in the "extensions" schema
    // which we can't do anything with
    "pg_stat_statements",
    "pgcrypto",
    "uuid-ossp",
  ];

  // we don't want to allow callers to construct an instance
  // with any arbitrary child process. Use the static method instead
  private constructor(private readonly childProcess: ChildProcess) {
    super();
  }

  static excludedSchemas(connectable: Connectable): string[] {
    if (connectable.isSupabase()) {
      return this.supabaseExcludedSchemas;
    }
    return [];
  }

  static spawn(
    connectable: Connectable,
    targetType: DumpTargetType,
  ): DumpCommand {
    const args = [
      // the owner doesn't exist
      "--no-owner",
      // not needed most likely
      "--no-comments",
      // the user doesn't exist where we're restoring this dump
      "--no-privileges",
      // normally found in supabase dumps but not wanted in general
      "--no-publications",
      // not sure if this is 100% necessary but we don't want triggers anyway
      "--disable-triggers",
      // this is our alternative to `--schema-only`
      "--exclude-table-data-and-children",
      // it excludes all user data
      "public.*",
      "--exclude-table-data-and-children",
      // and some specific stuff from timescaledb, but not its chunks
      "_timescaledb_internal._hyper_*",
      "--exclude-table-data-and-children",
      // also including compressed hypertable chunks
      "_timescaledb_internal.compress_hyper_*",
      ...DumpCommand.formatFlags(targetType),
      ...DumpCommand.extraFlags(connectable),
      connectable.toString(),
    ];

    const childProcess = spawn(DumpCommand.binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: shutdownController.signal,
    });

    return new DumpCommand(childProcess);
  }

  collectOutput(): Promise<DumpCommandOutput> {
    const span = trace.getActiveSpan();

    return new Promise<DumpCommandOutput>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      this.childProcess.stdout!.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      this.childProcess.stderr!.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      this.childProcess.on("close", (code) => {
        const stdoutBuf = Buffer.concat(stdoutChunks);
        const stderrBuf = Buffer.concat(stderrChunks);

        span?.setAttribute("outputBytes", stdoutBuf.byteLength);

        withSpan("decodeResponse", () => {
          const stderr = stderrBuf.byteLength > 0
            ? stderrBuf.toString()
            : undefined;
          if (stderr) {
            console.warn(stderr);
          }
          if (code !== 0) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: stderr });
            log.error(`Error: ${stderr}`, "schema:sync");
            reject(new Error(stderr));
            return { stdout: "", stderr };
          }
          log.info(
            `Dumped schema. bytes=${stdoutBuf.byteLength}`,
            "schema:sync",
          );
          const stdout = stdoutBuf.toString();
          resolve({ stdout, stderr });
          return { stdout, stderr };
        })();
      });

      this.childProcess.on("error", reject);
    });
  }

  async pipeTo(restore: RestoreCommand): Promise<RestoreCommandResult> {
    this.childProcess.stderr!.on("data", (chunk: Buffer) => {
      this.emit("dump", chunk.toString());
    });

    restore.stderr.on("data", (chunk: Buffer) => {
      this.emit("restore", chunk.toString());
    });
    restore.stdout.on("data", (chunk: Buffer) => {
      this.emit("restore", chunk.toString());
    });

    this.childProcess.stdout!.pipe(restore.stdin);

    const [dumpStatus, restoreStatus] = await Promise.all([
      waitForExit(this.childProcess),
      waitForExit(restore.childProcess),
    ]);

    return {
      dump: { status: dumpStatus },
      restore: { status: restoreStatus },
    };
  }

  /**
   * Text format is used when the dump is restored by pglite
   * we use the binary format when piping the command to pg_restore
   * or any other locally running postgres instance
   */
  private static formatFlags(format: DumpTargetType): string[] {
    if (format === "native-postgres") {
      return ["--format", "custom"];
    }
    return ["--format", "plain"];
  }

  private static excludedExtensions(connectable: Connectable): string[] {
    if (connectable.isSupabase()) {
      return this.supabaseExcludedExtensions;
    }
    return [];
  }

  private static extraFlags(
    connectable: Connectable,
  ): string[] {
    // creating an array twice just for flags is super inefficient
    const flags = [
      ...this.excludedSchemas(connectable).flatMap((schema) => [
        "--exclude-schema",
        schema,
      ]),
      ...this.excludedExtensions(connectable).flatMap(
        (extension) => [
          "--exclude-extension",
          extension,
        ],
      ),
    ];

    return flags;
  }
}

export type DumpCommandOutput = {
  stdout: string;
  stderr?: string;
};

/**
 * Represents a `pg_restore` command.
 * This class does NOT perform cleanup for the target database like is needed when syncing from supabase.
 *
 * Commands like `drop schema if exists extensions cascade;` need to be run independently after the restore.
 */
export class RestoreCommand {
  public static readonly binaryPath = findPgRestoreBinary("17.2");
  readonly childProcess: ChildProcess;

  private constructor(childProcess: ChildProcess) {
    this.childProcess = childProcess;
  }

  static spawn(connectable: Connectable): RestoreCommand {
    const args = [
      "--no-owner",
      "--no-acl",
      "--verbose",
      "--disable-triggers",
      ...RestoreCommand.formatFlags(),
      "--dbname",
      connectable.toString(),
    ];

    const childProcess = spawn(RestoreCommand.binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: shutdownController.signal,
    });

    return new RestoreCommand(childProcess);
  }

  get stdin() {
    return this.childProcess.stdin!;
  }

  get stdout() {
    return this.childProcess.stdout!;
  }

  get stderr() {
    return this.childProcess.stderr!;
  }

  get status(): Promise<CommandStatus> {
    return waitForExit(this.childProcess);
  }

  async cleanup() {
    this.childProcess.stdout?.destroy();
    this.childProcess.stderr?.destroy();
  }

  private static formatFlags(): string[] {
    return ["--format", "custom"];
  }
}

export type RestoreCommandResult = {
  dump: {
    status: CommandStatus;
  };
  restore?: {
    status: CommandStatus;
  };
};

function waitForExit(child: ChildProcess): Promise<CommandStatus> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, success: child.exitCode === 0 });
      return;
    }
    child.on("close", (code) => {
      resolve({ code, success: code === 0 });
    });
  });
}
