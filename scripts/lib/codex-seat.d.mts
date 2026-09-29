/** Types for scripts/lib/codex-seat.mjs (the Mac scripts are plain ESM; tests import them). */
export declare function codexOnSubscription(authJsonText: string): boolean;
export declare function codexSeatUsable(home?: string): { ok: boolean; why: string };
export declare function codexExecArgs(addDirs?: string[]): string[];
export declare function gitCommonDirs(dirs: string[], gitDirOf: (dir: string) => string | null): string[];
export declare function helpMentions(helpText: string | undefined, flag: string): boolean;
export interface RunResult {
  code: number | null;
  out: string;
  err: string;
}
export interface FallbackResult extends RunResult {
  servedBy: "claude" | "codex";
  handedOver: boolean;
}
export declare function runWithCodexFallback(deps: {
  runClaude: () => Promise<RunResult>;
  runCodex: () => Promise<RunResult>;
  /** Returns a short description of the spent-usage notice, or null when the result is not one. */
  limited: (r: RunResult) => string | null;
  usable: () => { ok: boolean; why: string };
  /** Returns the first unsupported flag, or null when all are supported. */
  supports: (flags: string[]) => Promise<string | null>;
  addDirs?: string[];
  onLine?: (line: string) => void;
}): Promise<FallbackResult>;
