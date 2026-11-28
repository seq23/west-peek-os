type Draft = { action?: "draft"; base: string; patch: string; title: string } | { action: "resume"; base: string; title: string };
export function prepareChiefDraft(
  call: { chief: "wren" | "walker"; id: string }, change: Draft,
  config: { project: string; fork: string; forkToken: string; pullsToken: string },
  dependencies: {
    reviewedBase: (project: string) => Promise<boolean>;
    currentLease: () => Promise<boolean>;
    publicContent: (title: string, patch: string) => Promise<boolean>;
    run?: (token: string, command: string, args: string[], input?: string, cwd?: string) => Promise<string>;
  },
): Promise<{ ok: false; code: string; head?: string } | { ok: true; receipt: string; head: string }>;
