import { SpanStatusCode, trace } from "@opentelemetry/api";
import { PostgresSyncer } from "../sync/syncer.ts";
import { log } from "../log.ts";
import * as limiter from "./rate-limit.ts";
import { LiveQueryRequest, SyncRequest } from "./sync.dto.ts";
import { ZodError } from "zod";
import { shutdownController } from "../shutdown.ts";
import { env } from "../env.ts";
import { SyncResult } from "../sync/syncer.ts";
import type { RateLimitResult } from "@rabbit-company/rate-limiter";
import * as errors from "../sync/errors.ts";
import { RemoteController } from "../remote/remote-controller.ts";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Remote } from "../remote/remote.ts";

const sourceConnectionManager = ConnectionManager.forRemoteDatabase();

const syncer = new PostgresSyncer(sourceConnectionManager);

async function onSync(req: Request) {
  const startTime = Date.now();
  const url = new URL(req.url);

  if (!req.body) {
    return new Response("Missing body", { status: 400 });
  }
  let body: SyncRequest;
  const bodyString = await req.text();
  try {
    body = SyncRequest.parse(JSON.parse(bodyString));
  } catch (e: unknown) {
    if (e instanceof ZodError) {
      return Response.json(
        {
          kind: "error",
          type: "invalid_body",
          error: e.issues.map((issue) => issue.message).join("\n"),
        },
        { status: 400 },
      );
    }
    return Response.json(
      {
        kind: "error",
        type: "unexpected_error",
        error: String(e),
      },
      { status: 400 },
    );
  }
  const { seed, requiredRows, maxRows } = body;
  const span = trace.getActiveSpan();
  if (requiredRows > maxRows) {
    log.warn(
      `Notice: \`requiredRows\` (${requiredRows}) is greater than \`maxRows\` (${maxRows})`,
      "http:sync",
    );
  }
  if (maxRows < requiredRows + 2) {
    log.warn(
      `Notice: \`maxRows\` (${maxRows}) is too low. This might cause problems with foreign keys`,
      "http:sync",
    );
  }
  span?.setAttribute("requiredRows", requiredRows);
  span?.setAttribute("db.host", url.hostname);
  let result: SyncResult;
  try {
    result = await syncer.syncDDL(body.db, {
      requiredRows,
      maxRows,
      seed,
    });
  } catch (error) {
    if (error instanceof errors.ExtensionNotInstalledError) {
      return error.toResponse();
    } else if (error instanceof errors.MaxTableIterationsReached) {
      return error.toResponse();
    }
    return makeUnexpectedErrorResponse(error);
  }
  span?.setStatus({ code: SpanStatusCode.OK });
  log.info(`Sent sync response in ${Date.now() - startTime}ms`, "http:sync");
  return Response.json(
    {
      kind: "ok",
      ...result,
    },
    { status: 200 },
  );
}

async function onSyncLiveQuery(req: Request) {
  let body: LiveQueryRequest;
  try {
    body = LiveQueryRequest.parse(await req.json());
  } catch (e: unknown) {
    if (e instanceof ZodError) {
      return Response.json(
        {
          kind: "error",
          type: "invalid_body",
          error: e.issues.map((issue) => issue.message).join("\n"),
        },
        { status: 400 },
      );
    }
    throw e;
  }
  try {
    const { queries, deltas } = await syncer.liveQuery(body.db);
    return Response.json({ kind: "ok", queries, deltas }, { status: 200 });
  } catch (error) {
    if (error instanceof errors.ExtensionNotInstalledError) {
      return error.toResponse();
    } else if (error instanceof errors.PostgresError) {
      return error.toResponse();
    }
    return makeUnexpectedErrorResponse(error);
  }
}

export function createServer(
  hostname: string,
  port: number,
  targetDb?: Connectable,
) {
  const optimizingDbConnectionManager = ConnectionManager.forLocalDatabase();

  const remoteController = targetDb
    ? new RemoteController(
      new Remote(targetDb, optimizingDbConnectionManager),
    )
    : undefined;
  return Deno.serve(
    { hostname, port, signal: shutdownController.signal },
    async (req, info) => {
      const url = new URL(req.url);
      log.http(req);

      if (req.method === "OPTIONS") {
        return transformResponse(
          new Response("OK", {
            status: 200,
            headers: corsHeaders,
          }),
        );
      }
      if (url.pathname === "/") {
        return Response.redirect(
          "https://github.com/Query-Doctor/analyzer",
          307,
        );
      }
      if (url.pathname === "/health") {
        return transformResponse(
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          }),
        );
      }
      const limit = limiter.sync.check(url.pathname, info.remoteAddr.hostname);
      if (limit.limited) {
        return limiter.appendHeaders(
          new Response("Rate limit exceeded", { status: 429 }),
          limit,
        );
      }
      try {
        if (url.pathname === "/postgres/all") {
          if (req.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const res = await onSync(req);
          return transformResponse(res, limit);
        } else if (url.pathname === "/postgres/live") {
          if (req.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const res = await onSyncLiveQuery(req);
          return transformResponse(res, limit);
        }
        const remoteResponse = await remoteController?.execute(req);
        if (remoteResponse) {
          // WebSocket upgrade responses have immutable headers, skip transform
          if (req.headers.get("upgrade") === "websocket") {
            return remoteResponse;
          }
          return transformResponse(remoteResponse, limit);
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        return transformResponse(
          new Response(
            JSON.stringify({
              error: error instanceof Error
                ? error.message
                : "Internal server error",
            }),
            {
              status: 500,
            },
          ),
          limit,
        );
      }
    },
  );
}

function transformResponse(res: Response, limit?: RateLimitResult): Response {
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.headers.set(key, value);
  }
  if (limit) {
    limiter.appendHeaders(res, limit);
  }
  return res;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  // cache the preflight requests for 1 day
  "Access-Control-Max-Age": "86400",
  "Access-Control-Allow-Methods": "POST",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers":
    "Content-Type, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
};

export function makeUnexpectedErrorResponse(error: unknown): Response {
  if (error instanceof Error && !env.HOSTED) {
    return Response.json(
      { kind: "error", type: "unexpected_error", error: error.message },
      { status: 500 },
    );
  }
  console.error(error);
  return Response.json(
    {
      kind: "error",
      type: "unexpected_error",
      error: "Internal Server Error",
    },
    { status: 500 },
  );
}
