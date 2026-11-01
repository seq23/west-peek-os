-- 0283 · GO / NO-GO OUT OF THE HOLIDAY WEEK (decided 31 Oct 2026). shared/tlc/goNoGo.ts: a go/no-go date on 24 Dec–1 Jan
-- moves to the Friday before 24 Dec. The February 2027 club (Thu 11 Feb) was stored as Thu 24 Dec 2026; it becomes
-- Fri 18 Dec 2026. Only that stored value is changed, and only if it is still the old one. Data only.
UPDATE tlc_event SET go_no_go_date = '2026-12-18', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'tlc_2027-02' AND go_no_go_date = '2026-12-24' AND dropped_at IS NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0283_tlc_go_no_go_holiday_week');
