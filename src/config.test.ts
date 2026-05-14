import { test, expect, vi } from "vitest";
import { DEFAULT_CONFIG } from "./config.ts";
import type { ServerApi } from "@query-doctor/core";
import type { RpcStub } from "capnweb";

function makeApi(overrides: Partial<RpcStub<ServerApi>> = {}): RpcStub<ServerApi> {
  return overrides as RpcStub<ServerApi>;
}

async function resolveConfig(
  api: RpcStub<ServerApi>,
  repo: string | undefined,
  branch: string,
) {
  if (!repo) return DEFAULT_CONFIG;
  return api.getRepoConfig(repo, branch).catch(() => DEFAULT_CONFIG);
}

test("returns config from successful getRepoConfig call", async () => {
  const config = {
    minimumCost: 100,
    regressionThreshold: 0.5,
    ignoredQueryHashes: ["abc123"],
    lastSeenQueryHashes: [],
    acknowledgedQueryHashes: [],
    comparisonBranch: undefined,
  };
  const api = makeApi({ getRepoConfig: vi.fn().mockResolvedValue(config) });

  const result = await resolveConfig(api, "my/repo", "main");
  expect(result).toEqual(config);
});

test("returns defaults when getRepoConfig throws", async () => {
  const api = makeApi({
    getRepoConfig: vi.fn().mockRejectedValue(new Error("rpc error")),
  });

  const result = await resolveConfig(api, "my/repo", "main");
  expect(result).toEqual(DEFAULT_CONFIG);
});

test("returns defaults when repo is undefined", async () => {
  const api = makeApi({ getRepoConfig: vi.fn() });

  const result = await resolveConfig(api, undefined, "main");
  expect(result).toEqual(DEFAULT_CONFIG);
  expect(api.getRepoConfig).not.toHaveBeenCalled();
});

test("passes repo and branch to getRepoConfig", async () => {
  const getRepoConfig = vi.fn().mockResolvedValue(DEFAULT_CONFIG);
  const api = makeApi({ getRepoConfig });

  await resolveConfig(api, "org/repo", "feat/my-branch");
  expect(getRepoConfig).toHaveBeenCalledWith("org/repo", "feat/my-branch");
});
