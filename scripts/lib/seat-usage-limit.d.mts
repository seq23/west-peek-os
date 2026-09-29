/** Types for scripts/lib/seat-usage-limit.mjs (the Mac scripts are plain ESM; tests import them). */
export declare const SHORT_OUTPUT_CHARS: number;
export declare const DEFAULT_COOLDOWN_SECONDS: number;
export declare const MIN_COOLDOWN_SECONDS: number;
export declare const MAX_COOLDOWN_SECONDS: number;
export declare function detectUsageLimit(
  output: { stdout?: string; stderr?: string },
  nowMs?: number,
): { limited: boolean; snippet: string; retryAfterSeconds: number | null };
export declare function retryAfterFrom(text: string, nowMs?: number): number | null;
