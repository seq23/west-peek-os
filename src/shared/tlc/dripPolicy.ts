import { TLC_DRIP_DAYS } from "./learningClub";

/**
 * THE BRAND EMAILS THAT GO WITHOUT HER APPROVAL OF EACH ONE (owner rulings, 4 Nov 2026, widened 6 Nov 2026).
 *
 * "No email to a TLC brand is sent without her approval of that email, EXCEPT the follow-ups in the drip." The drip is
 * the first email and up to three follow-ups (day 0/3/7/14, shared/tlc/learningClub.ts TLC_DRIP_DAYS). Each follow-up's
 * approval card is decided by this policy, never by a person: the card names the policy as its decider and quotes the
 * rule, so the trail never says a partner approved an email nobody read. `verifyAuthorizationReceipt` accepts this
 * decider for one kind of object only: the `email.send` request of a drip message at a follow-up step (index 1 to 3) on
 * the TLC brand-sales lane, whose card it is. Anything else decided by it is refused; email 1 always needs her.
 * The decider's id keeps its first name ("policy:drip_step_2") so cards already decided by it still verify.
 */
export const DRIP_STEP_2_POLICY = "policy:drip_step_2";
export const DRIP_STEP_2_RULE =
  "Owner ruling, 6 Nov 2026: no email to a TLC brand is sent without her approval of that email, except the drip's follow-ups (emails 2 to 4, day 3/7/14), which go on their own; email 2 carries the brand's samples PDF.";
/** The drip steps (0-based) the policy may approve: every follow-up, never the first email. */
export const DRIP_POLICY_FIRST_STEP = 1;
export const DRIP_POLICY_LAST_STEP = TLC_DRIP_DAYS.length - 1;
