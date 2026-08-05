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

// The path and content heuristics. These were once a caller-supplied config
// object, on the expectation that #3500 would let a repo override them. #3500
// shipped as `conditionPolicies`, which sets a condition's severity rather than
// its patterns, so nothing ever passed a second value — not in production, not
// in any test. They are the implementation now. Give them back an interface
// when a repo actually needs to vary them.

/** Marks a path as a test file of any kind. */
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i, // *.test.ts, *.spec.tsx, ...
  /(^|\/)__tests__\//i,
  /(^|\/)tests?\//i,
  /(^|\/)test_[^/]+\.py$/i, // Python: test_foo.py
  /_test\.(py|go|rb)$/i, // Go/Python/Ruby: foo_test.go
];

/** Extensions worth inspecting for query code — a doc/config file never is. */
const SOURCE_FILE_PATTERNS = [
  /\.([cm]?[jt]sx?|py|go|rb|java|kt|rs|php|scala|cs|sql)$/i,
];

// Content signals that an added diff line is (part of) a query. Prefer
// high-precision ORM / query-builder calls; a small set of raw-SQL shapes
// catches string queries. Comment lines are stripped before matching, so a
// code comment mentioning "select" won't trip it.
//
// Each rule carries a stable name. The name is the whole point: it is what a
// reader sees when the gate flags their file, and what a bug report can cite.
// Six precision fixes so far were each diagnosed by rebuilding, by hand, which
// of these fired and on what text.
const QUERY_CODE_RULES: { name: string; pattern: RegExp }[] = [
  { name: "db-query-method", pattern: /\bdb\.(select|insert|update|delete)\b/i },
  { name: "execute-or-query-call", pattern: /\.(execute|query)\s*\(/i },
  { name: "drizzle-sql-tag", pattern: /\bsql`/ },
  { name: "drizzle-init", pattern: /\bdrizzle\s*\(/i },
  { name: "knex", pattern: /\bknex\b/i },
  {
    name: "prisma-model-call",
    pattern: /\bprisma\.\w+\.(find\w*|create|update|delete|upsert|count|aggregate)\b/i,
  },
  { name: "typeorm-query-builder", pattern: /\.createQueryBuilder\s*\(/i },
  { name: "typeorm-get-repository", pattern: /\bgetRepository\s*\(/i },
  { name: "prisma-raw", pattern: /\.\$(queryRaw|executeRaw)/ },
  { name: "builder-join", pattern: /\.(leftJoin|innerJoin|rightJoin)\s*\(/i },
  { name: "raw-insert-into", pattern: /\binsert\s+into\b/i },
  { name: "raw-delete-from", pattern: /\bdelete\s+from\b/i },
  { name: "raw-update-set", pattern: /\bupdate\b[^\n]{0,80}\bset\b/i },
  // `select` must be followed by whitespace, as real `SELECT … FROM` is, so a
  // hyphenated route segment like `select-plan` (whose `\bselect\b` boundary is
  // the hyphen) doesn't read as a query when an import `from` follows it
  // (Site#3615).
  { name: "raw-select-from", pattern: /\bselect\s[\s\S]{0,300}?\bfrom\b/i },
  // DDL is matched by statement shape (ON clause, column list, target
  // identifier), not bare keyword adjacency: prose in a string literal, such as
  // "its suggested CREATE INDEX fix" in an MCP tool description (Site#3539),
  // must not read as a query. Stripping string literals instead would blind the
  // raw-SQL shapes above, since raw SQL lives in strings; the statement's own
  // grammar is the discriminator.
  {
    name: "ddl-create-index",
    pattern: /\bcreate\s+(unique\s+)?index\b[^\n]{0,120}?\bon\b/i,
  },
  { name: "ddl-create-table", pattern: /\bcreate\s+table\b[^\n]{0,80}?\(/i },
  {
    name: "ddl-create-view",
    pattern: /\bcreate\s+(or\s+replace\s+)?(materialized\s+)?view\b[^\n]{0,80}?\bas\b/i,
  },
  {
    name: "ddl-alter-table",
    pattern: /\balter\s+table\s+(if\s+exists\s+)?["\w]/i,
  },
  {
    name: "ddl-drop",
    pattern: /\bdrop\s+(table|index|view|materialized\s+view)\s+(if\s+exists\s+|concurrently\s+)?["\w]/i,
  },
];

/** Fallback data-access signal, used only when a file's patch is unavailable. */
const DATA_ACCESS_PATH_PATTERNS = [
  /(^|\/)[^/]*repositor(y|ies)[^/]*\.[cm]?[jt]s$/i,
  /(^|\/)[^/]*\.repo\.[cm]?[jt]s$/i,
  /(^|\/)(dal|data-access)\//i,
];

/** Marks a test path as a real-DB data-layer (repository/integration) test. */
const DATA_LAYER_TEST_PATH_PATTERNS = [
  /repositor(y|ies)/i,
  /\.repo\./i,
  /integration/i,
  /(^|\/)(dal|data-access)\//i,
  // A `pg/` directory is the common name for a real-Postgres suite (Site#3550).
  // Anchored to a whole path segment: a bare `pg` would match `upgrade`.
  /(^|\/)pg\//i,
];

/**
 * Marks a path as a generated schema-migration `.sql` file. These are DDL, not
 * a query site, and have no co-located test — their coverage lives in whatever
 * repository/integration test exercises the new schema, which the stem
 * heuristic can never link. Excluded from the data-access set so a well-tested
 * migration doesn't false-positive.
 */
const MIGRATION_FILE_PATTERNS = [
  /(^|\/)migrations?\/.*\.sql$/i, // .../migrations/**/*.sql (Rails, Prisma, ...)
  /(^|\/)migrate\/.*\.sql$/i, // .../migrate/**/*.sql
  /(^|\/)drizzle\/.*\.sql$/i, // Drizzle output dir
  /(^|\/)\d{4,}_[^/]*\.sql$/i, // numbered migration: 0026_projects_card1_733.sql
];

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

function isTestFile(path: string): boolean {
  return matchesAny(path, TEST_FILE_PATTERNS);
}

/** The added lines of a unified diff, with the leading `+` removed. */
function addedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

/**
 * Blank out `/* … *\/` spans before the line rules run. A block comment is only
 * recognisable line by line when every line is decorated (`*` prefix, JSDoc
 * style); a JSX `{/* … *\/}` opens with `{` and continues in bare prose, so its
 * middle lines survived line stripping and "select stay … away from" read as a
 * query (Site#3615). An unterminated span, a hunk that opens a comment it does
 * not close, is blanked to the end, the gate's usual under-fire side.
 *
 * Every stripper here replaces text with spaces rather than removing it, so an
 * offset into the stripped text still points at the same line of the original.
 * That is what lets a match report the line it was found on.
 */
function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, blankOut);
}

/** Replace every character except newlines with a space. */
function blankOut(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * A `//` or `--` comment that trails code on the same line, plus everything
 * after it. The `(?<![:/])` guard keeps `https://…` and `a//b` from reading as
 * the start of a comment, which would blank real code following a URL.
 * Deliberately blind to `//` inside a string literal: tracking quote state is
 * more machinery than this heuristic earns, and the cost is under-firing.
 */
const TRAILING_COMMENT = /(?<![:/])(\/\/|--).*$/;

/**
 * Blank comments, so prose mentioning SQL keywords doesn't match. A whole-line
 * comment goes entirely; a comment trailing code takes only the tail. The gate
 * flagged its own source before this handled the trailing case: a rule defined
 * as ``/\bsql`/, // drizzle sql`...` tag`` matched the comment, not the code.
 */
function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const isComment =
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("--");
      return isComment ? blankOut(line) : line.replace(TRAILING_COMMENT, blankOut);
    })
    .join("\n");
}

/** `import … from "…"`. */
const IMPORT_LINE = /^\s*import\s/;
/**
 * `export { … } from "…"` / `export * from "…"` — an import that re-exports.
 * Matched by its own shape rather than a bare `export` prefix so a declaration
 * like ``export const q = sql`SELECT id FROM "users"` `` is still inspected.
 */
const REEXPORT_LINE = /^\s*export\s+(\*|type\s+\{|\{)[^;]*\bfrom\b/;

/**
 * Blank module-import statements. An import is never a query, but a component
 * named `Select` puts `Select } from "…"` in the text, which completes the raw
 * `select … from` shape and reddens a frontend-only PR (Site#3650).
 */
function stripImportLines(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      IMPORT_LINE.test(line) || REEXPORT_LINE.test(line) ? blankOut(line) : line,
    )
    .join("\n");
}

/** Why a file reads as a query site: which rule matched, where, and on what. */
export interface QuerySiteEvidence {
  /** Stable rule name, e.g. `raw-select-from`. */
  rule: string;
  /** 1-indexed line within the patch's added lines. */
  line: number;
  /** The matched text, collapsed to one line and trimmed for display. */
  matched: string;
}

/** A changed file the gate reads as a query site, and why. */
export interface FlaggedFile {
  path: string;
  /**
   * Which rule matched and where. Absent when GitHub supplied no patch (large
   * or binary file) and the filename prior decided instead — there is no
   * matched text to point at.
   */
  evidence?: QuerySiteEvidence;
}

/** How much matched text to carry into the verdict. */
const MATCH_EXCERPT_LIMIT = 120;

/**
 * The first rule that matches the diff's added lines, with the line it matched
 * on. Rule order is precedence: the earlier, higher-precision ORM shapes win
 * over the broad raw-SQL ones, so the evidence names the most specific cause.
 */
export function findQueryCode(
  patch: string | undefined,
): QuerySiteEvidence | null {
  if (!patch) return null;
  const added = stripImportLines(
    stripCommentLines(stripBlockComments(addedLines(patch))),
  );
  for (const { name, pattern } of QUERY_CODE_RULES) {
    const match = added.match(pattern);
    if (!match || match.index === undefined) continue;
    return {
      rule: name,
      line: added.slice(0, match.index).split("\n").length,
      matched: match[0]
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MATCH_EXCERPT_LIMIT),
    };
  }
  return null;
}

/** True when the diff's *added* lines contain query code. */
export function patchAddsQueryCode(patch: string | undefined): boolean {
  return findQueryCode(patch) !== null;
}

/**
 * Did this non-test change add or alter a query? Uses the diff content when
 * available; falls back to the filename prior only when the patch is missing
 * (large/binary files), where content can't be inspected.
 */
function changedQueryCode(file: ChangedFile): FlaggedFile | null {
  if (!matchesAny(file.path, SOURCE_FILE_PATTERNS)) return null;
  // A migration `.sql` is schema DDL, not a query site. Its `CREATE/ALTER TABLE`
  // would match the DDL query pattern, but there is no co-located test to link it
  // to, so treating it as changed query code false-positives on every migration.
  if (matchesAny(file.path, MIGRATION_FILE_PATTERNS)) return null;
  if (file.patch !== undefined) {
    const evidence = findQueryCode(file.patch);
    return evidence ? { path: file.path, evidence } : null;
  }
  // No patch: GitHub omits it for large or binary files, so there is no text to
  // match and no evidence to show. The filename prior decides alone.
  return matchesAny(file.path, DATA_ACCESS_PATH_PATTERNS)
    ? { path: file.path }
    : null;
}

/** A test counts as a data-layer test if it exercises query code or is named like one. */
function isDataLayerTest(file: ChangedFile): boolean {
  return (
    isTestFile(file.path) &&
    (patchAddsQueryCode(file.patch) ||
      matchesAny(file.path, DATA_LAYER_TEST_PATH_PATTERNS))
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
    // `.sql` belongs here for a script whose spec reads and runs the file:
    // `scripts/backfill.sql` ↔ `src/db/backfill.spec.ts`. Leaving it on made the
    // stem `backfill.sql`, which no test stem can contain (Site#3650).
    .replace(/\.(py|go|rb|sql)$/i, "");
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
  /** Non-test files whose diff added/altered query code, with why each matched. */
  dataAccessChanged: FlaggedFile[];
  /** Real-DB data-layer tests the PR added or changed. */
  dataLayerTestChanged: string[];
}

export function classifyChangedFiles(
  files: ChangedFile[],
): ChangedSurface {
  const dataAccessChanged: FlaggedFile[] = [];
  const dataLayerTestChanged: string[] = [];
  for (const file of files) {
    if (!isChanged(file.status)) continue;
    if (isTestFile(file.path)) {
      if (isDataLayerTest(file)) dataLayerTestChanged.push(file.path);
    } else {
      const flagged = changedQueryCode(file);
      if (flagged) dataAccessChanged.push(flagged);
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
  dataAccessFiles: FlaggedFile[];
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
  capture?: TestPresenceCapture,
): TestPresenceVerdict | null {
  const { dataAccessChanged, dataLayerTestChanged } =
    classifyChangedFiles(files);
  const untested = dataAccessChanged.filter(
    (file) => !dataLayerTestChanged.some((test) => isRelated(file.path, test)),
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
