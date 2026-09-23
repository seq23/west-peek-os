import type { Ask } from "./approvalReply";
import type { MissingMaterial } from "./missingMaterials";

/**
 * WHAT PORTER'S EMAILS SAY — ONE SCREEN, THE ANSWER FIRST (owner, 23 Sep 2026).
 *
 * Her words on the 12:42 plan email for the community site: "too long and i have no idea what he
 * wants from me. it says blocked and i have no idea how to unblock", and "this email makes me feel
 * like if i dont have the missing items i cannot continue … i should have the option to continue
 * without them and just get placeholders". Then: the reply options "ARE the TL;DR", and "just … a
 * preview link at every email back at every stopping point".
 *
 * So every notice a web property change sends is composed here, from data, by pure functions:
 *
 *   · THE TL;DR IS THE REPLY OPTIONS, as short bullets, first in the body. Nothing else repeats them.
 *   · NEVER "BLOCKED". A plan is "ready"; a preview is "ready"; a question is a question.
 *   · MISSING ITEMS ARE OPTIONAL. Placeholders stand in; she can add the real thing any time.
 *   · THE PLAN IS ON THE CARD, NOT IN THE EMAIL. One link.
 *   · THE LATEST PREVIEW RIDES ON EVERY EMAIL once one exists (`currentPreviewLine`), labelled with
 *     what it reflects; before the first build, the plan email says the preview comes next.
 *
 * `tests/porterNotices.test.ts` renders each notice and pins the shape, the words and the length.
 */

const CARD_URL = "https://os.joinwestpeek.com/#/work";
export const cardLinkFor = (cardId: string): string => `${CARD_URL} (card ${cardId})`;

/** The Mac's employee name, the prefix every subject carries. */
const EMPLOYEE_PREFIX = "Porter: ";
/** The exec-email subject cap (`SUBJECT_MAX` in shared/email/execEmail.ts). */
const SUBJECT_ROOM = 70 - EMPLOYEE_PREFIX.length;

/** Cut at a word boundary, never mid-word, with an ellipsis only when something was cut. Pure. */
export function shorten(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:.—-]+$/, "")}…`;
}

/** "12:40 CT" — the partners read Central time. Pure. */
export function builtAt(iso: string | null | undefined): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(iso));
  return `${t} CT`;
}

function listOf(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * THE SAME STRICT READING AS THE MAC'S `previewUrlsFrom` (scripts/duties/web-property-change.mjs),
 * applied to what is already on the row — so a preview_url stored before that fix (six URLs, HTML
 * fragments, other sites' previews) reaches her as one clean link. `tests/porterNotices.test.ts`
 * holds the two readers to the same answers on the same inputs. Pure.
 */
export function cleanPreviewUrls(raw: string | null | undefined, pagesHosts: readonly string[] = [], branch = ""): string | null {
  const found: string[] = [];
  for (const m of String(raw ?? "").matchAll(/https?:\/\/[^\s"'<>&|)\]`]+/gi)) {
    let u: URL;
    try {
      u = new URL(m[0].trim());
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    const isPages = host.endsWith(".pages.dev");
    const isWorkerVersion = /^[a-f0-9]{8}-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(host);
    if (!isPages && !isWorkerVersion) continue;
    if (isPages && !(pagesHosts.length === 0 ? host.split(".").length > 3 : pagesHosts.some((h) => host.endsWith(`.${h.toLowerCase()}`)))) continue;
    found.push(`${u.protocol}//${host}`);
  }
  const unique = [...new Set(found)];
  if (unique.length === 0) return null;
  const alias = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "");
  if (alias && pagesHosts.length > 0) {
    const links = pagesHosts.map((h) => h.toLowerCase()).filter((h) => unique.some((u) => new URL(u).hostname.endsWith(`.${h}`))).map((h) => `https://${alias}.${h}`);
    if (links.length) return links.join(" · ");
  }
  const byProject = new Map<string, string>();
  for (const u of unique) {
    const host = new URL(u).hostname;
    const project = host.split(".").slice(1).join(".");
    if (!byProject.has(project) || (alias.length > 0 && host.split(".")[0] === alias)) byProject.set(project, u);
  }
  return [...byProject.values()].join(" · ");
}

const NO_PREVIEW = "no preview deployment for this site — the change and its screenshots are on the card";

export interface PreviewState {
  preview_url: string | null;
  pr_url: string | null;
  check_state: string | null;
  check_green_at: string | null;
  placeholders_json: string | null;
}

/**
 * THE LINE EVERY EMAIL CARRIES ONCE A PREVIEW EXISTS: "Current preview (built 12:40 CT, 2
 * placeholders): <link>". Null before the first green build — then the plan email says the preview
 * comes next instead. A repo with no preview deployment names the PR, which stands in for it. Pure.
 */
export function currentPreviewLine(row: PreviewState | null | undefined, parts: ReadonlyArray<{ repo: string; preview_url: string | null; pr_url: string | null; pagesHosts?: readonly string[]; branch?: string | null }> = [], clean: { pagesHosts?: readonly string[]; branch?: string | null } = {}): string | null {
  if (!row || row.check_state !== "GREEN" || !row.check_green_at) return null;
  const n = listOf(row.placeholders_json).length;
  const label = `Current preview (built ${builtAt(row.check_green_at) ?? "earlier"}, ${n} placeholder${n === 1 ? "" : "s"})`;
  if (parts.length) {
    const links = parts.map((p) => `${p.repo}: ${cleanPreviewUrls(p.preview_url, p.pagesHosts ?? [], p.branch ?? "") ?? NO_PREVIEW}`).join(" · ");
    return `${label}: ${links}`;
  }
  // NO PR LINK IN HER INBOX (owner, 23 Sep 2026): a repo with no preview deployment says so; the
  // PR and its screenshots are on the card.
  const link = cleanPreviewUrls(row.preview_url, clean.pagesHosts ?? [], clean.branch ?? "") ?? (row.pr_url ? NO_PREVIEW : null);
  return link ? `${label}: ${link}` : null;
}

/** The button's words, exactly (owner, 23 Sep 2026), and what pressing it says back. */
export const MATERIALS_ADDED_PHRASE = "I added missing items";

export const FIRST_PREVIEW_NEXT = "The first preview comes right after you approve the plan.";

export interface NoticeEmail {
  what: string;
  tldr: string;
  tldrBullets: string[];
  sections: Array<{ label: string; bullets: string[] }>;
}

/** The four ways to answer a PLAN, first in the email. */
export function planReplyForms(askCount: number): string[] {
  const recs = askCount === 0 ? "the plan as written" : `my ${askCount} recommendation${askCount === 1 ? "" : "s"}`;
  return [
    `**approved**: take ${recs} and build the preview`,
    `**approved to production**: skip the preview and land on green`,
    `**changes: …**: hold it and tell me what to change`,
    `anything else: read as your answers to the decisions below`,
  ];
}

/** The four ways to answer a PREVIEW (owner's words, 23 Sep 2026), first in the email. */
export const PREVIEW_REPLY_FORMS: readonly string[] = [
  `**approved**: publish this preview as is (placeholders included).`,
  `**changes: …**: I'll make them and send you a new preview.`,
  `**Missing items + "publish"**: attach them or add them to Drive, reply "publish", and I'll fill them in and publish without another preview.`,
  `**Missing items + "preview"**: attach them or add them to Drive, reply "preview", and I'll fill them in and send you another preview.`,
];

const MAX_LINES = 6;

/**
 * THE STAGE, IN PLAIN WORDS, IN THE SUBJECT AND THE FIRST LINE (owner, 23 Sep 2026: "the word
 * 'blocked' should only be used when he is blocked by something … the next email should have said
 * 'preview done'"). One word-set per notice kind; "Blocked" belongs to STUCK alone.
 */
export const STAGE = {
  RECEIVED: "Got it",
  PLAN: "Plan ready",
  PREVIEW: "Preview ready",
  REBUILD: "New preview ready",
  QUESTION: "A question for you",
  STUCK: "Blocked",
  DONE: "Live",
  UNCHANGED: "Nothing new found",
} as const;

/** "<plain title>: <stage>" — the title cut at a word if it must be, the stage never. Pure. */
export function stageSubject(title: string, stage: string): string {
  const room = SUBJECT_ROOM - stage.length - 2;
  return `${shorten(title, Math.max(12, room))}: ${stage}`;
}

/**
 * EVERY ITEM, ONE LINE EACH, NEVER "…AND 5 MORE" (owner, 23 Sep 2026). The exec-email format caps a
 * section at six lines, so a longer list continues in a second section of the same name. Pure.
 */
export function listSections(label: string, items: readonly string[], tail: readonly string[] = [], maxLen = 90): NoticeEmail["sections"] {
  const lines = [...items.map((x) => shorten(x, maxLen)), ...tail];
  const out: NoticeEmail["sections"] = [];
  for (let i = 0; i < lines.length; i += MAX_LINES) out.push({ label: i === 0 ? label : `${label}, continued`, bullets: lines.slice(i, i + MAX_LINES) });
  return out;
}

const ON_THE_CARD = (cardId: string) => ({ label: "The card", bullets: [`Everything about this change is on the card: ${cardLinkFor(cardId)}`] });
const STILL_MISSING = "Still missing (optional)";

/** THE PLAN EMAIL. Pure. */
export function planNotice(input: { title: string; asks: readonly Ask[]; missing: readonly MissingMaterial[]; previewLine: string | null; cardId: string; sites?: readonly string[] }): NoticeEmail {
  const n = input.asks.length;
  const m = input.missing.length;
  const sections: NoticeEmail["sections"] = [];
  // A job over several sites says so once: one plan, one preview each, landing together (0236).
  if ((input.sites?.length ?? 0) > 1) sections.push({ label: `${input.sites!.length} sites, one job`, bullets: [`${input.sites!.join(", ")}: one plan, a preview of each, and they go live together.`] });
  if (n) sections.push(...listSections(`${n} decision${n === 1 ? "" : "s"} (my recommendation in bold)`, input.asks.map((a) => `${shorten(a.question, 100)} → **${shorten(a.recommended, 70)}**`), [], 200));
  if (m) sections.push(...listSections("Missing items (optional)", input.missing.map((x) => x.item), ["You don't need these to continue. I'll use placeholders; add them to Drive or attach them to any reply and I'll rebuild."]));
  sections.push({ label: "Preview", bullets: [input.previewLine ?? FIRST_PREVIEW_NEXT] });
  sections.push({ label: "The full plan", bullets: [`The full plan is on the card: ${cardLinkFor(input.cardId)}`] });
  return {
    what: stageSubject(input.title, STAGE.PLAN),
    tldr: `Plan ready. Reply **approved** and I'll build the preview now${m ? `, with placeholders for the ${m} missing item${m === 1 ? "" : "s"}` : ""}. Nothing goes live until you approve the preview.`,
    tldrBullets: planReplyForms(n),
    sections,
  };
}

/**
 * DECIDED SO FAR — every plan decision in one line, what was chosen and how (owner, 23 Sep 2026:
 * "whoever holds the card can see what they signed off"). "Orange: #c45a3c (recommended; approved by
 * Sequoia)" when her "approved" took the recommendation; her own words when she answered. Pure.
 */
export function decidedSoFar(asks: readonly Ask[], answers: readonly string[], approvedBy: string | null): string[] {
  const who = approvedBy ?? "the partner";
  const approved = new Set<number>();
  const solved = new Map<number, { chosen: string; how: string }>();
  const own: string[] = [];
  for (const a of answers) {
    const m = /^(\d+)\.\s+(.*?)\s+\((approved as recommended|solved: (.*))\)$/.exec(a);
    if (m && m[3] === "approved as recommended") approved.add(Number(m[1]) - 1);
    else if (m) solved.set(Number(m[1]) - 1, { chosen: m[2]!, how: m[4]! });
    else if (a !== "approved as written") own.push(a);
  }
  return asks.map((a, i) => {
    const topic = shorten(a.question.split(/[:?]/)[0]!.trim() || a.question, 40);
    const s = solved.get(i);
    if (s) return `${topic}: ${shorten(s.chosen, 60)}. Solved: ${shorten(s.how, 80)}`;
    if (approved.has(i)) return `${topic}: ${shorten(a.recommended, 60)} (recommended; approved by ${who})`;
    if (own.length) return `${topic}: as ${who} answered — "${shorten(own.join(" / "), 60)}"`;
    return `${topic}: ${shorten(a.recommended, 60)} (recommended; not yet approved)`;
  });
}

/**
 * "decision 6: Maax self-hosted everywhere — the licence covers web use" — a partner settling ONE
 * decision after the fact (23 Sep 2026: the fonts question, answered once she checked the licence).
 * Read from the requesting partner's reply; recorded as that decision's answer; never a rebuild. Pure.
 */
export function decisionResolutionIn(text: string | null | undefined): { n: number; chosen: string; why: string | null } | null {
  const first = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const m = /^decision\s+(\d+)\s*[:\-—–]\s*(.+)$/i.exec(first);
  if (!m) return null;
  const [chosen, ...rest] = m[2]!.split(/\s+[—–]\s+|\s+--\s+/);
  return { n: Number(m[1]), chosen: chosen!.trim().replace(/[.]+$/, ""), why: rest.join(" — ").trim() || null };
}

/** THE PREVIEW EMAIL — the first one, or a new one after a rebuild. Pure. */
export function previewNotice(input: { title: string; previewLine: string | null; placeholders: readonly string[]; filled?: readonly string[]; round?: number; cardId: string; sites?: readonly string[]; decided?: readonly string[] }): NoticeEmail {
  const p = input.placeholders.length;
  const again = (input.round ?? 1) > 1;
  const sections: NoticeEmail["sections"] = [{ label: (input.sites?.length ?? 0) > 1 ? `Preview of ${input.sites!.length} sites — they go live together` : "Preview", bullets: [input.previewLine ?? "The preview link did not come back; it is on the card."] }];
  if (input.filled?.length) sections.push(...listSections(again ? "Filled in since the last preview" : "Filled in since the plan", input.filled));
  if (p) sections.push(...listSections(STILL_MISSING, input.placeholders));
  if (input.decided?.length) sections.push(...listSections("Decided so far", input.decided, [], 140));
  sections.push(ON_THE_CARD(input.cardId));
  const stage = again ? STAGE.REBUILD : STAGE.PREVIEW;
  return {
    what: stageSubject(input.title, stage),
    tldr: `${stage}${p ? `, with ${p} placeholder${p === 1 ? "" : "s"}` : ""}. Reply with one of these:`,
    tldrBullets: [...PREVIEW_REPLY_FORMS],
    sections,
  };
}

/** A QUESTION ONLY SHE CAN ANSWER — never called "blocked". Pure. */
export function questionNotice(input: { title: string; question: readonly string[]; previewLine: string | null; missing: readonly string[]; cardId: string }): NoticeEmail {
  const sections: NoticeEmail["sections"] = [...listSections("The question", input.question.length ? input.question : ["The question is on the card."], [], 400)];
  if (input.previewLine) sections.push({ label: "Current preview", bullets: [input.previewLine] });
  if (input.missing.length) sections.push(...listSections(STILL_MISSING, input.missing));
  sections.push(ON_THE_CARD(input.cardId));
  return { what: stageSubject(input.title, STAGE.QUESTION), tldr: `${STAGE.QUESTION}: reply to this email with your answer and I carry on.`, tldrBullets: [], sections };
}

/** STUCK — the one notice that says "Blocked", and says by what, in one line. Pure. */
export function stuckNotice(input: { title: string; blockedBy: string; next: string; previewLine: string | null; cardId: string }): NoticeEmail {
  const sections: NoticeEmail["sections"] = [{ label: "What happens next", bullets: [shorten(input.next, 200)] }];
  if (input.previewLine) sections.push({ label: "Current preview", bullets: [input.previewLine] });
  sections.push(ON_THE_CARD(input.cardId));
  return { what: stageSubject(input.title, STAGE.STUCK), tldr: `Blocked: ${shorten(input.blockedBy, 200)}`, tldrBullets: [], sections };
}

/** DONE — it is live; where, and anything still missing. Proof stays on the card. Pure. */
export function doneNotice(input: { title: string; liveUrls: readonly string[]; forced?: string | null; missing: readonly string[]; previewLine?: string | null; cardId: string }): NoticeEmail {
  const sections: NoticeEmail["sections"] = [...listSections("Live now", input.liveUrls.length ? input.liveUrls : ["Merged and deployed; the live check is on the card."])];
  if (input.previewLine) sections.push({ label: "Last preview", bullets: [input.previewLine] });
  if (input.forced) sections.push({ label: "Published with placeholders", bullets: [input.forced] });
  if (input.missing.length) sections.push(...listSections(STILL_MISSING, input.missing, ["Add them to Drive or attach them to a reply any time and I'll fill them in."]));
  sections.push(ON_THE_CARD(input.cardId));
  return { what: stageSubject(input.title, STAGE.DONE), tldr: `${STAGE.DONE}: your change is published.`, tldrBullets: [], sections };
}

/** The live URLs a LAND's curl proof names, in order, deduped. Pure. */
export function liveUrlsFrom(proof: string | null | undefined): string[] {
  return [...new Set((String(proof ?? "").match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).map((u) => u.replace(/[.,;:]+$/, "")))].slice(0, 6);
}

/** Words in a rendered notice, not counting the decisions list (which she scans, not reads). Pure. */
export function noticeWords(email: NoticeEmail): number {
  const text = [email.tldr, ...email.tldrBullets, ...email.sections.filter((s) => !/decision/.test(s.label)).flatMap((s) => [s.label, ...s.bullets])].join(" ");
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}
