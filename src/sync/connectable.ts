import { z } from "zod/v4";
import { env } from "../env.ts";

/**
 * Represents a valid connection to a database.
 * Connectable instances are always pre-validated and don't need to be validated again.
 */
export class Connectable {
  private constructor(public readonly url: URL) {}

  /**
   * Custom logic for parsing a string into a Connectable through zod.
   */
  static transform(
    urlString: string,
    ctx: z.RefinementCtx<string>
  ): Connectable {
    if (
      !urlString.startsWith("postgres://") &&
      !urlString.startsWith("postgresql://")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "URL must start with 'postgres://' or 'postgresql://'",
        expected: "string",
        input: urlString,
      });
      return z.NEVER;
    }

    let url: URL;
    try {
      url = new URL(urlString);
    } catch (_: unknown) {
      ctx.addIssue({
        code: "invalid_type",
        message: "Invalid URL",
        expected: "string",
        input: urlString,
      });
      return z.NEVER;
    }
    // we don't want to allow localhost access for hosted sync instances
    // to prevent users from connecting to our hosted db
    // (even though all our dbs should should be password protected)
    const isLocalhost =
      url.hostname === "localhost" ||
      // ipv4 localhost
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname) ||
      // ipv6 localhost
      url.hostname === "[::1]";
    if (isLocalhost && env.HOSTED) {
      ctx.addIssue({
        code: "custom",
        message:
          "Syncing to localhost is not allowed. Run the sync server locally to access your local database",
      });
    }
    // Our current hosted sync instances do not support ipv6
    // we need users to use pooler.supabase.com instead
    if (env.HOSTED && Connectable.isDirectSupabaseConnection(url)) {
      const account = Connectable.extractSupabaseAccount(url);
      // send the user directly to the right place if there's an account available
      const link = account
        ? `https://supabase.com/dashboard/project/${account}?showConnect=true`
        : "https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP";
      ctx.addIssue({
        code: "custom",
        message: `You are using a direct connection to a supabase instance. Supabase does not accept IPv4 connections, try using a transaction pooler connection instead ${link}`,
      });
    }
    if (ctx.issues.length > 0) {
      return z.NEVER;
    }
    return new Connectable(url);
  }

  private static extractSupabaseAccount(url: URL): string | undefined {
    const match = url.toString().match(/db\.(\w+)\.supabase\.co/);
    if (!match) {
      return;
    }
    return match[1];
  }

  private static isDirectSupabaseConnection(url: URL) {
    return (
      url.hostname.includes("supabase.co") &&
      !url.hostname.includes("pooler.supabase.co")
    );
  }

  toString() {
    return this.url.toString();
  }
}
