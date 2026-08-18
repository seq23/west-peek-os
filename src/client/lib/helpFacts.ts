import { AI_EMPLOYEE_ROSTER as ROSTER } from "@shared/registry/aiEmployees";

/**
 * Facts the Help Center states as numbers.
 *
 * A help page that hardcodes "31 employees" is wrong the day someone adds the thirty-second, and
 * nothing fails. So the roster size is DERIVED from the registry the rest of the system uses.
 *
 * The activation cap cannot be derived the same way: it lives in `src/worker/services/aiEmployees`,
 * and importing worker code into the client would ship server logic to the browser. It is therefore
 * restated here and pinned by a unit test that reads the worker constant and fails on drift — the
 * duplication is deliberate and guarded, rather than accidental and silent.
 */

/** Number of AI employee roles on the governed roster. Derived — never typed by hand. */
export const AI_EMPLOYEE_ROSTER = ROSTER.length;

/**
 * Documentation mirror of `MAX_ACTIVE_AI_EMPLOYEES` (D10).
 * Pinned by `tests/help-facts.test.ts`; do not edit one without the other.
 */
export const MAX_ACTIVE_AI_EMPLOYEES_DOC = 5;
