// The test-presence gate (#3496) — the MVP tracer bullet for the CI⇄MCP verdict
// loop. It asks one question of a PR's diff: "did this change add or alter a
// query without a real-DB (repository/integration) test alongside it?" — and, if
// so, emits a conservative "we could not verify this" flag.
//
// It never claims a query is *bad*. Query Doctor only analyses SQL that a
// real-DB test runs against Postgres; a query change with no such test produces
// no captured query, so CI would go green having never seen it. This gate
// reports that blind spot honestly.
//
// It is a pure *diff* heuristic — it reads the diff's added lines to decide
// whether a query changed (still no runtime capture, no query-to-site mapping;
// those are the later capture-based rungs, #3502/#3503). Reading the diff's
// content, rather than guessing from the filename, is what keeps it from
// reddening a comment-only edit to a repository file or missing a query added to
// a plainly-named `service.ts`. It ships warn-only until the capture-based rungs
// make it precise enough to block.

/** One entry from the PR's changed-file list (GitHub's `pulls.listFiles`). */
export interface ChangedFile {
  path: string;
  /** GitHub file status: added | modified | removed | renamed | copied | changed | unchanged. */
  status: string;
  /** Unified-diff hunks for the file; absent for large or binary files. */
  patch?: string;
}

/**
 * Path and content heuristics. Kept as data (not hard-coded regexes) so a later
 * per-repo config (#3500) can override the defaults without touching the gate.
 */
export interface TestPresenceConfig {
  /** Marks a path as a test file of any kind. */
  testFilePatterns: RegExp[];
  /** Extensions worth inspecting for query code — a doc/config file never is. */
  sourceFilePatterns: RegExp[];
  /** Content signals that an added diff line is (part of) a query. */
  queryCodePatterns: RegExp[];
  /** Fallback data-access signal, used only when a file's patch is unavailable. */
  dataAccessPathPatterns: RegExp[];
  /** Marks a test path as a real-DB data-layer (repository/integration) test. */
  dataLayerTestPathPatterns: RegExp[];
  /**
   * Marks a path as a generated schema-migration `.sql` file. These are DDL, not
   * a query site, and have no co-located test — their coverage lives in whatever
   * repository/integration test exercises the new schema, which the stem
   * heuristic can never link. Excluded from the data-access set so a well-tested
   * migration doesn't false-positive.
   */
  migrationFilePatterns: RegExp[];
}

export const DEFAULT_TEST_PRESENCE_CONFIG: TestPresenceConfig = {
  testFilePatterns: [
    /\.(test|spec)\.[cm]?[jt]sx?$/i, // *.test.ts, *.spec.tsx, ...
    /(^|\/)__tests__\//i,
    /(^|\/)tests?\//i,
    /(^|\/)test_[^/]+\.py$/i, // Python: test_foo.py
    /_test\.(py|go|rb)$/i, // Go/Python/Ruby: foo_test.go
  ],
  sourceFilePatterns: [/\.([cm]?[jt]sx?|py|go|rb|java|kt|rs|php|scala|cs|sql)$/i],
  // Prefer high-precision ORM / query-builder calls; a small set of raw-SQL
  // shapes catches string queries. Comment lines are stripped before matching,
  // so a code comment mentioning "select" won't trip it.
  queryCodePatterns: [
    /\bdb\.(select|insert|update|delete)\b/i,
    /\.(execute|query)\s*\(/i,
    /\bsql`/, // drizzle sql`...` tag
    /\bdrizzle\s*\(/i,
    /\bknex\b/i,
    /\bprisma\.\w+\.(find\w*|create|update|delete|upsert|count|aggregate)\b/i,
    /\.createQueryBuilder\s*\(/i,
    /\bgetRepository\s*\(/i,
    /\.\$(queryRaw|executeRaw)/,
    /\.(leftJoin|innerJoin|rightJoin)\s*\(/i,
    /\binsert\s+into\b/i,
    /\bdelete\s+from\b/i,
    /\bupdate\b[^\n]{0,80}\bset\b/i,
    // `select` must be followed by whitespace, as real `SELECT … FROM` is — so a
    // hyphenated route segment like `select-plan` (whose `\bselect\b` boundary is
    // the hyphen) doesn't read as a query when an import `from` follows it
    // (Site#3615).
    /\bselect\s[\s\S]{0,300}?\bfrom\b/i,
    // DDL is matched by statement shape (ON clause, column list, target
    // identifier), not bare keyword adjacency: prose in a string literal —
    // "its suggested CREATE INDEX fix" in an MCP tool description (Site#3539)
    // — must not read as a query. Stripping string literals instead would
    // blind the raw-SQL shapes above, since raw SQL lives in strings; the
    // statement's own grammar is the discriminator.
    /\bcreate\s+(unique\s+)?index\b[^\n]{0,120}?\bon\b/i,
    /\bcreate\s+table\b[^\n]{0,80}?\(/i,
    /\bcreate\s+(or\s+replace\s+)?(materialized\s+)?view\b[^\n]{0,80}?\bas\b/i,
    /\balter\s+table\s+(if\s+exists\s+)?["\w]/i,
    /\bdrop\s+(table|index|view|materialized\s+view)\s+(if\s+exists\s+|concurrently\s+)?["\w]/i,
  ],
  dataAccessPathPatterns: [
    /(^|\/)[^/]*repositor(y|ies)[^/]*\.[cm]?[jt]s$/i,
    /(^|\/)[^/]*\.repo\.[cm]?[jt]s$/i,
    /(^|\/)(dal|data-access)\//i,
  ],
  dataLayerTestPathPatterns: [
    /repositor(y|ies)/i,
    /\.repo\./i,
    /integration/i,
    /(^|\/)(dal|data-access)\//i,
  ],
  migrationFilePatterns: [
    /(^|\/)migrations?\/.*\.sql$/i, // .../migrations/**/*.sql (Rails, Prisma, ...)
    /(^|\/)migrate\/.*\.sql$/i, // .../migrate/**/*.sql
    /(^|\/)drizzle\/.*\.sql$/i, // Drizzle output dir
    /(^|\/)\d{4,}_[^/]*\.sql$/i, // numbered migration: 0026_projects_card1_733.sql
  ],
};

/**
 * A changed file "changed" for gating purposes when its content could have
 * introduced or altered a query. A pure deletion removes surface, it doesn't add
 * an unverified query, so `removed`/`unchanged` never trip the gate.
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

/** The added lines of a unified diff, with the leading `+` removed. */
function addedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

/** Drop lines that are plainly comments, so prose mentioning SQL keywords doesn't match. */
function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("--")
      );
    })
    .join("\n");
}

/** True when the diff's *added* lines contain query code. */
export function patchAddsQueryCode(
  patch: string | undefined,
  config: TestPresenceConfig = DEFAULT_TEST_PRESENCE_CONFIG,
): boolean {
  if (!patch) return false;
  const added = stripCommentLines(addedLines(patch));
  return matchesAny(added, config.queryCodePatterns);
}

/**
 * Did this non-test change add or alter a query? Uses the diff content when
 * available; falls back to the filename prior only when the patch is missing
 * (large/binary files), where content can't be inspected.
 */
function changedQueryCode(
  file: ChangedFile,
  config: TestPresenceConfig,
): boolean {
  if (!matchesAny(file.path, config.sourceFilePatterns)) return false;
  // A migration `.sql` is schema DDL, not a query site. Its `CREATE/ALTER TABLE`
  // would match the DDL query pattern, but there is no co-located test to link it
  // to, so treating it as changed query code false-positives on every migration.
  if (matchesAny(file.path, config.migrationFilePatterns)) return false;
  if (file.patch !== undefined) return patchAddsQueryCode(file.patch, config);
  return matchesAny(file.path, config.dataAccessPathPatterns);
}

/** A test counts as a data-layer test if it exercises query code or is named like one. */
function isDataLayerTest(file: ChangedFile, config: TestPresenceConfig): boolean {
  return (
    isTestFile(file.path, config) &&
    (patchAddsQueryCode(file.patch, config) ||
      matchesAny(file.path, config.dataLayerTestPathPatterns))
  );
}

function directory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Filename without directory, extension, or a `.test`/`.spec` suffix. */
function baseStem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name
    .replace(/\.(test|spec)\./i, ".")
    .replace(/\.[cm]?[jt]sx?$/i, "")
    .replace(/\.(py|go|rb)$/i, "");
}

/**
 * Whether a data-layer test plausibly covers a changed data-access file: same
 * directory, or the test's name carries the file's stem (`user.repository.ts` ↔
 * `user.repository.spec.ts`, `orders.ts` ↔ `orders.integration.test.ts`).
 * Lenient on purpose — a loose match makes the gate under-fire, the safe side.
 */
function isRelated(dataAccessPath: string, testPath: string): boolean {
  if (directory(dataAccessPath) === directory(testPath)) return true;
  const stem = baseStem(dataAccessPath);
  return stem.length > 0 && baseStem(testPath).includes(stem);
}

export interface ChangedSurface {
  /** Non-test files whose diff added/altered query code. */
  dataAccessChanged: string[];
  /** Real-DB data-layer tests the PR added or changed. */
  dataLayerTestChanged: string[];
}

export function classifyChangedFiles(
  files: ChangedFile[],
  config: TestPresenceConfig = DEFAULT_TEST_PRESENCE_CONFIG,
): ChangedSurface {
  const dataAccessChanged: string[] = [];
  const dataLayerTestChanged: string[] = [];
  for (const file of files) {
    if (!isChanged(file.status)) continue;
    if (isTestFile(file.path, config)) {
      if (isDataLayerTest(file, config)) dataLayerTestChanged.push(file.path);
    } else if (changedQueryCode(file, config)) {
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
  /** The changed data-access files with no related data-layer test — what to cover. */
  dataAccessFiles: string[];
}

const REASON =
  "This PR adds or changes queries in data-access code, but no related real-DB " +
  "(repository/integration) test changed, so Query Doctor could not verify them " +
  "— nothing here exercises them against Postgres. This is flagged " +
  "conservatively; it is not a claim that the query is wrong.";

const NEXT_STEP =
  "Add or update a repository/integration test that exercises the changed " +
  "queries against a real database, following your project's testing " +
  "conventions — or, if a test genuinely isn't needed (a revert, generated " +
  "code, a column-drop migration), triage it.";

const TRIAGE_HINT =
  "If this change intentionally needs no test, note why on the PR so the " +
  "exception is auditable rather than silent.";

/**
 * Capture evidence from the run, used to override the diff heuristic with what
 * actually executed. `newQueryHashes` are the fingerprints this run captured
 * that the baseline had not — query surface this PR introduced that a real-DB
 * test ran against Postgres. Empty when there is no baseline to diff against.
 */
export interface TestPresenceCapture {
  newQueryHashes: readonly string[];
}

/**
 * Evaluate the gate. Returns a verdict listing the changed data-access files
 * that have no related data-layer test, or `null` when the PR passes — no query
 * change, every query change has a related test alongside it, or capture proves
 * the change ran against Postgres.
 */
export function evaluateTestPresence(
  files: ChangedFile[],
  config: TestPresenceConfig = DEFAULT_TEST_PRESENCE_CONFIG,
  capture?: TestPresenceCapture,
): TestPresenceVerdict | null {
  const { dataAccessChanged, dataLayerTestChanged } = classifyChangedFiles(
    files,
    config,
  );
  const untested = dataAccessChanged.filter(
    (path) => !dataLayerTestChanged.some((test) => isRelated(path, test)),
  );
  if (untested.length === 0) return null;

  // Capture is ground truth for the blind spot this gate exists to catch: a
  // query change that runs against Postgres in no test produces no captured
  // query. If this run captured new query surface, a real-DB test *did* exercise
  // the change — observed execution overrides the diff heuristic's "no related
  // test" guess, so don't flag. Per-query→file attribution (which would let a
  // partially-tested PR still flag its one uncovered file) is the next rung,
  // #3503; until then this suppresses at the run level, on the safe under-fire
  // side the gate already favours.
  if (capture && capture.newQueryHashes.length > 0) return null;

  return {
    condition: "untested-data-access",
    verdictClass: "uncertain-conservative-flag",
    reason: REASON,
    nextStep: NEXT_STEP,
    triageHint: TRIAGE_HINT,
    dataAccessFiles: untested,
  };
}
