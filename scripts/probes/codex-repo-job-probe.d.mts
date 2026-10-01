export const COMMIT_SUBJECT: string;
export function probePrompt(o: { branch: string; remoteUrl?: string | null }): string;
export function lsRemoteHash(text: string): string | null;
export interface ProbeRow { q: string; status: "PROVEN" | "FAILED" | "UNTESTED"; evidence: string }
export function verdicts(o: Record<string, unknown>): ProbeRow[];
export function runProbe(o?: { codexBin?: string; home?: string; remoteUrl?: string | null; keep?: boolean }): Promise<{ rows: ProbeRow[]; dir: string }>;
