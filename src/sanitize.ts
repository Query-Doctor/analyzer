import crypto from "node:crypto";
import { env } from "./env.ts";

export function sanitizePostgresUrl(db: string): string {
  // sanitization is only needed for the hosted instance
  if (!env.HOSTED) {
    return db;
  }
  const hash = crypto.createHash("sha256").update(db).digest("hex");
  return `omitted__${hash.slice(0, 8)}`;
}
