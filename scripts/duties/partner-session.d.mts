export function attachmentUrl(origin: string, cardId: string, routePath: string): URL;
export function chiefClaudeArgs(input: { model: string; cwd: string; job: { employee: { name: string } } }): string[];
export function chiefChildEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined>;
export function readChiefRunBudget(): (event: Record<string, unknown>) => string | null;
export function run(
  job: {
    phase: string;
    employee: { name: string };
    card: { id: string };
    attachments?: { id: string; filename: string; path: string }[];
  },
  ctx: { jobDir: string },
  dependencies?: {
    loadAttachment?: (cardId: string, route: string, target: string) => Promise<void>;
    runModel?: (opts: { cwd: string; prompt: string }) => Promise<{ code: number; out: string; err: string }>;
  },
): Promise<{ phase: string; status: string; reply?: string }>;
