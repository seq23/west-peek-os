-- Placeholder values: numbers that are there to be replaced, and say so.
--
-- Sensori is the case. It is a closed $10K SPV whose entry price and share count nobody has to
-- hand, and without them there is no ownership, no mark and no return — so the firm's only
-- investment cannot be valued. The choice was between leaving the fields empty until someone digs
-- out the paperwork, or filling them with something plausible.
--
-- Filling them with something plausible is how a system starts lying. A number that is indis-
-- tinguishable from a real one gets read, charted, and eventually reported to an LP, and nobody
-- can tell afterwards which figures were ever true. That is the failure this schema is built to
-- prevent everywhere else, and it should not get an exception here.
--
-- So a value may be a placeholder, and the row carries the list of which fields are. A placeholder
-- is loud rather than quiet: every surface that shows one has to show that it is one, arithmetic
-- that depends on it is not to be trusted, and the list is exactly the agenda for the meeting where
-- the real numbers get typed in. Editing a field removes it from the list, so the record heals as
-- it is corrected and nobody has to remember to clear a flag.
--
-- A JSON array rather than a boolean per column: which fields are provisional differs per record,
-- and a column-per-flag would need a migration every time a new field could be estimated.

ALTER TABLE investment_opportunity ADD COLUMN placeholder_fields TEXT NOT NULL DEFAULT '[]';
ALTER TABLE investment_opportunity ADD COLUMN placeholder_note TEXT;

-- Partial index: the interesting query is always "what still needs confirming", never the
-- overwhelming majority of rows that have nothing provisional about them.
CREATE INDEX IF NOT EXISTS idx_opportunity_placeholders
  ON investment_opportunity (placeholder_fields)
  WHERE placeholder_fields <> '[]';
