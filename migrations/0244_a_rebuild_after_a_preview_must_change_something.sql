-- 0244 — A rebuild after a preview must change something (owner, 28 Sep 2026).
--
-- WHY. On 27 Sep Scooter looked at the community-site preview and wrote "I don't know if people
-- know they can scroll on the flyers to kinda make that thing". The reply reader called it what
-- it is — go ahead, with a change to make — and a BUILD was queued with his words among the
-- answers. The Mac's BUILD saw a branch that already had commits, "verified it is real rather than
-- re-doing it", changed nothing, reported ok, and Porter sent him the SAME preview email a second
-- time and re-asked the same question. Rule 0: a run that exits 0 having done nothing.
--
-- WHAT THIS ADDS. `web_property_change.rebuilt_for` — the partner's words that a CHANGES rebuild
-- is for. Set by the reply, carried to the Mac as the run's whole job, read by the preview email
-- ("Changed since the last preview, as you asked: …"), and the fact the Worker checks a BUILD
-- report against: a CHANGES rebuild whose report does not say the branch head moved is a failed
-- attempt, never a fresh preview. Cleared by a materials check ("preview"/"publish").
ALTER TABLE web_property_change ADD COLUMN rebuilt_for TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0244_a_rebuild_after_a_preview_must_change_something');
