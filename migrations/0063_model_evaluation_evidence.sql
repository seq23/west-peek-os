-- A LIVE model evaluation has to point at the run that proves it.
--
-- The evaluation gate exists so a model becomes the firm's default only after somebody measured
-- something and said how. LIVE was the one method that could not be recorded at all: the handler
-- refused it outright on the grounds that "no provider credential is configured, so this would be
-- a false record". That was true when it was written and is no longer — OpenRouter is configured
-- and real provider calls happen every day — so the refusal had stopped protecting anything and
-- started blocking the honest case.
--
-- Removing the refusal alone would have made LIVE the weakest method rather than the strongest,
-- since it is a claim about something that happened elsewhere. So a LIVE evaluation now cites the
-- ai_run that constitutes its evidence, and the handler verifies that run exists, completed, and
-- ran on the model being evaluated. The claim becomes checkable by anyone reading the audit trail
-- instead of taken on trust.
--
-- Nullable because FIXTURE and OFFLINE_DETERMINISTIC evaluations have no run to cite, and because
-- the rows already in this table predate the column.
ALTER TABLE model_evaluation ADD COLUMN ai_run_id TEXT REFERENCES ai_run (id);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0063_model_evaluation_evidence');
