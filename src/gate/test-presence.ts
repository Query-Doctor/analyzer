// The crude test-presence gate (#3496) — the MVP tracer bullet for the CI⇄MCP
// verdict loop. It is a *pure diff heuristic*: given the files a PR changed, it
// asks one question — "did this PR touch data-access code without touching a
// real-DB (repository/integration) test?" — and, if so, emits a conservative
// "we could not verify this" flag.
//
// It never claims a query is *bad*. Query Doctor only analyses SQL that a
// real-DB test actually runs against Postgres; a data-access change with no such
// test produces no captured query, so CI would go green having never seen it.
// This gate reports that blind spot honestly instead of letting silence read as
// safety. By design it *under-fires*: it only speaks up when data-access code
// changed and no data-layer test changed alongside it.

/** One entry from the PR's changed-file list (GitHub's `pulls.listFiles`). */
export interface ChangedFile {
  path: string;
  /** GitHub file status: added | modified | removed | renamed | copied | changed | unchanged. */
  status: string;
}

/**
 * Path heuristics that decide what "data-access code" and "data-layer test"
 * look like. Kept as data (not hard-coded regexes) so a later per-repo config
 * (#3500) can override the defaults without touching the gate logic.
 */
export interface TestPresenceConfig {
  /** Marks a path as a test file of any kind. */
  testFilePatterns: RegExp[];
  /** Marks a non-test path as data-access (query-emitting) code. */
  dataAccessPatterns: RegExp[];
  /** Marks a test path as a real-DB data-layer (repository/integration) test. */
  dataLayerTestPatterns: RegExp[];
}

// Conservative defaults, tuned to under-fire. `repository` / `dal` /
// `data-access` are the clearest data-access signals and match this project's
// own convention (`apps/api/**/*.repository.ts`). Anything narrower would never
// fire; anything broader risks reddening PRs over unrelated code.
export const DEFAULT_TEST_PRESENCE_CONFIG: TestPresenceConfig = {
  testFilePatterns: [
    /\.(test|spec)\.[cm]?[jt]sx?$/i, // *.test.ts, *.spec.tsx, *.test.mjs, ...
    /(^|\/)__tests__\//i,
    /(^|\/)tests?\//i,
    /(^|\/)test_[^/]+\.py$/i, // Python: test_foo.py
    /_test\.(py|go|rb)$/i, // Go/Python/Ruby: foo_test.go
  ],
  dataAccessPatterns: [
    /(^|\/)[^/]*repositor(y|ies)[^/]*\.[cm]?[jt]sx?$/i, // user.repository.ts, repositories.ts
    /(^|\/)[^/]*\.repo\.[cm]?[jt]sx?$/i, // user.repo.ts
    /(^|\/)(dal|data-access)\//i, // src/dal/**, src/data-access/**
  ],
  dataLayerTestPatterns: [
    /repositor(y|ies)/i, // *.repository.spec.ts
    /\.repo\./i,
    /integration/i, // *.integration.test.ts
    /(^|\/)(dal|data-access)\//i,
  ],
};

/**
 * A changed file "changed" for gating purposes when its content could have
 * introduced or altered a query. A pure deletion removes surface, it doesn't
 * add an unverified query, so `removed`/`unchanged` never trip the gate.
 */
function isChanged(status: string): boolean {
  return status !== "removed" && status !== "unchanged";
}

function matchesAny(path: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(path));
}

function isTestFile(path: string, config: TestPresenceConfig): boolean {
  return matchesAny(path, config.testFilePatterns);
}

function isDataAccessFile(path: string, config: TestPresenceConfig): boolean {
  return (
    !isTestFile(path, config) && matchesAny(path, config.dataAccessPatterns)
  );
}

function isDataLayerTest(path: string, config: TestPresenceConfig): boolean {
  return (
    isTestFile(path, config) && matchesAny(path, config.dataLayerTestPatterns)
  );
}

export interface ChangedSurface {
  /** Non-test data-access files the PR added or changed. */
  dataAccessChanged: string[];
  /** Real-DB data-layer tests the PR added or changed. */
  dataLayerTestChanged: string[];
}

/**
 * Bucket a PR's changed files into the two surfaces the gate cares about. A
 * repository *test* (`user.repository.spec.ts`) counts as a data-layer test,
 * not as data-access code — so changing a repository and its test together
 * satisfies the gate, while changing the repository alone does not.
 */
export function classifyChangedFiles(
  files: ChangedFile[],
  config: TestPresenceConfig = DEFAULT_TEST_PRESENCE_CONFIG,
): ChangedSurface {
  const dataAccessChanged: string[] = [];
  const dataLayerTestChanged: string[] = [];
  for (const file of files) {
    if (!isChanged(file.status)) continue;
    if (isDataLayerTest(file.path, config)) {
      dataLayerTestChanged.push(file.path);
    } else if (isDataAccessFile(file.path, config)) {
      dataAccessChanged.push(file.path);
    }
  }
  return { dataAccessChanged, dataLayerTestChanged };
}

/**
 * The v0 inline verdict payload (#3496). A precursor to the versioned, shared
 * verdict contract (#3497) — deliberately inline here so the MVP ships without a
 * cross-repo dependency on the published contract.
 */
export interface TestPresenceVerdict {
  condition: "untested-data-access";
  /** The honest epistemic state: not "bad", but "we could not check this". */
  verdictClass: "uncertain-conservative-flag";
  reason: string;
  nextStep: string;
  triageHint: string;
  /** The changed data-access files that triggered the flag. */
  dataAccessFiles: string[];
}

const REASON =
  "This PR changes data-access code but no real-DB (repository/integration) test " +
  "changed alongside it, so Query Doctor could not verify the queries it " +
  "introduces — nothing here exercises them against Postgres. This is flagged " +
  "conservatively; it is not a claim that the query is wrong.";

const NEXT_STEP =
  "Add a repository/integration test that exercises the changed data-access " +
  "code against a real database, following your project's testing conventions " +
  "— or, if a test genuinely isn't needed (a revert, generated code, a " +
  "column-drop migration), triage it.";

const TRIAGE_HINT =
  "If this data-access change intentionally needs no test, note why on the PR so " +
  "the exception is auditable rather than silent.";

/**
 * Evaluate the gate. Returns a verdict when the PR trips the flag, or `null`
 * when it passes — the two passing cases being "no data-access change" and
 * "data-access change with a data-layer test alongside it".
 */
export function evaluateTestPresence(
  files: ChangedFile[],
  config: TestPresenceConfig = DEFAULT_TEST_PRESENCE_CONFIG,
): TestPresenceVerdict | null {
  const { dataAccessChanged, dataLayerTestChanged } = classifyChangedFiles(
    files,
    config,
  );
  if (dataAccessChanged.length === 0 || dataLayerTestChanged.length > 0) {
    return null;
  }
  return {
    condition: "untested-data-access",
    verdictClass: "uncertain-conservative-flag",
    reason: REASON,
    nextStep: NEXT_STEP,
    triageHint: TRIAGE_HINT,
    dataAccessFiles: dataAccessChanged,
  };
}
