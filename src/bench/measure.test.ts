import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureShape, RESULT_SENTINEL } from "./measure.ts";

/**
 * Each case runs a real child process. The scripts are deliberately crude —
 * burn processor time, hold memory, die — because what is under test is the
 * measuring, not the workload.
 */
const scratch = mkdtempSync(join(tmpdir(), "bench-measure-"));

function childScript(name: string, source: string): string {
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, source);
  return path;
}

const REPORT = `
function report(payload) {
  const usage = process.resourceUsage();
  process.stdout.write("${RESULT_SENTINEL}" + JSON.stringify({
    payload,
    cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
    maxRssMb: usage.maxRSS / 1024,
  }) + "\\n");
}
`;

describe("measureShape", () => {
  it("reports a shape that ran, with its payload", async () => {
    const script = childScript(
      "ok",
      `${REPORT}
       const timings = [1.5, 2.5, 3.5];
       report({ perQueryMs: timings, queries: timings.length });`,
    );
    const result = await measureShape<{
      perQueryMs: number[];
      queries: number;
    }>({ shape: "ok", command: process.execPath, args: [script] });

    expect(result.outcome).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.payload).toStrictEqual({
      perQueryMs: [1.5, 2.5, 3.5],
      queries: 3,
    });
    expect(result.wallMs).toBeGreaterThan(0);
  });

  it("measures processor time separately from elapsed time", async () => {
    // Sleeps for 300ms and computes for far less. Wall clock counts the sleep;
    // processor time must not, which is the whole reason it is the steadier
    // number on a machine doing other things.
    const script = childScript(
      "sleepy",
      `${REPORT}
       await new Promise((r) => setTimeout(r, 300));
       report({});`,
    );
    const result = await measureShape({
      shape: "sleepy",
      command: process.execPath,
      args: [script],
    });

    expect(result.outcome).toBe("ok");
    expect(result.wallMs).toBeGreaterThan(280);
    expect(result.cpuMs).toBeDefined();
    expect(result.cpuMs!).toBeLessThan(result.wallMs);
  });

  it("records peak memory, not memory at exit", async () => {
    // Holds ~120MB, drops it, then reports. A reading taken at the end would
    // miss the peak entirely.
    const script = childScript(
      "peaky",
      `${REPORT}
       let held = [];
       for (let i = 0; i < 120; i++) held.push(Buffer.alloc(1024 * 1024, 1));
       held = null;
       global.gc?.();
       report({});`,
    );
    const result = await measureShape({
      shape: "peaky",
      command: process.execPath,
      args: [script],
    });

    expect(result.outcome).toBe("ok");
    expect(result.maxRssMb).toBeGreaterThan(100);
  });

  it("records a shape that exhausted its heap as killed, and survives it", async () => {
    // Plain objects, not Buffers. `--max-old-space-size` bounds the V8 heap;
    // Buffer and ArrayBuffer allocate outside it and sail straight past the
    // flag. Only a cgroup limit stops those, which is why the container gets a
    // `--memory` cap rather than relying on the Node flag alone.
    const script = childScript(
      "hungry",
      `${REPORT}
       const held = [];
       while (true) held.push({ pad: new Array(10000).fill("x") });`,
    );
    const result = await measureShape({
      shape: "hungry",
      command: process.execPath,
      args: [script],
      maxHeapMb: 64,
      timeoutMs: 60_000,
    });

    expect(result.outcome).not.toBe("ok");
    // Either the kernel killed it or V8 aborted; both are out-of-memory, and
    // neither takes the parent down with it.
    expect(["killed", "failed"]).toContain(result.outcome);
    expect(result.payload).toBeUndefined();
  });

  it("records a shape that overran its time as a timeout, not a hang", async () => {
    const script = childScript(
      "slow",
      `${REPORT}
       setInterval(() => {}, 1000);`,
    );
    const result = await measureShape({
      shape: "slow",
      command: process.execPath,
      args: [script],
      timeoutMs: 500,
    });

    expect(result.outcome).toBe("timeout");
    expect(result.wallMs).toBeGreaterThan(400);
    expect(result.wallMs).toBeLessThan(5000);
  });

  it("keeps the error output of a shape that failed", async () => {
    const script = childScript(
      "broken",
      `console.error("schema load failed"); process.exit(3);`,
    );
    const result = await measureShape({
      shape: "broken",
      command: process.execPath,
      args: [script],
    });

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("schema load failed");
  });

  it("treats a child that printed nothing usable as failed", async () => {
    const script = childScript("silent", `console.log("no report here");`);
    const result = await measureShape({
      shape: "silent",
      command: process.execPath,
      args: [script],
    });

    expect(result.outcome).toBe("failed");
    expect(result.payload).toBeUndefined();
  });
});

describe("measureShape in a container", () => {
  // These need Docker. Skipped rather than failed where it is absent, so the
  // suite still runs on a machine without it.
  const hasDocker = (() => {
    try {
      execFileSync("docker", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasDocker)(
    "reports a container the kernel killed for exceeding memory",
    async () => {
      // Buffers allocate outside the V8 heap, so only the cgroup limit stops
      // this. That is the case --max-old-space-size cannot cover.
      const result = await measureShape({
        shape: "oom",
        command: "node",
        args: [
          "-e",
          "const held=[];while(true)held.push(Buffer.alloc(1024*1024,1));",
        ],
        container: { image: "node:24-alpine", memoryMb: 128 },
        timeoutMs: 120_000,
      });

      expect(result.outcome).toBe("killed");
      expect(result.payload).toBeUndefined();
      // 137 is 128+SIGKILL, which is how Docker reports a cgroup kill. The
      // process itself carries no signal, so without the inspect this would
      // read as an ordinary non-zero exit.
      expect(result.exitCode).toBe(137);
      expect(result.signal).toBeNull();
    },
    180_000,
  );

  it.skipIf(!hasDocker)(
    "reports a container that finished, with its payload",
    async () => {
      const result = await measureShape<{ ok: boolean }>({
        shape: "fine",
        command: "node",
        args: [
          "-e",
          `const u=process.resourceUsage();process.stdout.write("${RESULT_SENTINEL}"+JSON.stringify({payload:{ok:true},cpuMs:(u.userCPUTime+u.systemCPUTime)/1000,maxRssMb:u.maxRSS/1024})+"\\n")`,
        ],
        container: { image: "node:24-alpine", memoryMb: 256 },
        timeoutMs: 120_000,
      });

      expect(result.outcome).toBe("ok");
      expect(result.payload).toStrictEqual({ ok: true });
      expect(result.maxRssMb).toBeGreaterThan(0);
    },
    180_000,
  );
});
