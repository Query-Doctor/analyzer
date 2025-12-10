import { env } from "../env.ts";
import { RecentQuery } from "../sql/recent-query.ts";
import { QueryOptimizer } from "./query-optimizer.ts";
import { RemoteSyncRequest } from "./remote.dto.ts";
import { Remote } from "./remote.ts";

export class RemoteController {
  /**
   * Only a single socket can be active at the same time.
   * Multi-tab support not currently available
   */
  private socket?: WebSocket;

  constructor(
    private readonly remote: Remote,
  ) {
    this.hookUpWebsockets(remote.optimizer);
  }

  async execute(
    request: Request,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/postgres") {
      const isWebsocket = request.headers.get("upgrade") === "websocket";
      if (isWebsocket) {
        return this.onWebsocketRequest(request);
      } else if (request.method === "POST") {
        return await this.onFullSync(request);
      }
    }
  }

  private hookUpWebsockets(optimizer: QueryOptimizer) {
    optimizer.on(
      "noImprovements",
      this.eventNoImprovementsAvailable.bind(this),
    );
    optimizer.on(
      "improvementsAvailable",
      this.eventImprovementsAvailable.bind(this),
    );
    optimizer.on("error", this.eventError.bind(this));
    optimizer.on("timeout", this.eventTimeout.bind(this));
    optimizer.on("zeroCostPlan", this.eventZeroCostPlan.bind(this));
    optimizer.on("queryUnsupported", this.eventQueryUnsupported.bind(this));
  }

  private async onFullSync(request: Request): Promise<Response> {
    const body = RemoteSyncRequest.safeDecode(await request.text());
    if (!body.success) {
      return new Response(JSON.stringify(body.error), { status: 400 });
    }

    const { db } = body.data;
    try {
      const sync = await this.remote.syncFrom(db);
      return Response.json(sync);
    } catch (error) {
      console.error(error);
      return Response.json({
        error: env.HOSTED ? "Internal Server Error" : error,
        message: "Failed to sync database",
      }, {
        status: 500,
      });
    }
  }

  private onWebsocketRequest(request: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(request);
    console.log({ socket });
    this.socket = socket;

    socket.addEventListener("close", () => {
      this.socket = undefined;
    });

    return response;
  }

  private eventNoImprovementsAvailable(query: RecentQuery) {
    this.socket?.send(
      JSON.stringify({ type: "noImprovements", query }),
    );
  }

  private eventImprovementsAvailable(query: RecentQuery) {
    this.socket?.send(
      JSON.stringify({ type: "improvementsAvailable", query }),
    );
  }

  private eventError(recentQuery: RecentQuery, error: Error) {
    this.socket?.send(
      JSON.stringify({
        type: "error",
        query: recentQuery,
        error: error.message,
      }),
    );
  }

  private eventTimeout(recentQuery: RecentQuery, waitedMs: number) {
    this.socket?.send(
      JSON.stringify({
        type: "timeout",
        query: recentQuery,
        waitTimeMs: waitedMs,
      }),
    );
  }

  private eventZeroCostPlan(recentQuery: RecentQuery) {
    this.socket?.send(
      JSON.stringify({ type: "zeroCostPlan", query: recentQuery }),
    );
  }

  private eventQueryUnsupported(query: RecentQuery) {
    this.socket?.send(
      JSON.stringify({ type: "queryUnsupported", query }),
    );
  }
}
