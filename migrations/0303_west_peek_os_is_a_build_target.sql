-- 0303 · WEST PEEK OS ITSELF IS A BUILD TARGET (13 Nov 2026).
--
-- The owner's ask: a partner emails os@ and "building sites, apps, dashboards (external from west peek
-- OS and internal) wont be a problem". An internal dashboard or screen is a change to this repo, so the
-- OS is registered as one more repo Porter may build in: PLAN, BUILD and LAND through ~/bin/land, under
-- the same gates as every repo (a PR, CI green, the partner's word on the preview, migrations additive).
--
-- Seeded (1): the host -> repo binding can never be re-pointed by an email. No words: naming the OS in
-- passing is not a build; the plain-words reader's "a build inside the OS", the host, or
-- seq23/west-peek-os reaches it (src/shared/intake/webPropertyChange.ts OS_PROPERTY). Additive only.
INSERT OR IGNORE INTO web_property_registry (id, host, repo, github_repo, site, words_json, aliases_json, pages_host, seeded, position) VALUES
  ('wpr_os_joinwestpeek_com', 'os.joinwestpeek.com', 'west-peek-os', 'seq23/west-peek-os', '.', '[]', '[]', NULL, 1, 9);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0303_west_peek_os_is_a_build_target');
