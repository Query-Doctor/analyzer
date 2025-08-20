import { SpanStatusCode, trace } from "@opentelemetry/api";
import { log } from "../log.ts";
import { shutdownController } from "../shutdown.ts";
import { env } from "../env.ts";
import { withSpan } from "../otel.ts";

export type TableStats = {
  name: string;
};

export class PostgresSchemaLink {
  private static readonly PG_DUMP_VERSION = "17.2";
  public static readonly pgDumpBinaryPath =
    PostgresSchemaLink.findPgDumpBinary();
  constructor(public readonly url: string, public readonly schema: string) {}

  static findPgDumpBinary(): string {
    const forcePath = env.PG_DUMP_BINARY;
    if (forcePath) {
      log.info(
        `Using pg_dump binary from env(PG_DUMP_BINARY): ${forcePath}`,
        "schema:setup"
      );
      return forcePath;
    }
    const os = Deno.build.os;
    const arch = Deno.build.arch;
    const shippedPath = `./bin/pg_dump-${this.PG_DUMP_VERSION}/pg_dump.${os}-${arch}`;
    if (!Deno.statSync(shippedPath).isFile) {
      throw new Error(`pg_dump binary not found at ${shippedPath}`);
    }
    log.info(`Using built-in "pg_dump" binary: ${shippedPath}`, "schema:setup");
    return shippedPath;
  }

  async syncSchema(schemaName: string): Promise<string> {
    log.debug(`Syncing schema (${schemaName})`, "schema:sync");
    // const [dumping, omits] = await this.omitBigBois();
    const args = [
      // the owner doesn't exist
      "--no-owner",
      // not needed most likely
      "--no-comments",
      // the user doesn't exist where we're restoring this dump
      "--no-privileges",
      // providers like supabase have a ton of stuff we don't need in other schemas
      "--schema",
      schemaName,
      "--schema-only",
      this.url,
    ];
    log.debug(`Dumping schema: pg_dump ${args.join(" ")}`, "schema:sync");
    const command = new Deno.Command(PostgresSchemaLink.pgDumpBinaryPath, {
      args,
      stdout: "piped",
      stderr: "piped",
      signal: shutdownController.signal,
    });
    const child = command.spawn();
    const output = await child.output();
    return this.handleSchemaOutput(output);
  }

  private handleSchemaOutput(output: Deno.CommandOutput) {
    const span = trace.getActiveSpan();
    const decoder = new TextDecoder();
    span?.setAttribute("outputBytes", output.stdout.byteLength);
    return withSpan("decodeResponse", () => {
      const stderr =
        output.stderr.byteLength > 0
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
        "schema:sync"
      );
      const stdout = decoder.decode(output.stdout);
      return this.sanitizeSchema(stdout);
    })();
  }

  private sanitizeSchema(schema: string): string {
    // strip CREATE SCHEMA statements and a little bit of extra whitespace.
    // we should also remove the comments describing the schema above but meh
    return schema.replace(/^CREATE SCHEMA\s+.*\n\n?/m, "");
  }
}
