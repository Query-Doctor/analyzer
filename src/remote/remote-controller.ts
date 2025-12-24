import { env } from "../env.ts";
import { OptimizedQuery } from "../sql/recent-query.ts";
import { QueryOptimizer } from "./query-optimizer.ts";
import { RemoteSyncRequest } from "./remote.dto.ts";
import { Remote } from "./remote.ts";

export class RemoteController {
  /**
   * Only a single socket can be active at the same time.
   * Multi-tab support not currently available
   */
  private socket?: WebSocket;
  private syncResponse?: ReturnType<Remote["syncFrom"]>;

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
    const onQueryProcessed = this.eventOnQueryProcessed.bind(this);
    const onError = this.eventError.bind(this);
    optimizer.on("noImprovements", onQueryProcessed);
    optimizer.on("improvementsAvailable", onQueryProcessed);
    optimizer.on("error", onError);
    optimizer.on("timeout", onQueryProcessed);
    optimizer.on("zeroCostPlan", onQueryProcessed);
  }

  private async onFullSync(request: Request): Promise<Response> {
    const body = RemoteSyncRequest.safeDecode(await request.text());
    if (!body.success) {
      return new Response(JSON.stringify(body.error), { status: 400 });
    }

    const { db } = body.data;
    try {
      if (!this.syncResponse) {
        this.syncResponse = this.remote.syncFrom(db);
      }
      const { schema } = await this.syncResponse;
      const queries = this.remote.optimizer.getQueries();

      return Response.json({ schema, queries: { type: "ok", value: queries } });
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

    socket.addEventListener("open", () => {
      this.syncResponse = undefined;
    });

    socket.addEventListener("close", () => {
      this.socket = undefined;
    });

    return response;
  }

  private eventOnQueryProcessed(query: OptimizedQuery) {
    this.socket?.send(JSON.stringify({
      type: "queryProcessed",
      query,
    }));
  }

  private eventError(error: Error, query: OptimizedQuery) {
    this.socket?.send(
      JSON.stringify({
        type: "error",
        query,
        error: error.message,
      }),
    );
  }
}
