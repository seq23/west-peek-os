export const CHIEF_TRAILERS: Readonly<Record<"wren" | "walker", string>>;
export function stampedBy(message: string): string[];
export function protectedChiefPath(path: string): boolean;
export function chiefSignoff(input: {
  repo: string; number: number; head: string; branch: string; isolatedFork: boolean;
  messages: string[]; paths: string[]; body: string; comments: string[]; publicKey?: string;
}): string | null;
