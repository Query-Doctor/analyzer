import { randomBytes } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { PgIdentifier } from "@query-doctor/core";
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
    methods: ["GET", "POST", "DELETE"],
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

  // -- Session management for multi-user (demo) mode --
  type Session = {
    controller: RemoteController;
    remote: Remote;
    manager: ConnectionManager;
    sourceManager: ConnectionManager;
    createdAt: number;
  };

  const sessions = new Map<string, Session>();

  // Shared manager for the default (single-user) Remote
  const optimizingDbConnectionManager = ConnectionManager.forLocalDatabase();

  // Default controller for non-session requests (backward compat)
  const defaultController = targetDb
    ? new RemoteController(
        new Remote(targetDb, optimizingDbConnectionManager),
      )
    : undefined;

  function makeSession(sessionId: string): Session {
    const dbName = PgIdentifier.fromString(`sync_${sessionId}`);
    const manager = ConnectionManager.forLocalDatabase();
    const srcManager = ConnectionManager.forRemoteDatabase();
    const remote = new Remote(targetDb!, manager, srcManager, dbName);
    const controller = new RemoteController(remote);
    const session: Session = {
      controller,
      remote,
      manager,
      sourceManager: srcManager,
      createdAt: Date.now(),
    };
    sessions.set(sessionId, session);
    log.info(`Created session ${sessionId} (db: sync_${sessionId})`, "http");
    return session;
  }

  async function destroySession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    const dbName = session.remote.sessionDbName;
    await session.remote.cleanup();

    // Drop the session database using the shared connection manager
    if (targetDb) {
      const baseDbUrl = targetDb.withDatabaseName(Remote.baseDbName);
      const baseDb = optimizingDbConnectionManager.getOrCreateConnection(baseDbUrl);
      await baseDb.exec(`drop database if exists ${dbName} with (force);`);
    }

    sessions.delete(sessionId);
    log.info(`Destroyed session ${sessionId}`, "http");
  }

  function generateSessionId(): string {
    return randomBytes(4).toString("hex");
  }

  /**
   * Resolve which controller to use for a request.
   * If sessionId is provided, look up the session. Otherwise use the default.
   */
  function resolveController(sessionId?: string): RemoteController | undefined {
    if (sessionId) {
      return sessions.get(sessionId)?.controller;
    }
    return defaultController;
  }

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

  if (targetDb) {
    fastify.post("/postgres", async (request, reply) => {
      log.info(`[POST] /postgres`, "http");

      const body = request.body as Record<string, unknown>;
      let controller: RemoteController;
      let sessionId: string | undefined;

      if (body.createSession === true) {
        // Demo/multi-user mode: create a new isolated session
        sessionId = generateSessionId();
        const session = makeSession(sessionId);
        controller = session.controller;
      } else if (typeof body.sessionId === "string") {
        // Reuse an existing session
        sessionId = body.sessionId;
        const session = sessions.get(sessionId);
        if (!session) {
          return reply.status(404).send({ error: "Session not found" });
        }
        controller = session.controller;
      } else if (defaultController) {
        controller = defaultController;
      } else {
        return reply.status(500).send({ error: "No target database configured" });
      }

      const result = await controller.onFullSync(JSON.stringify(body));

      const responseBody = sessionId
        ? { ...(result.body as object), sessionId }
        : result.body;

      return reply.status(result.status).send(responseBody);
    });

    fastify.get("/postgres", async (request, reply) => {
      log.info(`[GET] /postgres`, "http");

      const query = request.query as Record<string, unknown>;
      const sessionId = typeof query.sessionId === "string"
        ? query.sessionId
        : undefined;

      const controller = resolveController(sessionId);
      if (!controller) {
        const msg = sessionId ? "Session not found" : "No target database configured";
        return reply.status(sessionId ? 404 : 500).send({ error: msg });
      }

      const result = await controller.getStatus();
      return reply.send(result);
    });

    fastify.register(async function (app) {
      app.get(
        "/postgres/ws",
        { websocket: true },
        (socket, _request) => {
          // Websocket only supported for default (single-user) mode
          defaultController?.onWebsocketConnection(socket);
        },
      );
    });

    fastify.post("/postgres/indexes", async (request, reply) => {
      log.info(`[POST] /postgres/indexes`, "http");
      const body = request.body as Record<string, unknown>;
      const sessionId = typeof body.sessionId === "string"
        ? body.sessionId
        : undefined;

      const controller = resolveController(sessionId);
      if (!controller) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const result = await controller.createIndex(body);
      return reply.status(result.status).send(result.body);
    });

    fastify.post("/postgres/indexes/toggle", async (request, reply) => {
      log.info(`[POST] /postgres/indexes/toggle`, "http");
      const body = request.body as Record<string, unknown>;
      const sessionId = typeof body.sessionId === "string"
        ? body.sessionId
        : undefined;

      const controller = resolveController(sessionId);
      if (!controller) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const result = await controller.toggleIndex(body);
      return reply.status(result.status).send(result.body);
    });

    fastify.post("/postgres/reset", async (request, reply) => {
      log.info(`[POST] /postgres/reset`, "http");
      const body = request.body as Record<string, unknown>;
      const sessionId = typeof body.sessionId === "string"
        ? body.sessionId
        : undefined;

      const controller = resolveController(sessionId);
      if (!controller) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const result = await controller.onReset(JSON.stringify(body));
      return reply.status(result.status).send(result.body);
    });

    fastify.delete("/postgres/session/:sessionId", async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      log.info(`[DELETE] /postgres/session/${sessionId}`, "http");

      if (!sessions.has(sessionId)) {
        return reply.status(404).send({ error: "Session not found" });
      }

      try {
        await destroySession(sessionId);
        return reply.send({ success: true });
      } catch (error) {
        console.error(`Failed to destroy session ${sessionId}:`, error);
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "Failed to destroy session",
        });
      }
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
