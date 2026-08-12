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
| `GOOGLE_OAUTH_CLIENT_ID` | no | P7/P9 live scopes | calendar/Gmail adapters | MISSING — CREDENTIAL GATE |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes (vault) | P7/P9 live scopes | calendar/Gmail adapters | MISSING — CREDENTIAL GATE |
| `TELEGRAM_BOT_TOKEN` | yes (vault) | deferred (capture channel) | capture adapter | MISSING — CREDENTIAL GATE |
| `VAPID_PUBLIC_KEY` | no | deferred (push) | notifications | MISSING |
| `VAPID_PRIVATE_KEY` | yes (vault) | deferred (push) | notifications | MISSING — CREDENTIAL GATE |
| `GITHUB_PAT` | yes (vault) | delivery (host-owned) | repo tooling | MISSING — CREDENTIAL GATE |
| `NETWORK_OS_ADAPTER_TOKEN` | yes (vault) | P9 live writeback | Network OS adapter | MISSING — APPROVAL GATE |
| `VDR_API_KEY` | yes (vault) | P10 live data room | VDR adapter | MISSING — PROVIDER NOT SELECTED |
| `FUND_ADMIN_EXPORT_CREDENTIAL` | yes (vault) | P12 live reconciliation | fund-admin import | MISSING — SOURCE CONTRACT GATE |

Rules: no plaintext `.env` during ordinary operation; `vault:run -- <cmd>` injects values into child
process memory only; temporary files (if a tool forces one) are 0600, minimal-lifetime, deleted on exit,
and never packaged.
