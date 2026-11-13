/** Types for scripts/lib/model-roles.mjs — which route does a Mac job's turn (the row of the one rule table). */
export type Role = "worker" | "brain";
export type MacRoute = "claude" | "codex";
export type JobClass = "HARD" | "CLEAR_BRIEF" | "SHORT";
export interface Roles {
  jobs: Record<string, Record<string, JobClass>>;
  markers: RegExp[];
  table: {
    classes: Record<string, { open: string; private: string }>;
    default_class: JobClass;
    order: Record<string, { seats: string[]; free: string; freeLanes: string[] }>;
    codex_result_checked_by_claude?: string[];
    seat_invocation?: Record<string, { model?: string }>;
  };
  [k: string]: unknown;
}
export interface RunResult { code: number | null; out: string; err: string }
export interface Route { jobClass: JobClass; private: boolean; workClass: string; order: MacRoute[]; held: boolean; role: Role; why: string }
export declare const ROLES_FILE: string;
export declare const ORDER_FILE: string;
export declare const JOB_CLASSES: readonly JobClass[];
export declare const CODEX_LIMIT_EXIT: number;
export declare const CODEX_LIMIT_TAG: string;
export declare const CLAUDE_CHECK_TAG: string;
export declare function loadRoles(text?: string, orderText?: string): Roles;
export declare function confidentialMarkerIn(text: string, roles?: Roles): string | null;
export declare function materialsBlock(dirs: readonly string[], roles?: Roles): string | null;
export declare function jobClassFor(kind: string | null | undefined, phase: string | null | undefined, roles?: Roles): JobClass;
export declare function routeFor(input: { kind?: string | null; phase?: string | null; prompt: string; materialDirs?: readonly string[]; privateModelOnly?: boolean }, roles?: Roles): Route;
export declare function workerLimit(result: RunResult, spent?: (r: RunResult) => string | null): string | null;
export declare function runInOrder(deps: {
  route: Route;
  runBrain: () => Promise<RunResult>;
  runWorker: () => Promise<RunResult>;
  brainSpent?: (r: RunResult) => string | null;
  workerSpent?: (r: RunResult) => string | null;
  workerUsable?: () => { ok: boolean; why: string };
  resetsIn?: (notices: string[]) => number;
  onLine?: (line: string) => void;
}): Promise<RunResult & { servedBy: "claude" | "codex" | "none"; role: Role; heldForClaude?: string; bothSpent?: boolean; resetsInSeconds?: number }>;
