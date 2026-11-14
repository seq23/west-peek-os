/**
 * Types for the two pure readers `tests/porterNotices.test.ts` holds to the Worker's own
 * (`cleanPreviewUrls` in src/shared/work/porterNotices.ts) — one rule, two runtimes, the same answers.
 */
export function previewUrlsFrom(deploymentStatuses: ReadonlyArray<{ environment_url?: string | null }>, commentBodies: readonly string[], pagesHosts?: readonly string[], branch?: string, headSha?: string): string | null;
export function undeployedPreviewReason(checkState: string, previewUrl: string | null | undefined, pagesHosts: readonly string[] | null | undefined, prUrl: string): string | null;
export function branchAlias(branch: string | null | undefined): string;
/** Did Claude Code stop because its plan's usage is spent? The notice's own words, or null. Only a failed or unreadable run is inspected. */
export function claudeSpentUsage(run: { out: string; err: string }): string | null;
export function codexSpentUsage(run: { out: string; err: string }): string | null;
/** A spent plan (a Codex limit, a spent brain turn, or both seats): a report that asks the Worker to hold the card until the reset, or null for any other run. */
export function spentReport(phase: string, claude: { bothSpent?: boolean; heldForClaude?: string; servedBy?: string; resetsInSeconds?: number; out?: string; err?: string } | null | undefined, result?: unknown): { phase: string; status: "failed"; reason: string; waits_seconds: number } | null;
export const CLAUDE_CHECK_NOTE: string;
export function runModel(
  opts: { job?: { card_kind?: string; private_model_only?: boolean } | null; phase?: string; prompt: string; jobDir?: string | null; materialDirs?: string[]; onLine?: (line: string) => void; [k: string]: unknown },
  deps?: {
    runBrain?: () => Promise<{ code: number | null; out: string; err: string }>;
    runWorker?: () => Promise<{ code: number | null; out: string; err: string }>;
    brainSpent?: (r: { out: string; err: string }) => string | null;
    workerSpent?: (r: { out: string; err: string }) => string | null;
    workerUsable?: () => { ok: boolean; why: string };
  },
): Promise<{ code: number | null; out: string; err: string; servedBy: "claude" | "codex" | "none"; heldForClaude?: string; bothSpent?: boolean; resetsInSeconds?: number }>;
export function runRefusal(
  run: { script?: string; env?: string; args?: readonly string[] },
  gate: { admittedNow: readonly string[]; base: readonly string[]; job: unknown; phase: string },
): string | null;
/** Every allowed delivery variable, set and verified in BOTH Pages environments; returns the proof lines (never a value). */
export function applyPagesEnv(
  pagesEnv: unknown,
  env: Record<string, string | undefined>,
  progress?: ((line: string) => void) | null,
  registry?: unknown,
  opts?: { branch?: string; rebuildWaitMs?: number; putSecret?: (entry: { project: string; name: string }, env: Record<string, string | undefined>, environment: string) => Promise<{ outcome: string; why: string | null }> },
): Promise<string[]>;
/** The v1.0 bar (13 Nov 2026): the fresh-eyes review and the first run on the preview. */
export const REVIEW_PHASE: string;
export const REVIEW_ROUNDS: number;
export const FIRST_RUN_SCRIPT: string;
export const FIRST_RUN_SENTINEL: string;
export type ReviewFinding = { lens: string; finding: string; blocking: boolean };
export function readReview(text: string | null | undefined): { findings: ReviewFinding[]; summary: string } | null;
export function runReview(opts: Parameters<typeof runModel>[0], deps?: Parameters<typeof runModel>[1] & { resetsIn?: (notices: string[]) => number }): ReturnType<typeof runModel>;
export function reviewAndFix(args: {
  review: (round: number) => Promise<{ verdict?: { findings: ReviewFinding[]; summary: string } | null; report?: unknown }>;
  rebuild: (blocking: ReviewFinding[], round: number) => Promise<{ report?: unknown }>;
  rounds?: number;
  phase?: string;
}): Promise<{ line?: string; report?: { phase: string; status: string; reason: string } & Record<string, unknown> }>;
export function firstRunVerdict(run: { hasScript: boolean; exit?: number; out?: string }): { ok: boolean; line: string };
export function accountingOf(result: unknown): Array<{ ask: string; how: string; done_when?: string[] }>;
export function itemsOf(result: unknown): Array<{ item: string; state: string; note?: string; done_when?: Array<{ check: string; met: boolean; note?: string }>; blocked_by?: string }>;
/** Spending from an email is a named stop (13 Nov 2026): what in a result would cost money. */
export const SPEND_STOP: string;
export function spendIn(parsed: unknown): string[];
export function readResult(text: string, phase: string): { result: Record<string, unknown> | null; problem: string | null };
export function createNewRepo(
  repoPath: string,
  githubRepo: string | null,
  env: Record<string, string | undefined>,
  progress: (line: string) => void,
  deps?: { sh: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr?: string }>; fetch: typeof fetch },
): Promise<{ ok: boolean; why?: string; created?: boolean; pagesHost?: string }>;
/** A fix turn after the review that asked for runs goes through the build turn's run loop (14 Nov 2026). */
export function settleFixTurn<R extends { status?: string } | null>(result: R, problem: string | null, settleRuns: ((r: NonNullable<R>, note: string | null) => Promise<{ result: unknown; problem: string | null }>) | null, note: string | null): Promise<{ result: any; problem: string | null }>;
