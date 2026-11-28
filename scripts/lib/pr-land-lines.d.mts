/** Types for Porter's pre-land description lines, held by tests/porterPrLandLines.test.ts. */
type Code = { code: string; why: string };
type Run = (cmd: string, args: string[], opts: { cwd: string }) => { status: number | null; stdout?: string; stderr?: string };
export const LAND_LINE_FOR: Record<string, { key: string; prefix: string | null }>;
export const REVIEWER_CODES: Set<string>;
export const NOT_BUILT_HEADING: string;
export function parseLandCheck(output: string | null | undefined): { codes: Code[] };
export function sortCodes(codes: readonly Code[]): { builder: Code[]; reviewer: Code[]; other: Code[] };
export function landLinesProblem(lines: unknown, codes: readonly Code[]): string | null;
export function prBodyWithLandLines(body: string | null | undefined, lines: unknown, codes: readonly Code[]): { ok: boolean; body?: string; tag?: string; why?: string };
export function writeLandLines(opts: { cwd: string; number: number; lines: unknown; codes: readonly Code[]; run: Run }): { ok: true; line: string } | { ok: false; tag: string; why: string };
export function landLinesNote(checkOutput: string, linesPath: string): string;
