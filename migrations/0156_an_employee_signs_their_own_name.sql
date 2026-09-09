-- 0156 — An employee signs their own name, on West Peek's own domain.
--
-- Operator, 9 Sep 2026: "why dont any of the ai employees from os.joinwestpeek.com have emails from
-- @joinwestpeek.com".
--
-- SHE IS RIGHT AND THERE WAS NEVER A TECHNICAL REASON. `joinwestpeek.com` has been a verified
-- sending domain on West Peek's Resend account the whole time. The employees simply had no sender
-- identity: every message an employee caused went out as the firm's `WP_OS_EMAIL_FROM`, and when
-- the coordinator wired one to a notifier by hand he reused Boss OS's — so a WEST PEEK employee
-- signed three emails from `preston@sequoiataylor.com`, the domain of her PERSONAL OS. That is the
-- business-blending defect she corrected once already this morning, in the opposite direction.
--
-- The addresses themselves are code, not data: `shared/registry/employeeMail.ts` derives them from
-- the roster, which is closed and validated, because a verified domain signs any local part and a
-- typo would send perfectly from an address belonging to nobody. This migration is the RECORD.
--
-- WHAT THE RECORD WAS MISSING. The From has always been in the receipt's prose — "Delivered to X as
-- Y via Resend" — and prose is unqueryable. "Has any employee ever sent from the wrong domain" took
-- a human reading every receipt, which is why it took the operator noticing a signature to catch it.
-- Noticing is not a control.
--
-- `sender_address` IS THE ADDRESS USED, NOT THE ONE THAT SHOULD HAVE BEEN. It is written at
-- execution from the value handed to the transport, so a future wrong sender is a query rather than
-- an investigation. NULL on every existing row and deliberately not backfilled: this repo sent two
-- emails ever, both in August, both requested by Sequoia herself — checked, not assumed — and
-- inventing a From for them would be fabricating provenance in the one table that exists to prove
-- what left the building. Preston's three emails today were sent by Boss OS, not by this system;
-- West Peek OS has no record of them because it did not send them, and it must not grow one.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0156_an_employee_signs_their_own_name');

ALTER TABLE external_effect_request ADD COLUMN sender_address TEXT;

CREATE INDEX IF NOT EXISTS idx_external_effect_sender ON external_effect_request (sender_address);
