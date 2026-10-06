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
  /**
   * The name every vendor but OpenRouter and Fireworks used to share. KEPT, and still read as a
   * fallback for any provider whose own name is unset — an environment configured before the
   * per-vendor names existed keeps working unchanged. It is no longer what any vendor is REPORTED
   * as using, because one boolean cannot say "Anthropic is configured, OpenAI is not".
   */
  AI_PROVIDER_API_KEY?: string;

  // ── Direct vendor credentials (P16 failover) ──
  // One name per vendor, so "is Anthropic configured?" is answerable independently of every other
  // vendor. Set in Cloudflare production by the operator; never handled, echoed or logged here.
  // The single source of truth for which name belongs to which vendor is
  // src/shared/ai/providerCredentials.ts — these declarations must match it.
  OPENAI_API_KEY?: string;
  /**
   * WP_-PREFIXED DELIBERATELY. DO NOT RENAME TO `ANTHROPIC_API_KEY`.
   *
   * The owner's credential vault treats the bare name as reserved — alongside ANTHROPIC_AUTH_TOKEN,
   * ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK, PATH and LD_PRELOAD — because emitting it into a
   * process environment would hijack her own Claude tooling. The prefix is the reason it can exist
   * at all.
   */
  WP_ANTHROPIC_API_KEY?: string;
  /** Google Gemini. Unrelated to GOOGLE_OAUTH_CLIENT_ID/SECRET, which are the calendar client. */
  GEMINI_API_KEY?: string;
  /** Declared, not configured: no Perplexity key exists in the vault. The lane stays invisible. */
  PERPLEXITY_API_KEY?: string;
  /** Specialist lane (P23). No vendor account exists; these are names only. */
  HARVEY_API_KEY?: string;
  NORM_API_KEY?: string;

  // ── Outbound email (P33) ──
  // Both are required before a single message can leave. A key alone does nothing: arriving in the
  // environment is not a decision to start emailing people.
  /**
   * Cloudflare Workers AI. A platform binding, not a credential — see effects/ for the same
   * pattern with EMAIL. Absent means the cheap tier is unavailable, not that anything is broken.
   */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  /**
   * The Access service token this firm's own browser authenticates with. Present means a request
   * Access has already vouched for can be mapped onto the read-only browser identity; absent means
   * that capability simply does not exist. See auth.ts and migration 0085.
   */
  CF_ACCESS_CLIENT_ID?: string;
  /**
   * The other half of the service token. Used ONLY by the browser client, and only when the host it
   * is opening is this firm's own — see isOwnHost(). The Worker's own auth never reads it: Access
   * has already verified both halves before a request reaches us.
   */
  CF_ACCESS_CLIENT_SECRET?: string;
  /**
   * The Access service token client id the Claude Code claimer on the owner's Mac presents
   * (migration 0187). A NAME, not a secret — the secret half never reaches this Worker, because
   * Access verifies both and forwards only a signed assertion. Absent means the claimer identity
   * simply does not exist and the lane can never be claimed, which is a safe default rather than a
   * broken one: the chain answers every run on the lanes it always used.
   */
  WP_OS_CLAIMER_CLIENT_ID?: string;
  /**
   * 0253: base64 of 32 random bytes; AES-256-GCM key for `secret_handoff` (a value a partner
   * emailed as `SECRET NAME=value`, held until the Mac vaults it). Set once from the vault
   * (`npm run vault:set WP_OS_SECRET_HANDOFF_KEY` then `vault:sync:cloudflare`). Unset = the door
   * fails closed: nothing is stored, the partner is told, the value is still scrubbed.
   */
  WP_OS_SECRET_HANDOFF_KEY?: string;
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
  /**
   * Whether an AI employee may email the Managing Partners. Off unless exactly "enabled".
   * Separate from the one below on purpose — see shared/policy/aiOutbound.ts.
   */
  /** Domain the partners' addresses live on. Derived list, not a hard-coded one. */
  WP_OS_PARTNER_EMAIL_DOMAIN?: string;
  WP_OS_AI_EMAIL_PARTNERS?: string;
  /** Whether an AI employee may email anybody outside the firm. The one with no undo. */
  WP_OS_AI_EMAIL_EXTERNAL?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;

  // ── Google Workspace as the firm (Phase Meet) ──
  // The service account with domain-wide delegation over the ONE partner mailbox
  // `shared/meetings/calendarSources.ts` names. Vault name GSC_SERVICE_ACCOUNT_JSON; aliased to the
  // WP_OS_ spelling by scripts/vault/cloudflare-mapping.json so the Worker keeps its prefix rule.
  WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  /** The firm calendar's private iCal URL — the fallback that survives a password change. Vault name CAL_ICS_WESTPEEK. */
  WP_OS_CAL_ICS_WESTPEEK?: string;
  /** Non-secret: the GCP project that owns the service account, the Meet API enablement and the Pub/Sub topic. */
  WP_OS_GCP_PROJECT_ID?: string;
  /** Non-secret: "projects/{p}/topics/{t}" — where Workspace Events deliver Meet events. */
  WP_OS_MEET_PUBSUB_TOPIC?: string;
  /** Non-secret: "projects/{p}/subscriptions/{s}" — the pull subscription the ingest tick drains. */
  WP_OS_MEET_PUBSUB_SUBSCRIPTION?: string;

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
