-- Per-deal PDF edits and owner-only price exceptions. Existing rows retain the baseline.
ALTER TABLE tlc_samples ADD COLUMN overrides_json TEXT CHECK (overrides_json IS NULL OR json_valid(overrides_json));
ALTER TABLE tlc_samples ADD COLUMN approved_prices_json TEXT CHECK (approved_prices_json IS NULL OR json_valid(approved_prices_json));
ALTER TABLE tlc_samples ADD COLUMN document_id TEXT REFERENCES document(id);
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0279_tlc_samples_overrides');
