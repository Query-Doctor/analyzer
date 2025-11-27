import { SpanStatusCode, trace } from "@opentelemetry/api";
import { log } from "../log.ts";
import { shutdownController } from "../shutdown.ts";
import { env } from "../env.ts";
import { withSpan } from "../otel.ts";
import { Connectable } from "./connectable.ts";

export type TableStats = {
  name: string;
};

export type DumpFormat = "as-text" | "as-binary";

export class PostgresSchemaLink {
  private static readonly PG_DUMP_VERSION = "17.2";
  public static readonly pgDumpBinaryPath = PostgresSchemaLink
    .findPgDumpBinary();

  constructor(
    public readonly connectable: Connectable,
    public readonly format: DumpFormat,
  ) {}

  // we're intentionally NOT excluding the "extensions" schema
  // because supabase has triggers on that schema that cannot be
  // omitted without manual schema finagling which we want to keep
  // to a minimum to reduce complexity.
  // Everything else is safe to exclude
  // https://gist.github.com/Xetera/067c613580320468e8367d9d6c0e06ad
  public static readonly supabaseExcludedSchemas = [
    "graphql",
    "auth",
    "graphql_public",
    "pgsodium",
    "pgbouncer",
    "storage",
    "realtime",
    "vault",
  ];

  public static readonly supabaseExcludedExtensions = [
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

  static findPgDumpBinary(): string {
    const forcePath = env.PG_DUMP_BINARY;
    if (forcePath) {
      log.info(
        `Using pg_dump binary from env(PG_DUMP_BINARY): ${forcePath}`,
        "schema:setup",
      );
      return forcePath;
    }
    const os = Deno.build.os;
    const arch = Deno.build.arch;
    const shippedPath =
      `./bin/pg_dump-${this.PG_DUMP_VERSION}/pg_dump.${os}-${arch}`;
    if (!Deno.statSync(shippedPath).isFile) {
      throw new Error(`pg_dump binary not found at ${shippedPath}`);
    }
    log.info(`Using built-in "pg_dump" binary: ${shippedPath}`, "schema:setup");
    return shippedPath;
  }

  spawnDumpCommand(): DumpCommand {
    const command = this.pgDumpCommand();
    return new DumpCommand(command.spawn());
  }

  async dumpAsText(): Promise<string> {
    const command = this.spawnDumpCommand();
    const { stdout } = await command.collectOutput();
    return this.sanitizeSchemaForPglite(stdout);
  }

  excludedSchemas() {
    if (this.connectable.isSupabase()) {
      return PostgresSchemaLink.supabaseExcludedSchemas;
    }
    return [];
  }

  excludedExtensions() {
    if (this.connectable.isSupabase()) {
      return PostgresSchemaLink.supabaseExcludedExtensions;
    }
    return [];
  }

  private pgDumpCommand(): Deno.Command {
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
      ...this.formatFlags(),
      ...this.extraFlags(),
      this.connectable.toString(),
    ];
    return new Deno.Command(PostgresSchemaLink.pgDumpBinaryPath, {
      args,
      stdout: "piped",
      stderr: "piped",
      signal: shutdownController.signal,
    });
  }

  /**
   * Text format is used when the dump is restored by pglite
   * we use the binary format when piping the command to pg_restore
   * or any other locally running postgres instance
   */
  private formatFlags(): string[] {
    if (this.format === "as-binary") {
      return ["--format", "custom"];
    }
    return ["--format", "plain"];
  }

  private extraFlags(): string[] {
    // creating an array twice just for flags is super inefficient
    return [
      ...this.excludedSchemas().flatMap((schema) => [
        "--exclude-schema",
        schema,
      ]),
      ...this.excludedExtensions().flatMap(
        (extension) => [
          "--exclude-extension",
          extension,
        ],
      ),
    ];
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

class DumpCommand {
  constructor(private readonly process: Deno.ChildProcess) {}

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
}

export type DumpCommandOutput = {
  stdout: string;
  stderr?: string;
};

// Don't allow class construction outside the file
export type { DumpCommand };
