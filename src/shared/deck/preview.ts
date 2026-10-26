import { ALL_BINDINGS, type Binding, type Slide, type Slot, type TableCell } from "./definition";
import { DECK_CSS, PAGE } from "./render";

/**
 * THE DECK PREVIEW — the partners' review page, and the rules a preview's slides must keep.
 *
 * Owner, 26 Oct 2026: stop producing a PDF per change. Preston builds a preview (every slide as a
 * page, a short "what changed" note at the top), ONE email per round goes to both partners, they
 * reply in plain words, he applies it to the SAME preview and says what changed on the thread, and
 * "approved" from either partner is what makes the final PDF.
 *
 * Pure: the Worker (services/deckPreview.ts) reads the rows and the pictures and calls this.
 */

export const PREVIEW_PATH = "/api/deck/preview";
export const PREVIEW_URL = `https://os.joinwestpeek.com${PREVIEW_PATH}`;

/**
 * IS THIS REPLY AN APPROVAL? Only when the partner's first words say so — "approved", "Approved!",
 * "approve it", "looks good, approved". A reply that merely contains the word ("not approved yet",
 * "once page 4 is fixed it's approved") is a change request, because a final PDF made by mistake is
 * an LP document nobody meant to finish.
 */
export function isApproval(written: string): boolean {
  const first = written.trim().split(/\n/)[0]!.trim().toLowerCase().replace(/[!.\s]+$/, "");
  if (/\b(not|n't|once|when|after|until|unless|if|but)\b/.test(first)) return false;
  return /^(?:(?:yes|ok|okay|great|perfect|looks good|looks great|all good)[,.!\s-]*)?(?:it'?s\s+|this is\s+)?(?:approved?|approve it|approve this)(?:\s+(?:it|this|the deck|from me))?$/.test(first);
}

/** The guard on a slide set before it is saved: real bindings, known pictures, nothing empty. */
export function checkSlides(slides: unknown, knownAssets: ReadonlySet<string>): { ok: true; slides: Slide[] } | { ok: false; why: string } {
  if (!Array.isArray(slides) || slides.length === 0) return { ok: false, why: "there are no slides" };
  const bindOk = (b: unknown): b is Binding => typeof b === "string" && (ALL_BINDINGS as readonly string[]).includes(b);
  const assetOk = (a: unknown) => typeof a === "string" && knownAssets.has(a);
  const cellOk = (c: TableCell | unknown): boolean =>
    typeof c === "string" || (!!c && typeof c === "object" && (("bind" in (c as object) && bindOk((c as { bind: unknown }).bind)) || ("asset" in (c as object) && assetOk((c as { asset: unknown }).asset))));
  const slotOk = (s: Slot): string | null => {
    switch (s?.kind) {
      case "text": case "heading": return typeof s.text === "string" && s.text.trim() ? null : "an empty line";
      case "figure": case "derivation": return bindOk(s.bind) ? null : `a figure bound to "${String(s.bind)}", which is not a fund record`;
      case "image": return assetOk(s.asset) ? null : `a picture "${String(s.asset)}" that is not in the deck's pictures`;
      case "images": return Array.isArray(s.items) && s.items.every((i) => assetOk(i.asset)) ? null : "a row of pictures naming one that does not exist";
      case "quote": return typeof s.text === "string" && s.text.trim() ? null : "an empty quote";
      case "table": return Array.isArray(s.rows) && s.rows.every((r) => Array.isArray(r) && r.every(cellOk)) ? null : "a table with a cell that is not text, a fund record or a known picture";
      case "person": return typeof s.name === "string" && Array.isArray(s.points) && (!s.photo || assetOk(s.photo)) && (s.logos ?? []).every(assetOk) ? null : "a person with an unknown photo or logo";
      default: return `a block of unknown kind "${String((s as { kind?: unknown })?.kind)}"`;
    }
  };
  for (const [i, slide] of (slides as Slide[]).entries()) {
    if (!slide || typeof slide.headline !== "string" || !slide.headline.trim()) return { ok: false, why: `slide ${i + 1} has no headline` };
    if (!Array.isArray(slide.slots)) return { ok: false, why: `slide ${i + 1} has no blocks` };
    for (const s of [...slide.slots, ...(slide.right ?? [])]) {
      const bad = slotOk(s);
      if (bad) return { ok: false, why: `slide ${i + 1} has ${bad}` };
    }
    if (slide.aside?.asset && !assetOk(slide.aside.asset)) return { ok: false, why: `slide ${i + 1} names a picture that does not exist` };
  }
  return { ok: true, slides: slides as Slide[] };
}

/**
 * Money and percentages typed as prose. A preview edit may not ADD one the partner did not say:
 * every fund figure is a record, and the old wrong ones ($23M, 8% ownership, $250–750K checks)
 * came back exactly this way — a model copying an earlier deck.
 */
export function typedFigures(slides: readonly Slide[]): string[] {
  const out: string[] = [];
  const scan = (t: string | undefined) => {
    if (!t) return;
    out.push(...(t.match(/\$\s?\d[\d,.]*\s?(?:M|K|B|million|billion)?/gi) ?? []), ...(t.match(/\b\d+(?:\.\d+)?\s?%/g) ?? []));
  };
  for (const s of slides) {
    scan(s.headline); scan(s.standfirst); scan(s.aside?.text);
    for (const slot of [...s.slots, ...(s.right ?? [])]) {
      if ("text" in slot) scan(slot.text);
      if (slot.kind === "table") for (const r of slot.rows) for (const c of r) if (typeof c === "string") scan(c);
      if (slot.kind === "person") slot.points.forEach(scan);
      if (slot.kind === "images") slot.items.forEach((i) => scan(i.caption));
    }
  }
  return out.map((x) => x.replace(/\s+/g, ""));
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface PreviewPageInput {
  roundNo: number;
  state: "OPEN" | "APPROVED" | "FINAL" | "SUPERSEDED";
  hold: boolean;
  sentAt: string | null;
  whatChanged: readonly string[];
  kept: string | null;
  pages: readonly string[];
  /** Newest last: what each partner asked and what was done. */
  history: ReadonlyArray<{ when: string; who: string | null; said: string | null; applied: string | null; state: string }>;
  finalLink: string | null;
}

/**
 * The page. Phone first: what this is and what to do sit at the top, then the note on what changed,
 * then every page of the deck, scaled to the screen. One button, and only while the preview is held:
 * it says what it does in plain words and asks once before it emails anybody.
 */
export function renderPreviewPage(input: PreviewPageInput): string {
  const status =
    input.state === "FINAL"
      ? `Approved. The final PDF is made${input.finalLink ? ` — <a href="${esc(input.finalLink)}">open it on Fund strategy</a>` : ""}.`
      : input.state === "APPROVED"
        ? "Approved. Preston is making the final PDF now."
        : input.state === "SUPERSEDED"
          ? "This round was closed without a final PDF."
          : input.hold
            ? "Not emailed yet. Sequoia is looking at it first."
            : input.sentAt
              ? `Emailed to Scooter and Sequoia on ${esc(input.sentAt.slice(0, 10))}. Reply to that email with any change, or with “approved”.`
              : "Being emailed to Scooter and Sequoia.";
  const release =
    input.state === "OPEN" && input.hold
      ? `<form method="post" action="${PREVIEW_PATH}/release" onsubmit="return confirm('This emails the preview link to Scooter and Sequoia. Send it now?')">
           <button type="submit">Email this preview to Scooter and Sequoia</button>
           <p class="hint">Nothing is sent until you tap this. After that, either of you replies to the email with changes, or with “approved”.</p>
         </form>`
      : "";
  const history = input.history.length
    ? `<details class="history"><summary>Show every change asked for so far (${input.history.length}) ▾</summary><ol>${input.history
        .map((h) => `<li><span class="when">${esc(h.when.slice(0, 16).replace("T", " "))}</span>${h.who ? ` · ${esc(h.who)}` : ""}${h.said ? `<br><q>${esc(h.said.slice(0, 400))}</q>` : ""}${h.applied ? `<br>${esc(h.applied)}` : ""}${h.state === "PENDING" ? "<br><i>Preston is working on this.</i>" : ""}</li>`)
        .join("")}</ol></details>`
    : "";
  const frames = input.pages
    .map((p, i) => `<figure class="frame-wrap"><div class="frame-box">${p}</div><figcaption>Page ${i + 1} of ${input.pages.length}</figcaption></figure>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fund I deck preview</title>
<meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap">
<style>
  :root{--bg:#ECEAE4;--card:#FFFFFF;--fg:#141311;--muted:#5F5C56;--line:#D3CEC4;--accent:#384653}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "Public Sans",-apple-system,BlinkMacSystemFont,sans-serif}
  .wrap{max-width:1000px;margin:0 auto;padding:16px 16px 48px;display:grid;gap:18px}
  a{color:var(--accent)}
  .back{font-size:15px}
  h1.page-title{font-size:24px;line-height:1.25;margin:4px 0 0}
  .status{margin:6px 0 0;color:var(--muted)}
  .note{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:14px 16px}
  .note b{display:block;margin-bottom:6px}
  .note ul{margin:0;padding-left:20px;display:grid;gap:4px}
  .note p{margin:8px 0 0;color:var(--muted)}
  form{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
  button{font:600 16px "Public Sans",sans-serif;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px 16px;width:100%;cursor:pointer}
  .hint{margin:8px 0 0;color:var(--muted);font-size:14px}
  .history{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px}
  .history summary{cursor:pointer;font-weight:600}
  .history li{margin:8px 0}
  .when{color:var(--muted);font-size:14px}
  figure.frame-wrap{margin:0;display:grid;gap:6px}
  .frame-box{width:100%;aspect-ratio:${PAGE.w}/${PAGE.h};overflow:hidden;position:relative;border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,.12);background:#F7F5EF}
  .frame-box > .slide{position:absolute;top:0;left:0;transform-origin:0 0}
  figcaption{font-size:13px;color:var(--muted);text-align:center}
${DECK_CSS}
</style></head>
<body>
<div class="wrap">
  <a class="back" href="/">← Back to West Peek OS</a>
  <header>
    <h1 class="page-title">Fund I deck — preview, round ${input.roundNo}</h1>
    <p class="status">${status}</p>
  </header>
  <section class="note">
    <b>What changed in this preview</b>
    <ul>${input.whatChanged.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
    ${input.kept ? `<p>Kept from earlier decks: ${esc(input.kept)}</p>` : ""}
  </section>
  ${release}
  ${history}
  ${frames}
</div>
<script>
  // Each page is drawn at its real size (${PAGE.w}×${PAGE.h}) and scaled to the screen, so the phone
  // shows exactly what the PDF will print.
  function fit(){for(const box of document.querySelectorAll(".frame-box")){const s=box.firstElementChild;if(s)s.style.transform="scale("+(box.clientWidth/${PAGE.w})+")";}}
  addEventListener("resize",fit);fit();
</script>
</body></html>`;
}
