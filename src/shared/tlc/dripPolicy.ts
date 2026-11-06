/**
 * THE ONE BRAND EMAIL THAT GOES WITHOUT HER APPROVAL OF IT (owner rulings, 4 Nov 2026).
 *
 * "No email to a TLC brand is sent without her approval of that email, EXCEPT the drip's 2nd email (the one
 * follow-up)." That email's approval card is decided by this policy, never by a person: the card names the policy as
 * its decider and quotes the rule, so the trail never says a partner approved an email nobody read.
 * `verifyAuthorizationReceipt` accepts this decider for one object only: the `email.send` request of a drip message at
 * step index 1 (the second email) on the TLC brand-sales lane, whose card it is. Anything else decided by it is refused.
 */
export const DRIP_STEP_2_POLICY = "policy:drip_step_2";
export const DRIP_STEP_2_RULE =
  "Owner ruling, 4 Nov 2026: no email to a TLC brand is sent without her approval of that email, except the drip's 2nd email (the one follow-up), which goes on its own with the brand's samples PDF attached.";
