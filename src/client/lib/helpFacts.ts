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
 * Documentation mirrors of the two workforce limits, which used to be one number.
 * Both are pinned by `tests/help-facts.test.ts`; do not edit one without the other.
 *
 * The cap is now the whole roster — every employee may be employed at once. What stayed small is
 * the DUTY window: who the firm leans on at a given hour. Availability and attention are different
 * scarcities, and conflating them capped the workforce at four reachable people.
 */
export const MAX_ACTIVE_AI_EMPLOYEES_DOC = ROSTER.length;
export const FOCUS_TEAM_SIZE_DOC = 5;
