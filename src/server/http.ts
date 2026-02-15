import { SpanStatusCode, trace } from "@opentelemetry/api";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { PostgresSyncer } from "../sync/syncer.ts";
import { log } from "../log.ts";
import { LiveQueryRequest, SyncRequest } from "./sync.dto.ts";
import { ZodError } from "zod";
import { env } from "../env.ts";
import { SyncResult } from "../sync/syncer.ts";
import * as errors from "../sync/errors.ts";
import { RemoteController } from "../remote/remote-controller.ts";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Remote } from "../remote/remote.ts";

const sourceConnectionManager = ConnectionManager.forRemoteDatabase();

const syncer = new PostgresSyncer(sourceConnectionManager);

async function onSync(body: unknown) {
  const startTime = Date.now();

  let parsed: SyncRequest;
  try {
    parsed = SyncRequest.parse(body);
  } catch (e: unknown) {
    if (e instanceof ZodError) {
      return {
        status: 400,
        body: {
          kind: "error",
          type: "invalid_body",
          error: e.issues.map((issue) => issue.message).join("\n"),
        },
      };
    }
    return {
      status: 400,
      body: {
        kind: "error",
        type: "unexpected_error",
        error: String(e),
      },
    };
  }
  const { seed, requiredRows, maxRows } = parsed;
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
  let result: SyncResult;
  try {
    result = await syncer.syncDDL(parsed.db, {
      requiredRows,
      maxRows,
      seed,
    });
  } catch (error) {
    if (error instanceof errors.ExtensionNotInstalledError) {
      return { status: error.statusCode ?? 500, body: error.toJSON() };
    } else if (error instanceof errors.MaxTableIterationsReached) {
      return { status: error.statusCode ?? 500, body: error.toJSON() };
    }
    return makeUnexpectedErrorResult(error);
  }
  span?.setStatus({ code: SpanStatusCode.OK });
  log.info(`Sent sync response in ${Date.now() - startTime}ms`, "http:sync");
  return {
    status: 200,
    body: { kind: "ok", ...result },
  };
}

async function onSyncLiveQuery(body: unknown) {
  let parsed: LiveQueryRequest;
  try {
    parsed = LiveQueryRequest.parse(body);
  } catch (e: unknown) {
    if (e instanceof ZodError) {
      return {
        status: 400,
        body: {
          kind: "error",
          type: "invalid_body",
          error: e.issues.map((issue) => issue.message).join("\n"),
        },
      };
    }
    throw e;
  }
  try {
    const { queries, deltas } = await syncer.liveQuery(parsed.db);
    return { status: 200, body: { kind: "ok", queries, deltas } };
  } catch (error) {
    if (error instanceof errors.ExtensionNotInstalledError) {
      return { status: error.statusCode ?? 500, body: error.toJSON() };
    } else if (error instanceof errors.PostgresError) {
      return { status: error.statusCode ?? 500, body: error.toJSON() };
    }
    return makeUnexpectedErrorResult(error);
  }
}

export async function createServer(
  hostname: string,
  port: number,
  targetDb?: Connectable,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  await fastify.register(cors, {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    exposedHeaders: [
      "Content-Type",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ],
    maxAge: 86400,
  });

  if (env.HOSTED) {
    await fastify.register(rateLimit, {
      max: 100,
      timeWindow: "15 minutes",
    });
  }

  await fastify.register(websocket);

  const optimizingDbConnectionManager = ConnectionManager.forLocalDatabase();

  const remoteController = targetDb
    ? new RemoteController(
        new Remote(targetDb, optimizingDbConnectionManager),
      )
    : undefined;

  fastify.get("/", async (_request, reply) => {
    return reply.redirect("https://github.com/Query-Doctor/analyzer", 307);
  });

  fastify.get("/health", async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  fastify.post("/postgres/all", async (request, reply) => {
    log.info(`[POST] /postgres/all`, "http");
    const result = await onSync(request.body);
    return reply.status(result.status).send(result.body);
  });

  fastify.post("/postgres/live", async (request, reply) => {
    log.info(`[POST] /postgres/live`, "http");
    const result = await onSyncLiveQuery(request.body);
    return reply.status(result.status).send(result.body);
  });

  if (remoteController) {
    fastify.post("/postgres", async (request, reply) => {
      log.info(`[POST] /postgres`, "http");
      const result = await remoteController.onFullSync(
        JSON.stringify(request.body),
      );
      return reply.status(result.status).send(result.body);
    });

    fastify.get("/postgres", async (request, reply) => {
      log.info(`[GET] /postgres`, "http");
      const result = await remoteController.getStatus();
      return reply.send(result);
    });

    fastify.register(async function (app) {
      app.get(
        "/postgres/ws",
        { websocket: true },
        (socket, _request) => {
          remoteController.onWebsocketConnection(socket);
        },
      );
    });

    fastify.post("/postgres/indexes", async (request, reply) => {
      log.info(`[POST] /postgres/indexes`, "http");
      const result = await remoteController.createIndex(request.body);
      return reply.status(result.status).send(result.body);
    });

    fastify.post("/postgres/indexes/toggle", async (request, reply) => {
      log.info(`[POST] /postgres/indexes/toggle`, "http");
      const result = await remoteController.toggleIndex(request.body);
      return reply.status(result.status).send(result.body);
    });

    fastify.post("/postgres/reset", async (request, reply) => {
      log.info(`[POST] /postgres/reset`, "http");
      const result = await remoteController.onReset(
        JSON.stringify(request.body),
      );
      return reply.status(result.status).send(result.body);
    });
  }

  await fastify.listen({ host: hostname, port });
  return fastify;
}

function makeUnexpectedErrorResult(error: unknown) {
  if (error instanceof Error && !env.HOSTED) {
    return {
      status: 500,
      body: { kind: "error", type: "unexpected_error", error: error.message },
    };
  }
  console.error(error);
  return {
    status: 500,
    body: {
      kind: "error",
      type: "unexpected_error",
      error: "Internal Server Error",
    },
  };
}
