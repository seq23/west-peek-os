/** Types for runbook.mjs — the parts the tests import. */
export const DATA_OP_PREFIXES: readonly string[];
export function isDataOp(name: string): boolean;
export function dataOpsIn(pkg: { scripts?: Record<string, string> } | null | undefined): string[];
export function porterMayRunFrom(pkg: { scripts?: Record<string, string> } | null | undefined, opts?: { derived?: boolean }): { names: string[]; text: string };
export function admittedScripts(runbookText: string, pkg: { scripts?: Record<string, string> } | null | undefined): { names: string[]; derived: boolean; section: string | null };
export function withPorterMayRun(runbookText: string, section: string): string;
export function isProductionRun(run: { env?: string; args?: readonly string[] } | null | undefined): boolean;
export function productionAsked(job: unknown): { ok: boolean; why: string };
export function porterMayRun(runbookText: string): string[];
export function generateRunbook(input: {
  repo: string;
  githubRepo: string | null;
  pkg: { name?: string; description?: string; scripts?: Record<string, string> } | null;
  wrangler: unknown;
  sourceNames?: string[];
  hostHint?: string | null;
  today?: string;
}): { text: string; route: { kind: string; line: string }; host: string | null; mayRun: string[]; secrets: string[] };
