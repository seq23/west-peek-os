export function attachmentUrl(origin: string, cardId: string, routePath: string): URL;
export function chiefClaudeArgs(input: { model: string; cwd: string; job: { employee: { name: string } } }): string[];
export function chiefCodexArgs(output: string): string[];
export function chiefChildEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined>;
export function readChiefRunBudget(): (event: Record<string, unknown>) => string | null;
export function run(
  job: {
    phase: string;
    employee: { name: string };
    card: { id: string };
    request?: string;
    attachments?: { id: string; filename: string; path: string }[];
  },
  ctx: { jobDir: string },
  dependencies?: {
    loadAttachment?: (cardId: string, route: string, target: string) => Promise<void>;
    runClaude?: SeatAttempt;
    runCodex?: SeatAttempt;
    codexUsable?: () => { ok: boolean };
  },
): Promise<{ phase: string; status: string; reply?: string; model_unavailable?: boolean; routing?: string[] }>;

type SeatAttempt = (opts: { cwd: string; prompt: string; resultPath: string }) => Promise<{ code: number; out: string; err: string }>;
