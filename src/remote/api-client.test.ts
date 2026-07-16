import { afterEach, describe, expect, it, vi } from "vitest";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { Remote } from "./remote.ts";
import { ApiClient } from "./api-client.ts";

// Relay stand-in: answers `authenticate` with a ServerApi-shaped stub so
// ApiClient.connect runs its real handshake and dispose path over a genuine
// WebSocket. That transport is the only place capnweb fires onRpcBroken with
// "RPC session was shut down by disposing the main stub" — an in-memory session
// doesn't reproduce it, so the bug would slip through a lighter fake.
class FakeServerApi extends RpcTarget {
  async ping() {
    return true;
  }
}

class FakeRelay extends RpcTarget {
  async authenticate() {
    return new FakeServerApi();
  }
}

// In CI mode connect() never calls back into `remote` (that wiring is the
// persistent-server path), so an empty stand-in is enough.
const CI_MODE = { kind: "ci", branch: "main", sha: "" } as const;
const NO_REMOTE = {} as unknown as Remote;

async function startRelay() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const sockets: ServerSocket[] = [];
  const closes: Promise<void>[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    closes.push(new Promise((resolve) => socket.once("close", () => resolve())));
    newWebSocketRpcSession(socket as unknown as WebSocket, new FakeRelay());
  });
  const { port } = wss.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${port}`,
    dropConnection: () => sockets.forEach((s) => s.terminate()),
    // The client's onRpcBroken can only fire once its transport is gone.
    // Awaiting the server-observed close and then flushing the timer queue
    // guarantees that window has fully passed, so "callback not called" means it
    // genuinely never fired rather than that we asserted too early.
    afterTransportClosed: async () => {
      await Promise.all(closes);
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

describe("ApiClient.connect (integration)", () => {
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it("stays silent when the caller disposes the connection", async () => {
    relay = await startRelay();
    const onBroken = vi.fn();
    const { dispose } = await ApiClient.connect(relay.endpoint, "token", CI_MODE, NO_REMOTE, onBroken);

    dispose();
    await relay.afterTransportClosed();

    expect(onBroken).not.toHaveBeenCalled();
  });

  it("reports a broken connection when the transport drops mid-run", async () => {
    relay = await startRelay();
    const onBroken = vi.fn();
    await ApiClient.connect(relay.endpoint, "token", CI_MODE, NO_REMOTE, onBroken);

    relay.dropConnection();
    await relay.afterTransportClosed();

    expect(onBroken).toHaveBeenCalledWith(expect.any(Error));
  });
});
