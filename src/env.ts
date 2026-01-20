import { z } from "zod";
import { mapValues } from "@std/collections";

const envSchema = z.object({
  CI: z.stringbool().default(false),
  // sync
  PG_DUMP_BINARY: z.string().optional(),
  PG_RESTORE_BINARY: z.string().optional(),
  // is this instance hosted on the cloud (as opposed to self-hosted?)
  HOSTED: z.stringbool().default(false),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().min(1024).max(65535).default(2345),
  // analyzer
  MAX_COST: z.coerce.number().optional(),
  GITHUB_TOKEN: z.string().optional(),
  LOG_PATH: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
  DEBUG: z.stringbool().default(false),
  STATISTICS_PATH: z.string().optional(),
});

// we want to avoid asking for ALL env permissions if possible
export const env = envSchema.parse(
  mapValues(envSchema.shape, (_, key) => Deno.env.get(key)),
);
