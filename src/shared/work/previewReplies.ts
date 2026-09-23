import { APPROVAL_WORDS, CHANGE_STARTS, PUBLISH_WORDS } from "./approvalReply";
export { MATERIALS_ADDED_PHRASE } from "./porterNotices";

/**
 * THE FOUR REPLIES TO A PREVIEW, AS THE CARD SENDS THEM (23 Sep 2026). The Preview-ready panel's
 * buttons send exactly the words her email replies use, through the same door, so the one reply
 * reader (`readApprovalReply`) decides what each means: "approved" publishes the preview as it is,
 * "changes: …" re-plans and previews again, "publish" fills in what she added and publishes, and
 * "I added missing items" (its own route, `handleMaterialsAdded`) rebuilds a new preview. Taken from
 * the reader's own lists — never retyped, so a word the reader stops accepting cannot survive here.
 */
export const APPROVED_REPLY: string = APPROVAL_WORDS[0]!;
export const CHANGES_REPLY_PREFIX: string = CHANGE_STARTS[0];
export const PUBLISH_REPLY: string = PUBLISH_WORDS[0]!;
