import { test, expect, vi, afterEach } from "vitest";
import { Connectable } from "../sync/connectable.ts";
import { Remote } from "./remote.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";

vi.mock(import("../sql/postgresjs.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, connectToSource: vi.fn() };
});

import { connectToSource } from "../sql/postgresjs.ts";
import { RemoteController } from "./remote-controller.ts";

const mockedConnectToSource = vi.mocked(connectToSource);

afterEach(() => {
  vi.restoreAllMocks();
  mockedConnectToSource.mockReset();
});

function setupController(probe: "reachable" | "unreachable") {
  mockedConnectToSource.mockReturnValue({
    exec: vi.fn(() =>
      probe === "reachable"
        ? Promise.resolve([])
        : Promise.reject(new Error("ECONNREFUSED"))
    ),
    close: vi.fn(() => Promise.resolve()),
  } as unknown as ReturnType<typeof connectToSource>);

  const target = Connectable.fromString("postgres://localhost:5555/postgres");
  const source = Connectable.fromString("postgres://localhost:5432/source");
  const remote = new Remote(target, ConnectionManager.forLocalDatabase());

  type SyncResponse = Awaited<ReturnType<Remote["syncFrom"]>>;
  type StatusResponse = Awaited<ReturnType<Remote["getStatus"]>>;
  const syncFromSpy = vi.spyOn(remote, "syncFrom").mockResolvedValue({
    meta: {},
    schema: { type: "ok", value: {} },
  } as unknown as SyncResponse);
  vi.spyOn(remote, "getStatus").mockResolvedValue({
    queries: [],
    diffs: { status: "fulfilled", value: [] },
    disabledIndexes: [],
    pgStatStatementsNotInstalled: false,
  } as unknown as StatusResponse);

  return { controller: new RemoteController(remote), syncFromSpy, source };
}

test("redump reuses the docker-resolved source db when the probe succeeds", async () => {
  const { controller, syncFromSpy, source } = setupController("reachable");

  await controller.onFullSync(source);
  await controller.redump();

  expect(syncFromSpy).toHaveBeenCalledTimes(2);
  expect(syncFromSpy.mock.calls[0][0].url.hostname).toEqual("host.docker.internal");
  expect(syncFromSpy.mock.calls[1][0].url.hostname).toEqual("host.docker.internal");
});

test("redump reuses the original source db when the probe fails", async () => {
  const { controller, syncFromSpy, source } = setupController("unreachable");

  await controller.onFullSync(source);
  await controller.redump();

  expect(syncFromSpy).toHaveBeenCalledTimes(2);
  expect(syncFromSpy.mock.calls[0][0].url.hostname).toEqual("localhost");
  expect(syncFromSpy.mock.calls[1][0].url.hostname).toEqual("localhost");
});
