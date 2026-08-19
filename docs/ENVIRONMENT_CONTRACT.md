# Environment Contract — West Peek OS (NAMES ONLY — never values)

Secrets live ONLY in the encrypted vault (`~/.west-peek-os/vault/`). Non-secret config may be
supplied via `wrangler.toml [vars]` / `.dev.vars`-style local config. Status values:
PRESENT / MISSING / UNPROVEN (UNPROVEN = cannot be confirmed without credentials or a human gate).

| Variable | Secret? | Phase first required | Consumed by | Status |
|---|---|---|---|---|
| `WP_OS_ENV` | no | P1 | worker runtime (`local`/`preview`/`production`) | PRESENT (wrangler.toml) |
| `CLOUDFLARE_ACCOUNT_ID` | no | P1 (remote only) | wrangler/deploy | MISSING — CREDENTIAL GATE |
| `CLOUDFLARE_API_TOKEN` | yes (vault) | P1 (remote only) / `vault:sync:cloudflare` | wrangler, Cloudflare API | MISSING — CREDENTIAL GATE |
| `OPENAI_API_KEY` | yes (vault) | P4 live proof | AI provider adapter | MISSING — CREDENTIAL GATE |
| `ANTHROPIC_API_KEY` | yes (vault) | P4 live proof | AI provider adapter | MISSING — CREDENTIAL GATE |
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes (vault) | P4 live proof | AI provider adapter | MISSING — CREDENTIAL GATE |
| `PERPLEXITY_API_KEY` | yes (vault) | P4 live proof (optional provider) | AI provider adapter | MISSING — CREDENTIAL GATE |
| `OPENROUTER_API_KEY` | yes (vault) | P4 live proof (optional provider) | AI provider adapter | MISSING — CREDENTIAL GATE |
| `GOOGLE_OAUTH_CLIENT_ID` | no | P51 calendar + Gmail send | `effects/googleClient.ts` | SET |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes (vault) | P51 calendar + Gmail send | `effects/googleClient.ts` | SET |
| `RESEND_API_KEY` | yes (vault) | P33 outbound email | `effects/resendClient.ts` | SET |
| `WP_OS_EMAIL_FROM` | no — config, not a secret | P33; the address the firm sends as | `effects/*`, `services/sendAs.ts` | SET (`os@westpeek.ventures`) |
| `WP_OS_EMAIL_SEND` | no — config, not a secret | P33; must be the literal `enabled` | `effects/resendClient.ts` | SET (`enabled`) |
| `TELEGRAM_BOT_TOKEN` | yes (vault) | deferred (capture channel) | capture adapter | MISSING — CREDENTIAL GATE |
| `VAPID_PUBLIC_KEY` | no | deferred (push) | notifications | MISSING |
| `VAPID_PRIVATE_KEY` | yes (vault) | deferred (push) | notifications | MISSING — CREDENTIAL GATE |
| `GITHUB_PAT` | yes (vault) | delivery (host-owned) | repo tooling | MISSING — CREDENTIAL GATE |
| `NETWORK_OS_ADAPTER_TOKEN` | yes (vault) | P9 live writeback | Network OS adapter | MISSING — APPROVAL GATE |
| `VDR_API_KEY` | yes (vault) | P10 live data room | VDR adapter | MISSING — PROVIDER NOT SELECTED |
| `FUND_ADMIN_EXPORT_CREDENTIAL` | yes (vault) | P12 live reconciliation | fund-admin import | MISSING — SOURCE CONTRACT GATE |
| `FIREWORKS_API_KEY` | yes (vault) | P16 live proof (optional provider) | `ai/providers/fireworks.ts` via the router | MISSING — CREDENTIAL GATE |
| `AI_PROVIDER_API_KEY` | yes (vault) | P16 live proof (generic HTTPS adapter) | `ai/providers/httpExternal.ts` | MISSING — CREDENTIAL GATE |
| `HARVEY_API_KEY` | yes (vault) | P23 specialist lane | `ai/providers/specialist.ts` | MISSING — VENDOR ACCESS GATE (no account or endpoint) |
| `NORM_API_KEY` | yes (vault) | P23 specialist lane | `ai/providers/specialist.ts` | MISSING — VENDOR ACCESS GATE (no account or endpoint) |
| `NETWORK_OS_API_TOKEN` | yes (vault) | P22 connector status | `connector` registry (presence only) | MISSING — INTEGRATION APPROVAL GATE |
| `CALENDAR_OAUTH_TOKEN` | yes (vault) | P22 meeting prep from a real diary | `connector` registry (presence only) | MISSING — OAUTH CONSENT GATE |
| `EMAIL_OAUTH_TOKEN` | yes (vault) | P22 mailbox connector | `connector` registry (presence only) | MISSING — OAUTH CONSENT GATE |
| `TRANSCRIPTION_API_KEY` | yes (vault) | P22 transcription connector | `connector` registry (presence only) | MISSING — CREDENTIAL + CONSENT GATE |
| `FUND_ADMIN_SFTP_KEY` | yes (vault) | P22/P24 administrator import | `connector` registry (presence only) | MISSING — SOURCE CONTRACT GATE |

**P16/P22/P23 presence semantics.** The provider catalogue, connector list, and specialist lane
report whether a NAME above is populated in the running environment — a boolean derived from
`env`. No value is read for display, returned in a response, or written to a log. The
credential-scrub in `ai/scrub.ts` additionally blocks any credential-shaped string from entering
an LLM context, including a bare variable NAME.

Rules: no plaintext `.env` during ordinary operation; `vault:run -- <cmd>` injects values into child
process memory only; temporary files (if a tool forces one) are 0600, minimal-lifetime, deleted on exit,
and never packaged.

## Outbound email and calendar (P33, P51)

Two settings deliberately live in `wrangler.toml` rather than in secret storage:
`WP_OS_EMAIL_FROM` and `WP_OS_EMAIL_SEND`. They are configuration, not credentials, and keeping
them in the repo means the decision to start emailing people is visible in review rather than
hidden in a dashboard. `WP_OS_EMAIL_SEND` must be the literal string `enabled` — `true`, `yes` and
`1` all leave sending off, which is intentional: it should be impossible to switch on by accident.

The sending domain is verified with Resend. Its DNS records live on the `send` and
`resend._domainkey` subdomains of `westpeek.ventures`, chosen so the root MX — Google Workspace,
which carries the firm's inbound mail — is untouched.

Google OAuth uses ONE client for the firm; each partner grants access to their own account
separately, and the connection is stored per `firm_user`. Refresh tokens live in KV, never in D1:
`partner_connection.credential_name` holds the KV key by NAME, so losing the database is not losing
anybody's Google account. Two consents exist and are deliberately separate — connecting a calendar
asks for `calendar.readonly` alone, and `gmail.send` is requested only when a partner turns on
sending under their own name.
