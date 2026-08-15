/** Worker environment bindings. Names must match wrangler.toml. */
export interface Env {
  /** D1 — relational operational truth. */
  WP_OS_DB: D1Database;
  /** R2 — governed binary documents/artifacts only. Optional at runtime; absence degrades cleanly. */
  WP_OS_DOCUMENTS?: R2Bucket;
  /** KV — ephemeral/config/cache only. Never institutional truth. */
  WP_OS_KV?: KVNamespace;
  /** Static React client assets (SPA). */
  ASSETS: Fetcher;
  /** local | preview | production */
  WP_OS_ENV: string;
  /**
   * Provider credentials (P16). Names only — values live in the encrypted vault and are
   * injected as Worker secrets by the operator. Absent in every current environment, which is
   * why every external provider path is UNPROVEN — CREDENTIAL GATE. Never log or echo these.
   */
  OPENROUTER_API_KEY?: string;
  FIREWORKS_API_KEY?: string;
  AI_PROVIDER_API_KEY?: string;
  /** Specialist lane (P23). No vendor account exists; these are names only. */
  HARVEY_API_KEY?: string;
  NORM_API_KEY?: string;
}
