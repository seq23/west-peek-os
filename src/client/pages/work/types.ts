import type { Block } from "@shared/work/blocks";

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
  work_attempts?: number;
  /**
   * 0185 — WHAT WENT WRONG ON THE LAST ATTEMPT, while the card is still retrying and not yet
   * blocked. This is the field that stops a failing card reading as a waiting one.
   */
  work_last_failure?: string | null;
  work_last_failure_at?: string | null;
  /** 0173 — present only while the card is blocked: the four sentences and the doors. */
  block?: (Block & { blockedAt: string | null; lane?: string | null; laneName?: string | null; raw?: string | null }) | null;
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
