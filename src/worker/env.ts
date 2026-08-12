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
}
