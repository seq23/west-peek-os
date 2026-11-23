/** Types for Porter's PR self-review writer, held by tests/porterPrSelfReview.test.ts. */
export const SELF_REVIEW_CHECKS: ReadonlyArray<{ key: string; name: string }>;
export const SELF_REVIEW_HEADING: string;
export const MUTATION_HEADING: string;
export function selfReviewProblem(result: unknown): string | null;
export function renderSections(result: unknown): string;
export function withoutSections(body: string | null | undefined): string;
export function prBodyWithSelfReview(body: string | null | undefined, result: unknown): { ok: true; body: string } | { ok: false; tag: string; why: string };
export function writeSelfReview(opts: {
  cwd: string;
  number: number;
  result: unknown;
  run: (cmd: string, args: string[], opts: { cwd: string }) => { status: number | null; stdout?: string; stderr?: string };
}): { ok: true; line: string } | { ok: false; tag: string; why: string };
