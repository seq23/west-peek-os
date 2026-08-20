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

  // ── Outbound email (P33) ──
  // Both are required before a single message can leave. A key alone does nothing: arriving in the
  // environment is not a decision to start emailing people.
  RESEND_API_KEY?: string;
  /** Runware image generation. Absent means the capability is simply off, not broken. */
  RUNWARE_API_KEY?: string;
  /** Literal "enabled" switches sending on. Anything else — unset included — keeps it recorded-only. */
  WP_OS_EMAIL_SEND?: string;
  /** Verified sender address. Without it a send is refused rather than guessed. */
  WP_OS_EMAIL_FROM?: string;

  // ── Google OAuth (P51) ──
  // One client for the whole firm; each partner still grants access to their own account. Scopes
  // are read-only, so nothing this system holds can alter anybody's calendar.
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;

  // ── Network OS live pull (P35) ──
  // All three are required. Network OS authenticates a `wpn_session` cookie signed with its own
  // APP_SESSION_SECRET, and only accepts emails on its approved-users list.
  WP_OS_NETWORK_OS_BASE_URL?: string;
  WP_OS_NETWORK_OS_SESSION_SECRET?: string;
  WP_OS_NETWORK_OS_USER_EMAIL?: string;

  // ── Browser Rendering (P44) ──
  // Cloudflare's own headless browser, as a binding rather than an HTTP client — so browser tasks
  // need no egress exemption and no third-party credential.
  BROWSER?: Fetcher;

  // ── Email Sending (P33, Cloudflare transport) ──
  // Like BROWSER: a binding, not an HTTP client, so outbound mail down this path needs no egress
  // exemption and no third-party credential. Typed loosely here because the send_email binding's
  // shape is the platform's own SendEmail type, and cloudflareEmailClient.ts is the only module
  // allowed to call it.
  EMAIL?: SendEmail;
}
