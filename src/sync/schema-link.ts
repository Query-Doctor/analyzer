import { SpanStatusCode, trace } from "@opentelemetry/api";
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
  private constructor(private readonly process: Deno.ChildProcess) {
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
      "--schema-only",
      ...DumpCommand.formatFlags(targetType),
      ...DumpCommand.extraFlags(connectable, targetType),
      connectable.toString(),
    ];
    const command = new Deno.Command(DumpCommand.binaryPath, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: shutdownController.signal,
    });

    const process = command.spawn();

    return new DumpCommand(process);
  }

  async collectOutput(): Promise<DumpCommandOutput> {
    const span = trace.getActiveSpan();
    const decoder = new TextDecoder();
    const output = await this.process.output();
    span?.setAttribute("outputBytes", output.stdout.byteLength);
    return withSpan("decodeResponse", () => {
      const stderr = output.stderr.byteLength > 0
        ? decoder.decode(output.stderr)
        : undefined;
      if (stderr) {
        console.warn(stderr);
      }
      if (output.code !== 0) {
        span?.setStatus({ code: SpanStatusCode.ERROR, message: stderr });
        log.error(`Error: ${stderr}`, "schema:sync");
        throw new Error(stderr);
      }
      log.info(
        `Dumped schema. bytes=${output.stdout.byteLength}`,
        "schema:sync",
      );
      const stdout = decoder.decode(output.stdout);
      return { stdout, stderr };
    })();
  }

  async pipeTo(restore: RestoreCommand): Promise<RestoreCommandResult> {
    // Start consuming stderr in the background to prevent resource leaks
    // const stderrPromise = this.process.stderr.text();

    const decoder = new TextDecoder();
    this.process.stderr.pipeTo(
      new WritableStream({
        write: (chunk) => {
          this.emit("dump", decoder.decode(chunk));
        },
      }),
    );

    restore.stderr.pipeTo(
      new WritableStream({
        write: (chunk) => {
          this.emit("restore", decoder.decode(chunk));
        },
      }),
    );
    restore.stdout.pipeTo(
      new WritableStream({
        write: (chunk) => {
          this.emit("restore", decoder.decode(chunk));
        },
      }),
    );

    try {
      await this.process.stdout.pipeTo(restore.stdin);
    } catch (_error) {
      return {
        dump: {
          status: await this.process.status,
        },
      };
    }

    const dumpStatus = await this.process.status;
    // this only fails if the command is non-zero
    const restoreStatus = await restore.status;
    const out = {
      dump: {
        status: dumpStatus,
      },
      restore: {
        status: restoreStatus,
      },
    };
    await restore.cleanup();
    return out;
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
    format: DumpTargetType,
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
    // we want to drop existing objects when syncing
    // to regular postgres. Not needed for pglite
    // since we always create a new db anyway
    if (format === "native-postgres") {
      flags.push("--clean", "--if-exists");
    }

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
  private constructor(private process: Deno.ChildProcess) {}

  static spawn(connectable: Connectable): RestoreCommand {
    const args = [
      "--no-owner",
      "--no-acl",
      "--clean",
      "--if-exists",
      "--verbose",
      ...RestoreCommand.formatFlags(),
      "--dbname",
      connectable.toString(),
    ];

    const command = new Deno.Command(RestoreCommand.binaryPath, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: shutdownController.signal,
    });

    const process = command.spawn();

    return new RestoreCommand(process);
  }

  get stdin() {
    return this.process.stdin;
  }

  get stdout() {
    return this.process.stdout;
  }

  get stderr() {
    return this.process.stderr;
  }

  get status() {
    return this.process.status;
  }

  async cleanup() {
    if (!this.process.stdout.locked) {
      await this.process.stdout.cancel();
    }
    if (!this.process.stderr.locked) {
      await this.process.stderr.cancel();
    }
  }

  private static formatFlags(): string[] {
    return ["--format", "custom"];
  }
}

export type RestoreCommandResult = {
  dump: {
    status: Deno.CommandStatus;
  };
  restore?: {
    status: Deno.CommandStatus;
  };
};
