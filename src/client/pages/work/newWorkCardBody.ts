/**
 * THE FORM'S STATE, TURNED INTO THE REQUEST BODY — pulled out of `NewWorkCard.tsx` on its own so a
 * test can assert what the create door actually POSTs, not what the component's state holds (Wave
 * B, plan §2).
 *
 * WHY THIS IS A SEPARATE, PURE FUNCTION. PR #103 ("The preview lane, reachable", 18 Sep 2026)
 * shipped 662 lines of test across `tests/previewLane.test.ts` and `tests/previewLaneReach.test.ts`
 * — all of it over server-side owner resolution — and asserted nothing about what the form sends.
 * `recipientAddress` and `showFirst` were computed in the component, printed in its own success
 * message, and never once appeared in the POST body: `git log -S"result_recipient: " --
 * src/client/pages/WorkCardsPage.tsx` returns nothing, in the file's whole history. That defect
 * cannot be caught by a test that reads component state, because the state was always right — only
 * the mapping into the request was wrong, silently, one call site downstream of everything the old
 * tests checked.
 *
 * So the mapping is its own function, with its own name and its own return value, and
 * `tests/newWorkCardBody.test.ts` asserts THAT return value — the actual object `JSON.stringify`
 * turns into the request body — the same way `previewLaneReach.test.ts` asserts the server actually
 * received `result_recipient`/`preview_first`. Two ends of the same wire, each with its own test.
 */
export interface NewWorkCardFormState {
  title: string;
  nextAction: string;
  /** `"HUMAN:<id>"` or `"AI:<id>"` — the value the owner `<select>` already carries. */
  owner: string;
  modelAccess: "PUBLIC_MODEL_APPROVED" | "PRIVATE_MODEL_ONLY";
  audience: "INTERNAL" | "EXTERNAL";
  /** Resolved through the partner registry already — `NewWorkCard`'s own `recipientAddress`. */
  recipientAddress: string;
  /** Always a real boolean. The checkbox is always on the form and always hers to answer. */
  showFirst: boolean;
  priority: string;
  /** An ISO date (`yyyy-mm-dd` from a `<input type="date">`) or "". */
  dueAt: string;
  /** The free-text instruction box — how to do it, not what it is. Maps to `prompt`. */
  prompt: string;
  /** "" means "let it decide from the words" — the server still infers ARTIFACT the way it always has. */
  kind: string;
  /** Only meaningful, and only sent, when `kind` is `WEB_PROPERTY_CHANGE`. Chosen from a dropdown, never typed. */
  propertyHost: string;
}

export type NewWorkCardBody = Record<string, unknown>;

/**
 * THE ONE PLACE STATE BECOMES A REQUEST. Every field below either reaches the body or has a
 * one-line reason it does not (an empty optional is left out, never sent as `""`).
 */
export function buildCreateWorkCardBody(state: NewWorkCardFormState): NewWorkCardBody {
  const body: NewWorkCardBody = {
    title: state.title.trim(),
    owner_type: state.owner.split(":")[0],
    owner_id: state.owner.split(":").slice(1).join(":"),
    model_access: state.modelAccess,
    audience: state.audience,
    /*
     * HER TWO FIELDS — THE FIX. `result_recipient` is null rather than omitted for "it is for you",
     * because null is what the server reads as "nobody to send it to" (see `workCards.ts`).
     * `preview_first` is always sent, never conditionally, because the box is always on the form.
     */
    result_recipient: state.recipientAddress.trim() || null,
    preview_first: state.showFirst,
  };
  if (state.nextAction.trim()) body.next_action = state.nextAction.trim();
  if (state.priority.trim()) body.priority = state.priority.trim();
  if (state.dueAt.trim()) body.due_at = state.dueAt.trim();
  if (state.prompt.trim()) body.prompt = state.prompt.trim();
  if (state.kind.trim()) body.kind = state.kind.trim();
  // NEVER SENT UNLESS THE KIND ASKS FOR IT, and even then only what the dropdown chose — the
  // anti-footgun rule (plan §2): the target repo comes from `WEB_PROPERTIES`, never free text.
  if (state.kind === "WEB_PROPERTY_CHANGE" && state.propertyHost.trim()) {
    body.property_host = state.propertyHost.trim();
  }
  return body;
}
