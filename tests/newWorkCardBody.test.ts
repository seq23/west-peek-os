import { describe, expect, it } from "vitest";
import { buildCreateWorkCardBody, type NewWorkCardFormState } from "../src/client/pages/work/newWorkCardBody";

/**
 * THE REQUEST BODY, ASSERTED DIRECTLY (Wave B, plan §2).
 *
 * PR #103 ("The preview lane, reachable", 18 Sep 2026) shipped 662 lines of test over server-side
 * owner resolution and never once asserted what the create form actually sends. The form computed
 * `recipientAddress` and `showFirst`, said in its own success message where the result would go,
 * and neither field ever reached the POST body — `git log -S"result_recipient: " --
 * src/client/pages/WorkCardsPage.tsx` returned nothing, in the file's whole history, until this
 * wave. `kind` was a second field with the identical defect one layer down: `createWorkCardSchema`
 * never accepted it at all.
 *
 * So this file tests the one function that turns the form's state into the request —
 * `buildCreateWorkCardBody` — and asserts its RETURN VALUE, the literal object `JSON.stringify`
 * would turn into the body. Not component state. Not a rendered DOM. The actual request.
 */

const BASE: NewWorkCardFormState = {
  title: "Get Sensori's SPV terms from the paperwork",
  nextAction: "",
  owner: "HUMAN:fu_sequoia_taylor",
  modelAccess: "PUBLIC_MODEL_APPROVED",
  audience: "INTERNAL",
  recipientAddress: "",
  showFirst: false,
  priority: "NORMAL",
  dueAt: "",
  prompt: "",
  kind: "",
  propertyHost: "",
};

describe("buildCreateWorkCardBody — the fix PR #103 needed and never got", () => {
  it("sends result_recipient and preview_first — the two fields that were dropped", () => {
    const body = buildCreateWorkCardBody({
      ...BASE,
      recipientAddress: "scooter@westpeek.ventures",
      showFirst: true,
    });
    expect(body.result_recipient).toBe("scooter@westpeek.ventures");
    expect(body.preview_first).toBe(true);
  });

  it("sends result_recipient: null and preview_first: false for a blank recipient, never omitting either", () => {
    const body = buildCreateWorkCardBody({ ...BASE, recipientAddress: "", showFirst: false });
    // NOT `undefined` and NOT missing from the object — a key that never made it into the body is
    // exactly how this shipped broken the first time. `preview_first` is always a real boolean,
    // because the box is always on the form and always hers to answer; `result_recipient` is null,
    // which the server reads as "nobody said" the same way `createWorkCardSchema` always has.
    expect(Object.prototype.hasOwnProperty.call(body, "result_recipient")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, "preview_first")).toBe(true);
    expect(body.result_recipient).toBeNull();
    expect(body.preview_first).toBe(false);
  });

  it("sends kind only when one was chosen", () => {
    expect(buildCreateWorkCardBody({ ...BASE, kind: "" }).kind).toBeUndefined();
    expect(buildCreateWorkCardBody({ ...BASE, kind: "BLOG_HELP" }).kind).toBe("BLOG_HELP");
  });

  it("sends property_host only for WEB_PROPERTY_CHANGE, and never a typed value for anything else", () => {
    const webChange = buildCreateWorkCardBody({ ...BASE, kind: "WEB_PROPERTY_CHANGE", propertyHost: "westpeek.ventures" });
    expect(webChange.property_host).toBe("westpeek.ventures");

    // A host typed while some OTHER kind is selected must never reach the request — the anti-footgun
    // rule holds even against a stale value left over from switching the selector back and forth.
    const otherKind = buildCreateWorkCardBody({ ...BASE, kind: "ARTIFACT", propertyHost: "westpeek.ventures" });
    expect(otherKind.property_host).toBeUndefined();

    const noKind = buildCreateWorkCardBody({ ...BASE, kind: "", propertyHost: "westpeek.ventures" });
    expect(noKind.property_host).toBeUndefined();
  });

  it("sends the priority the select always carries, and the due date and instruction box only when set", () => {
    // The priority `<select>` always has a value (it defaults to NORMAL and there is no blank
    // option), so it is always in the body — the same shape `model_access`/`audience` already have.
    expect(buildCreateWorkCardBody(BASE).priority).toBe("NORMAL");
    expect(buildCreateWorkCardBody(BASE).due_at).toBeUndefined();
    expect(buildCreateWorkCardBody(BASE).prompt).toBeUndefined();

    const filled = buildCreateWorkCardBody({ ...BASE, priority: "URGENT", dueAt: "2026-10-01", prompt: "Keep it under a page." });
    expect(filled.priority).toBe("URGENT");
    expect(filled.due_at).toBe("2026-10-01");
    expect(filled.prompt).toBe("Keep it under a page.");
  });

  it("always resolves owner_type/owner_id from the combined owner value", () => {
    expect(buildCreateWorkCardBody({ ...BASE, owner: "AI:aie_porter" })).toMatchObject({
      owner_type: "AI",
      owner_id: "aie_porter",
    });
  });

  it("trims the title and next action, and omits next_action entirely when blank", () => {
    const body = buildCreateWorkCardBody({ ...BASE, title: "  Draft the note  ", nextAction: "  " });
    expect(body.title).toBe("Draft the note");
    expect(Object.prototype.hasOwnProperty.call(body, "next_action")).toBe(false);
  });
});
