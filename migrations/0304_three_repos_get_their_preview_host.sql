-- 0304 · THREE REPOS GET THEIR PREVIEW HOST (13 Nov 2026).
--
-- network.joinwestpeek.com, venturedeals.joinwestpeek.com and dilution.joinwestpeek.com had no
-- pages_host, so a build there never waited for, or linked, a preview. Each already has a Cloudflare
-- Pages project connected to its repo (CONFIRMED read-only against the Cloudflare API, 13 Nov 2026:
-- west-peek-network-os, secondaries, founder-dilution-dashboard, each serving its custom domain), so
-- every PR already gets a preview at <branch>.<project>.pages.dev. This only records it.
--
-- Additive: a NULL is filled, nothing is overwritten (WHERE pages_host IS NULL). host -> repo untouched.
UPDATE web_property_registry SET pages_host = 'west-peek-network-os.pages.dev', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE repo = 'west-peek-network-os' AND pages_host IS NULL;
UPDATE web_property_registry SET pages_host = 'secondaries.pages.dev', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE repo = 'secondaries' AND pages_host IS NULL;
UPDATE web_property_registry SET pages_host = 'founder-dilution-dashboard.pages.dev', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE repo = 'founder-dilution-dashboard' AND pages_host IS NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0304_three_repos_get_their_preview_host');
