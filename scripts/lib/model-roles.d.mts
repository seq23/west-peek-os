/** Types for scripts/lib/model-roles.mjs — who does the work on the Mac (worker = Codex, brain = Claude). */
export type Role = "worker" | "brain";
export interface Roles {
  default_role: Role;
  jobs: Record<string, Record<string, Role>>;
  worker_route: { provider_id: string; no_training_proven: boolean };
  markers: RegExp[];
  [k: string]: unknown;
}
export interface RunResult { code: number | null; out: string; err: string }
export declare const ROLES_FILE: string;
export declare const CODEX_LIMIT_EXIT: number;
export declare const CODEX_LIMIT_TAG: string;
export declare function loadRoles(text?: string): Roles;
export declare function confidentialMarkerIn(text: string, roles?: Roles): string | null;
export declare function materialsBlock(dirs: readonly string[], roles?: Roles): string | null;
export declare function routeFor(input: { kind?: string | null; phase?: string | null; prompt: string; materialDirs?: readonly string[] }, roles?: Roles): { role: Role; why: string };
export declare function workerLimit(result: RunResult, spent?: (r: RunResult) => string | null): string | null;
export declare function runByRole(deps: {
  route: { role: Role; why: string };
  runBrain: () => Promise<RunResult>;
  runWorker: () => Promise<RunResult>;
  workerSpent?: (r: RunResult) => string | null;
  resetsIn?: (note: string) => number;
  onLine?: (line: string) => void;
}): Promise<RunResult & { servedBy: "claude" | "codex" | "none"; role: Role; codexLimited?: string; resetsInSeconds?: number }>;
