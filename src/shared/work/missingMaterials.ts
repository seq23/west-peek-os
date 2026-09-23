/**
 * MISSING MATERIALS — ONE LIST, ONE RENDERER, EVERY EMPLOYEE (23 Sep 2026, migration 0237).
 *
 * Her question: "is he going to send me a list of missing materials and ask me to upload them?"
 * Until today, no: Porter's plan named placeholders and never asked for the files, and no other
 * employee had anywhere to say "I need the logo". Now every card carries one list,
 * `work_card.missing_materials_json` (what is needed, and where it goes), written by whichever run
 * found the gap and rendered HERE into every email the requester gets about the card:
 *
 *   ASK    a question or a plan waiting on them: "Missing materials" — each item, where it goes,
 *          and how to send it (the Drive folder, or attached to a reply).
 *   STILL  a preview or a finished piece of work: "Still missing" — what shipped without it.
 *
 * PURE, like the rest of shared/work: the list is stored once and read the same way every time.
 */

export interface MissingMaterial {
  /** The thing: "the Sengo logo (SVG or PNG)", "Q3 fund letter PDF". */
  item: string;
  /** Where it goes: "the portfolio grid on the ventures site", "the LP update's appendix". */
  where: string;
}

/** How to send it. One sentence, the same everywhere, so a partner learns it once. */
export const HOW_TO_SEND_MATERIALS = "Add it to the Drive folder, or attach it to your reply to this email — I pick it up on the next run.";

/** Read a stored or reported list strictly: an entry without an item is dropped; a missing `where` says so. */
export function readMissingMaterials(v: unknown): MissingMaterial[] {
  let raw: unknown = v;
  if (typeof v === "string") {
    try {
      raw = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: MissingMaterial[] = [];
  for (const e of raw) {
    if (typeof e === "string" && e.trim()) out.push({ item: e.trim().slice(0, 300), where: "where the work needs it" });
    else if (e && typeof e === "object") {
      const item = String((e as { item?: unknown }).item ?? "").trim();
      const where = String((e as { where?: unknown }).where ?? "").trim();
      if (item) out.push({ item: item.slice(0, 300), where: (where || "where the work needs it").slice(0, 300) });
    }
  }
  return out.slice(0, 40);
}

/** The email section. Null when nothing is missing, so a card without a gap renders exactly as before. */
export function missingMaterialsSection(items: readonly MissingMaterial[], stage: "ASK" | "STILL"): { label: string; bullets: string[] } | null {
  if (items.length === 0) return null;
  return {
    label: stage === "ASK" ? "Missing materials — please send these" : "Still missing",
    bullets: [
      // Plain bullets: the email renderer bullets them, and strips a leading number anyway.
      ...items.map((m) => `${m.item} — for ${m.where}`),
      stage === "ASK" ? HOW_TO_SEND_MATERIALS : `These went out as marked placeholders. ${HOW_TO_SEND_MATERIALS}`,
    ],
  };
}

/** The same section as plain lines, for a prompt or a card's text. */
export function missingMaterialsText(items: readonly MissingMaterial[], stage: "ASK" | "STILL"): string {
  const s = missingMaterialsSection(items, stage);
  return s ? [`${s.label.toUpperCase()}:`, ...s.bullets].join("\n") : "";
}
