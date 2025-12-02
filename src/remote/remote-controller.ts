import { env } from "../env.ts";
import { RemoteSyncRequest } from "./remote.dto.ts";
import { Remote } from "./remote.ts";

export class RemoteController {
  constructor(
    private readonly remote: Remote,
  ) {}

  async execute(
    request: Request,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/postgres" && request.method === "POST") {
      return await this.onFullSync(request);
    }
  }

  async onFullSync(request: Request): Promise<Response> {
    const body = RemoteSyncRequest.safeParse(await request.json());
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
}
