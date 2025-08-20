import { z } from "zod/v4";
import { mapValues } from "@std/collections";

const envSchema = z.object({
  CI: z.coerce.boolean().default(false),
  // sync
  PG_DUMP_BINARY: z.string().optional(),
  HOSTED: z.coerce.boolean().default(false),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().min(1024).max(65535).default(2345),
  // analyzer
  MAX_COST: z.coerce.number().optional(),
  GITHUB_TOKEN: z.string().optional(),
  LOG_PATH: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
  DEBUG: z.coerce.boolean().default(false),
  STATISTICS_PATH: z.string().optional(),
});

// we want to avoid asking for ALL env permissions if possible
export const env = envSchema.parse(
  mapValues(envSchema.def.shape, (_, key) => Deno.env.get(key)),
);
