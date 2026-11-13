/**
 * WHAT IS PRIVATE IN A PRIVATE DOCUMENT STAYS OUT OF THE PR (13 Nov 2026, issue #357).
 *
 * A partner's "keep this private" rides on the job as a standing constraint
 * (`src/shared/intake/privateMaterial.ts`). That constraint is an instruction to a model; this is
 * the check. After BUILD opens its PR, the script itself finds the private document(s) in the
 * package, reads them, and compares them with what the PR adds.
 *
 *   · WHICH DOCUMENTS. A file whose name says private or confidential, or whose name carries a
 *     word of the partner's sentence ("the plan doc is for us only" → the file named "…plan…").
 *   · A PASSAGE is PASSAGE_WORDS or more consecutive words of the document, compared with case,
 *     punctuation and markup removed.
 *   · WHAT FAILS THE BUILD (owner's ruling, 13 Nov 2026: what is private is the document's
 *     substance). A passage that carries a number, an amount, a percentage or a date; a name the
 *     document uses that the partner's public material does not; or anything from a section about
 *     finance, contracts, pay or targets.
 *   · WHAT IS RECORDED, NOT FAILED. Plain prose with none of those, on a job whose public material
 *     tells the builder to use the document as its source (the partner's README: "the source for
 *     the website"). It goes into the build's proof with the files and lines, so the partner can
 *     see what was taken. Without that instruction, plain prose fails too.
 *   · ZERO IS A FAILURE. A privacy rule with no document identified, none that could be read, or
 *     no diff proves nothing, so the build fails and says which.
 *
 * PURE: no network, no file reads. `web-property-change.mjs` supplies the names, texts and diff.
 * A failure never repeats the document's words. Safety, not wording: this check stays
 * (tests/privateMaterial.test.ts).
 */
export const PRIVATE_MARK = "PRIVATE MATERIAL";
export const PASSAGE_WORDS = 8;

/** The partner's sentence, out of the job's standing constraints; null when the job carries no privacy rule. */
export function privateSentenceIn(constraints) {
  for (const c of Array.isArray(constraints) ? constraints : []) {
    const text = String(c ?? "");
    if (!text.startsWith(PRIVATE_MARK)) continue;
    return /the partner wrote: "([\s\S]*?)"\. Use that material/.exec(text)?.[1] ?? text;
  }
  return null;
}

const words = (s) => String(s ?? "").toLowerCase().normalize("NFKD").match(/[a-z0-9]+/g) ?? [];
/** Words of a privacy sentence that name nothing: the instruction itself, and what every file is. */
const NOT_A_NAME = new Set(
  "private privately confidential copy copied forward forwarded share shared publish post please dont never only keep kept this that these those them they with from have into your yours ours mine anyone anybody everyone nobody else also just here there about full final draft version doc docs document documents file files folder folders sheet deck package drive link".split(" "),
);
const nameWords = (p) => words(String(p).split("/").pop());

/** The package files the privacy rule is about: named private/confidential, or named by a word of the sentence. */
export function privateDocsIn(paths, sentence) {
  const named = new Set(words(sentence).filter((w) => w.length >= 4 && !NOT_A_NAME.has(w)));
  return (Array.isArray(paths) ? paths : []).filter((p) => nameWords(p).some((w) => w === "private" || w === "confidential" || named.has(w)));
}

/** A .docx body (word/document.xml) or any marked-up text, as plain text, one paragraph per line. */
export function plainText(raw) {
  return String(raw ?? "")
    .replace(/<\/w:p>|<w:br\s*\/?>|<\/p>|<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

/** What a unified diff ADDS, as one text. */
export function addedText(diff) {
  return String(diff ?? "")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

/** Per file: every added word with the line of the new file it sits on. */
function addedWordsByFile(diff) {
  const out = [];
  for (const block of String(diff ?? "").split(/^diff --git /m).slice(1)) {
    const file = /^a\/(.+?) b\//.exec(block)?.[1] ?? "(unnamed)";
    const w = [];
    let line = 0;
    for (const l of block.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (hunk) line = Number(hunk[1]) - 1;
      else if (l.startsWith("+") && !l.startsWith("+++")) {
        line += 1;
        for (const t of words(plainText(l.slice(1)))) w.push({ t, line });
      } else if (!l.startsWith("-") && !l.startsWith("\\")) line += 1;
    }
    out.push({ file, w });
  }
  return out;
}

const SENSITIVE_SECTION = /\b(financ\w*|budget\w*|revenue|pricing|prices?|fees?|rates?|contracts?|contractors?|pay|payroll|compensation|salar\w+|invoic\w+|costs?|profit\w*|margin\w*|targets?|goals?|forecast\w*|projection\w*|kpis?|numbers|clients?|pipeline)\b/i;

/** The document as words, each with: its section heading, and whether it is a name the public material does not use. */
function readDoc(text, publicWords) {
  const out = [];
  let heading = "";
  const lower = new Set(String(text).match(/\b[a-z][a-z0-9]+\b/g) ?? []);
  for (const para of String(text).split("\n")) {
    const raw = para.match(/[A-Za-z0-9]+/g) ?? [];
    if (raw.length === 0) continue;
    // A heading: a short line that does not end a sentence.
    if (raw.length <= 8 && !/[.!?:;,]\s*$/.test(para.trim())) heading = para.trim();
    const sensitiveSection = SENSITIVE_SECTION.test(heading);
    raw.forEach((tok, i) => {
      const t = tok.toLowerCase().normalize("NFKD");
      // A NAME: capitalised mid-sentence, never written in lower case in the document, and not a word the public material uses.
      const name = i > 0 && /^[A-Z][a-z]+$/.test(tok) && !lower.has(t) && !publicWords.has(t);
      out.push({ t, digit: /\d/.test(tok), name, sensitiveSection });
    });
  }
  return out;
}

/** Does the partner's public material tell the builder to use this document as its source? */
export function namedAsSource(docPath, publicTexts) {
  const own = nameWords(docPath).filter((w) => w.length >= 4 && !NOT_A_NAME.has(w));
  for (const t of Array.isArray(publicTexts) ? publicTexts : []) {
    for (const s of String(t ?? "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)) {
      const sw = new Set(words(s));
      if (own.some((w) => sw.has(w)) && /\b(?:source|basis|based on|build from|built from|draw from|drawn from|start with|read the|use the)\b/i.test(s)) return true;
    }
  }
  return false;
}

/** Every passage of the document in what the PR adds: where it is in the repo, and whether it carries what is private. */
export function passagesIn(docText, diff, publicTexts = []) {
  const publicWords = new Set((Array.isArray(publicTexts) ? publicTexts : []).flatMap((t) => words(t)));
  const doc = readDoc(docText, publicWords);
  if (doc.length < PASSAGE_WORDS) return [];
  const at = new Map();
  for (let i = 0; i + PASSAGE_WORDS <= doc.length; i += 1) {
    const k = doc.slice(i, i + PASSAGE_WORDS).map((d) => d.t).join(" ");
    if (!at.has(k)) at.set(k, i);
  }
  const found = [];
  for (const { file, w } of addedWordsByFile(diff)) {
    let open = null;
    for (let i = 0; i + PASSAGE_WORDS <= w.length; i += 1) {
      const start = at.get(w.slice(i, i + PASSAGE_WORDS).map((x) => x.t).join(" "));
      if (start === undefined) {
        open = null;
        continue;
      }
      if (open && start === open.docEnd - PASSAGE_WORDS + 1) open.docEnd += 1;
      else {
        open = { file, line: w[i].line, docStart: start, docEnd: start + PASSAGE_WORDS };
        found.push(open);
      }
    }
  }
  return found.map((p) => {
    const span = doc.slice(p.docStart, p.docEnd);
    const why = span.some((d) => d.sensitiveSection) ? "from a finance, contract, pay or targets section" : span.some((d) => d.digit) ? "carries a number, amount or date" : span.some((d) => d.name) ? "carries a name from the document" : null;
    return { file: p.file, line: p.line, words: span.length, sensitive: why !== null, why };
  });
}

/**
 * THE VERDICT. `docs` = [{ path, text | null }] for the files `privateDocsIn` named (text null = unreadable);
 * `publicTexts` = the partner's request and the package's other documents.
 */
export function privateProof({ constraints, paths, docs, diff, publicTexts = [] }) {
  const sentence = privateSentenceIn(constraints);
  if (sentence === null) return { ok: true, checked: 0, line: null };
  const named = privateDocsIn(paths, sentence);
  if (named.length === 0) return { ok: false, checked: 0, reason: "the partner asked for a document to stay private, but no file in the package could be identified as that document (none is named private or confidential, and none carries a word of the partner's sentence), so nothing proves it stayed out of the PR" };
  const readable = (Array.isArray(docs) ? docs : []).filter((d) => named.includes(d.path) && typeof d.text === "string" && words(d.text).length >= PASSAGE_WORDS);
  if (readable.length === 0) return { ok: false, checked: 0, reason: `the private document (${named.join(", ")}) could not be read, so nothing proves it stayed out of the PR` };
  if (typeof diff !== "string") return { ok: false, checked: 0, reason: "the PR's diff could not be read, so nothing proves the private document stayed out of it" };
  const where = (ps) => {
    // Sources before built output: the line is fixed where it was written.
    const built = (f) => /^(?:dist|build|out)\//.test(f);
    const sorted = [...ps.filter((p) => !built(p.file)), ...ps.filter((p) => built(p.file))];
    return `${sorted.slice(0, 6).map((p) => `${p.file}:${p.line}`).join(", ")}${sorted.length > 6 ? `, and ${sorted.length - 6} more` : ""}`;
  };
  const used = [];
  for (const d of readable) {
    const passages = passagesIn(d.text, diff, publicTexts);
    const source = namedAsSource(d.path, publicTexts);
    const bad = passages.filter((p) => p.sensitive || !source);
    if (bad.length) {
      const whys = [...new Set(bad.map((p) => p.why ?? "the partner's material does not name this document as a source for the site"))];
      return { ok: false, checked: readable.length, files: [...new Set(bad.map((p) => p.file))], reason: `${bad.length} passage(s) of the private document "${d.path}" are in what this PR adds (${whys.join("; ")}), at ${where(bad)}. Take them out or say them without the document's words, figures and names, then rebuild; the partner asked that this document never be copied` };
    }
    used.push(...passages);
  }
  const line =
    `private-document check: ${readable.length} document(s) read; no figure, name or finance/contract/pay/targets passage in the PR's additions` +
    (used.length ? `. ${used.length} plain-prose passage(s) of the document are used as site copy, as the partner's material directs, at ${where(used)}` : "");
  return { ok: true, checked: readable.length, used: used.map((p) => ({ file: p.file, line: p.line, words: p.words })), line };
}
