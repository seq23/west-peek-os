import { APPROVAL_WORDS } from "./approvalReply";

/**
 * THE FOUR REPLIES TO A PREVIEW, AS THE CARD SENDS THEM (23 Sep 2026). The Preview-ready panel's
 * buttons send exactly the words her email replies use, through the same door, so the one reply
 * reader (`readApprovalReply`) decides what each means. Re-exported from the reader's own lists —
 * never retyped, so a word the reader stops accepting cannot survive here.
 */
export const APPROVED_REPLY: string = APPROVAL_WORDS[0]!;
export const CHANGES_REPLY_PREFIX = "changes:";
// PENDING-REBASE: PUBLISH_WORDS and MATERIALS_ADDED_PHRASE come from the reply-reader work landing next.
export const PUBLISH_REPLY = "publish";
export const MATERIALS_ADDED_PHRASE = "I added missing items";
