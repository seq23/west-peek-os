export interface SearchParse {
  events: number;
  queries: string[];
  answer: string;
  errorText: string;
  /** How the CLI's turn ended: finished, failed, or neither (stream cut off). */
  terminal: "completed" | "failed" | null;
}
export function codexSearchArgs(prompt: string): string[];
export function claudeSearchArgs(prompt: string): string[];
export function parseCodexSearch(stdout: string): SearchParse;
export function parseClaudeSearch(stdout: string): SearchParse;
export function searchOutcome(
  parsed: SearchParse,
  displayName: string,
): { ok: true; output: string; searchEvents: number; searchQueries: string[] } | { ok: false; error: string; errorText?: string };
