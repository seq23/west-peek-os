-- 0039_browser_provider_swap.sql — P44: Browser Rendering replaces Browserbase.
--
-- The scaffold in 0037 registered Browserbase and its x402 pay-per-use lane. Cloudflare Browser
-- Rendering is native to the platform this Worker already runs on, which removes the second vendor,
-- the second credential, and the autonomous-payment surface entirely — x402 exists so an agent can
-- pay a stranger, and there is no stranger when the browser is on your own account.
--
-- The governance in 0037 is unchanged and still applies: approval before execution, SSRF guard on
-- the target, untrusted page content fenced, charges append-only. Swapping the vendor does not
-- relax any of it.
--
-- Browserbase is left registered and DISABLED rather than deleted: it is a real alternative if the
-- platform browser ever proves insufficient, and a disabled row is a documented option while a
-- deleted one is forgotten history.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0039_browser_provider_swap');

INSERT OR IGNORE INTO provider_registry
  (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json, base_url, firm_scope)
VALUES
  ('prv_cf_browser', 'cloudflare_browser', 'Cloudflare Browser Rendering', 1, 0,
   '["browser.navigate","browser.extract"]',
   '{"billing":"included in the Workers account; no separate vendor","x402":"not applicable"}',
   '', 'west-peek');

-- Payment mode is meaningless on the platform browser. Any task still sitting in X402_AUTO is
-- reset so no row claims an authority the transport no longer has.
UPDATE browser_task SET payment_mode = 'NONE', max_price_usd = 0
 WHERE payment_mode = 'X402_AUTO' AND status IN ('REQUESTED','APPROVED');
