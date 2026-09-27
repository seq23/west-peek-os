import type { Block } from "@shared/work/blocks";
import type { LiveRun } from "@shared/work/liveStatus";
import type { PartnerView } from "@shared/work/partnerOwnership";

/**
 * The row shapes the Work surface reads, in one place.
 *
 * WHY THEY MOVED HERE (22 Sep 2026). `WorkCardsPage.tsx` was 1,588 lines carrying the masthead,
 * the create form, the bands, the block doors, the note thread and the look panel in one function.
 * Four separate pieces of work each needed to change part of it and could not do so side by side.
 * Splitting the page moved the components; the row shapes they all read had to stop living inside
 * one of them, or every file would import the others for its types.
 *
 * Nothing here changed shape in the split. These are the same interfaces, moved verbatim.
 */

export interface WorkCardRow {
  id: string;
  title: string;
  description: string | null;
  state: string;
  priority: string;
  owner_type: string;
  owner_id: string | null;
  next_action: string | null;
  due_at: string | null;
  capture_id: string | null;
  created_at: string;
  owner_name?: string | null;
  owner_role?: string | null;
  allows_browser?: number;
  /** PUBLIC_MODEL_APPROVED | PRIVATE_MODEL_ONLY — which models may see it. */
  model_access?: string | null;
  /** INTERNAL | EXTERNAL — whether it previews before it leaves. Not a model decision. */
  audience?: string | null;
  /**
   * WHERE THE LAST RUN ACTUALLY WENT. Read from `ai_run`, which is immutable, so recategorising a
   * card changes where its NEXT run goes and cannot touch the record of where the last one went.
   */
  last_run?: { provider_key: string | null; model: string | null; status: string; cost_usd: number | null; at: string } | null;
  kind?: string | null;
  /**
   * WAVE A (22 Sep 2026): who asked and how, and the hand-off trail — selected by `handleWorkByOwner`
   * since 22 Sep but never read by anything until the card detail page.
   */
  requested_by_email?: string | null;
  request_json?: string | null;
  preview_first?: number | null;
  /** 0238: `web_property_change.preview_only` — the site's own preview gate; NULL off web property cards. */
  site_preview_only?: number | null;
  result_recipient?: string | null;
  assigned_from_card_id?: string | null;
  /**
   * HELD (0227, Wave D). All three are set together and cleared together; `held_by_name` is the
   * resolved partner name, because "fu_sequoia_taylor held this" is an id, not an answer.
   */
  held_reason?: string | null;
  held_by?: string | null;
  held_by_name?: string | null;
  held_at?: string | null;
  work_attempts?: number;
  /**
   * WAVE A: live progress, server-side only until now — `work_steps` against
   * `MAX_STEPS_PER_CARD` (shared/work/employeeLoop.ts) and the lease that says who is claiming the
   * card right now, and until when.
   */
  work_steps?: number;
  lease_until?: string | null;
  created_by?: string | null;
  /**
   * WAVE C (22 Sep 2026): the AI employee who OPENED the row directly, when it was one — resolved
   * server-side so the desk's origin badge does not need a second lookup. Null for every other
   * origin, including a hand-off (which reads `assigned_from_card_id` first).
   */
  created_by_ai_name?: string | null;
  meeting_id?: string | null;
  /**
   * 0185 — WHAT WENT WRONG ON THE LAST ATTEMPT, while the card is still retrying and not yet
   * blocked. This is the field that stops a failing card reading as a waiting one.
   */
  work_last_failure?: string | null;
  work_last_failure_at?: string | null;
  /** 0173 — present only while the card is blocked: the four sentences and the doors. */
  block?: (Block & { blockedAt: string | null; lane?: string | null; laneName?: string | null; raw?: string | null }) | null;
  /** 0173 — when the card stopped, for the timeline. */
  blocked_at?: string | null;
  /** 0173/0241 — the first name (in capitals) of the partner the block waits on; the new primary after a hand-off. */
  block_who?: string | null;
  /**
   * THE WORK-CARD REDESIGN (23 Sep 2026). The run her Mac holds for this card, the name the desk
   * shows, and a website job's own facts — the three things `liveStatus` and `siteStage`
   * (shared/work) read so the row, the expanded card and the card's page say one thing.
   */
  current_run?: LiveRun | null;
  plain_title?: string | null;
  parent_title?: string | null;
  site_host?: string | null;
  site_repo?: string | null;
  site_phase?: string | null;
  site_preview_url?: string | null;
  site_land_approved_at?: string | null;
  site_merge_sha?: string | null;
  site_publish_ready?: number | null;
  site_ask?: string | null;
  site_check_state?: string | null;
  /** A website job's Mac runs per phase ("plan 2 · build 1"); null off site cards. */
  site_tries?: Array<{ phase: string; tries: number }> | null;
  site_forced_by?: string | null;
  site_plan_filed_at?: string | null;
  site_plan_approved_at?: string | null;
  /** 0241: the partner who owns the card and the one it was handed to — primary first. */
  primary_partner?: PartnerView | null;
  secondary_partner?: PartnerView | null;
  /** "Owner: Sequoia · Secondary: Scooter", or null. */
  partner_owner_line?: string | null;
  /** 0239: a JSON list of partner addresses cc'd on the finished email. */
  cc_emails?: string | null;
  looks?: Array<{
    id: string; objective: string; start_url: string; status: string;
    result_text: string | null; refusal_reason: string | null;
  }>;
}

export interface RecentRun {
  ai_employee_id: string;
  employee_name: string;
  purpose: string;
  status: string;
  created_at: string;
}

/**
 * WHAT SHE TYPED, AND WHAT IT TURNED INTO (0175).
 *
 * Her question was "tell me what my instructions turned into", asked of an agent, about a database.
 * The answer belongs on the card, so she never has to ask it that way again.
 */
export interface InstructionReceipt {
  said: Array<{ source: string; text: string; who: string | null }>;
  interpretation: { understood: string; steer: string[]; cannot: string[] } | null;
  failure?: string;
  model: string | null;
  at: string;
}

export interface WorkCardNote {
  id: string;
  body: string;
  response: string | null;
  acknowledged_at: string | null;
  created_at: string;
  author: string | null;
}

/** Who a card may be handed to — the roster the board hands down, never a guess. */
export interface Assignable {
  employees: Array<{ id: string; name: string; role: string }>;
  partners: Array<{ id: string; full_name: string }>;
}
