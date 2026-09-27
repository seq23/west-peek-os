import { INTAKE_MAILBOX } from "../intake/emailTriggers";
import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";

/**
 * The busy-executive email, laid out ONE way (16 Sep 2026).
 *
 * Operator: "strict rules for every email an employee sends a partner … busy-executive format,
 * enforced in code, not by hoping." Before this, each sender wrote its own prose: the reply to a
 * request was three paragraphs, the Productions note was a page of numbered entries, the Room
 * packet was the whole packet as text. A partner reading on a phone had to find the point.
 *
 * THE SHAPE, and it is not negotiable from a caller:
 *
 *   Subject      "<Employee>: <what it is>"                       ≤ 70 characters
 *   Line 1       **TL;DR:** one or two sentences — what was done and what, if anything, they decide
 *   Sections     **What you asked** / **What I did** / **What I found** / **Your call** (or the
 *                natural equivalent): bold label, bullets under it, never a paragraph, no section
 *                over six lines. Numbers are bolded automatically; names by the sender.
 *   — Details —  the full material, for those who want it, below a rule
 *   Footer       "— <Employee>, <role>. Replies go to os@joinwestpeek.com — we don't check
 *                individual inboxes."
 *
 * `renderExecEmail` produces plain text AND a light HTML part with the same content, and it
 * NORMALISES on the way (truncates the subject, caps a section at six lines and says where the
 * rest went, forces the TL;DR prefix, breaks a wall of prose in the details). `lintExecEmail`
 * then checks the result against the rules and returns every violation. The send path in
 * `services/execEmail.ts` refuses to send a message with violations, and the unit test renders
 * every kind of email an employee sends through here and asserts the lint is clean — so a new
 * sender cannot drift back to prose without a red test.
 */

export interface ExecEmailSection {
  /** "What you asked", "What I found", "Your call"… Rendered bold. */
  label: string;
  /** One line each; rendered as bullets. Over six and the rest are pointed at the details. */
  bullets: readonly string[];
}

export interface ExecEmailInput {
  /** Roster name of the employee sending it: "Wren", "Walker", "Parker". */
  employee: string;
  /** What it is, for the subject: "blog outline — AI in legal ops". */
  what: string;
  /** One or two sentences. The prefix is added here; do not write "TL;DR" yourself. */
  tldr: string;
  /**
   * THE REPLY OPTIONS, AS THE TL;DR (owner, 23 Sep 2026: the reply-options sentence "IS the TL;DR").
   * Short bullets rendered directly under the TL;DR line, before any section — so what she can
   * answer is the first thing she reads, never buried at the bottom. Omitted, nothing changes.
   */
  tldrBullets?: readonly string[];
  sections: readonly ExecEmailSection[];
  /** The full material, below the rule. Markdown-ish plain text; may be long. */
  details?: string | null;
  /**
   * WHO ROUTED THE WORK, when somebody else did (her rule, 22 Sep 2026): "Walker routed this to me;
   * the work is mine." A partner reading a finished piece of work should be able to see the whole
   * chain in one line — who handed it on, and who actually did it — without opening the card.
   *
   * IT RIDES ON THE FOOTER, which is already the line that says who did it, and is the only line
   * of an exec email that is prose rather than a label or a bullet. Putting it anywhere above the
   * details would fail `lintExecEmail`'s own rule that nothing up there is loose text — and that
   * rule is worth more than the placement. Omitted, the footer is byte-identical to before.
   */
  routedBy?: string | null;
}

export interface RenderedExecEmail {
  subject: string;
  text: string;
  html: string;
}

export const SUBJECT_MAX = 70;
export const SECTION_MAX_LINES = 6;
export const PROSE_RUN_MAX = 8;
export const DETAILS_RULE = "— Details —";

const BULLET = "•";

/** The employee's role, from the roster; a name that is not on it still signs, as an employee. */
function roleOf(name: string): string {
  return AI_EMPLOYEE_ROSTER.find((e) => e.name === name)?.role ?? "West Peek OS";
}

export function execFooter(employee: string, routedBy?: string | null): string {
  const routed = (routedBy ?? "").trim();
  const chain = routed && routed !== employee ? ` ${routed} routed this to me; the work is mine.` : "";
  return `— ${employee}, ${roleOf(employee)}.${chain} Replies go to ${INTAKE_MAILBOX} — we don't check individual inboxes.`;
}

/** One line: no newlines, collapsed whitespace. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Bold the numbers — counts, money, percentages, dates — in a bullet the sender did not already
 * bold. A partner scanning for "how many" and "how much" finds them without reading the line.
 */
// A clock time ("12:40 CT") is not a figure: neither side of the colon is bolded (23 Sep 2026).
export function boldNumbers(line: string): string {
  // Split on existing bold spans so a number already inside one is left alone.
  return line
    .split(/(\*\*[^*]+\*\*)/)
    .map((part) =>
      part.startsWith("**") ? part : part.replace(/(?<![\w*/.#:-])(?<!(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s)(\$?\d(?:[\d,]*\d)?(?:\.\d+)?(?:%|[kKmM]\b)?)(?!\d)(?!-\d)(?!:\d)(?![\w*/.-]*[A-Za-z/])/g, "**$1**"),
    )
    .join("");
}

export function execSubject(employee: string, what: string): string {
  const head = `${employee}: `;
  const room = SUBJECT_MAX - head.length;
  // THE PREFIX ONCE, WHATEVER THE TITLE CARRIES (27 Sep 2026). A card raised from a reply to one of
  // Porter's own emails had "Porter: …" in its subject, and the RECEIVED went out as "Porter: Porter:
  // Got it". A `what` that already starts with this employee's prefix is not prefixed again.
  let tail = oneLine(what);
  while (tail.startsWith(head)) tail = tail.slice(head.length).trimStart();
  return head + (tail.length <= room ? tail : `${tail.slice(0, Math.max(0, room - 1)).trimEnd()}…`);
}

/**
 * Keep the details readable in a plain-text client: any run of more than eight non-blank lines
 * with no bullet or label in it gets a blank line after the eighth, so the rule below holds by
 * construction and a hard-wrapped paragraph never arrives as a block.
 */
function breakProseRuns(text: string): string {
  const out: string[] = [];
  let run = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      run = 0;
      out.push("");
      continue;
    }
    if (isBulletOrLabel(line)) run = 0;
    else run += 1;
    out.push(line);
    if (run >= PROSE_RUN_MAX) {
      out.push("");
      run = 0;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function isBullet(line: string): boolean {
  return /^\s*(?:[•·\-*]|\d+[.)])\s+/.test(line);
}

export function isLabel(line: string): boolean {
  const t = line.trim();
  return /^\*\*[^*]+\*\*:?$/.test(t) || /^#{1,6}\s+\S/.test(t) || t === DETAILS_RULE || /^\*\*TL;DR:\*\*/.test(t);
}

export function isBulletOrLabel(line: string): boolean {
  return isBullet(line) || isLabel(line);
}

function normaliseSections(sections: readonly ExecEmailSection[]): ExecEmailSection[] {
  return sections
    .map((s) => ({
      label: oneLine(s.label).replace(/^\*+|\*+$/g, "").replace(/:$/, ""),
      bullets: s.bullets.map(oneLine).filter(Boolean).map((b) => boldNumbers(b.replace(/^(?:[•·\-*]|\d+[.)])\s+/, ""))),
    }))
    .filter((s) => s.label && s.bullets.length > 0)
    .map((s) => {
      if (s.bullets.length <= SECTION_MAX_LINES) return s;
      const shown = s.bullets.slice(0, SECTION_MAX_LINES - 1);
      return { ...s, bullets: [...shown, `… and **${s.bullets.length - shown.length}** more, under ${DETAILS_RULE.replace(/—/g, "").trim()} below.`] };
    });
}

// ── Text ─────────────────────────────────────────────────────────────────────

export function renderExecEmail(input: ExecEmailInput): RenderedExecEmail {
  const sections = normaliseSections(input.sections);
  const tldr = boldNumbers(oneLine(input.tldr).replace(/^\**\s*TL;DR:?\**\s*/i, ""));
  const details = input.details ? breakProseRuns(input.details) : "";
  const footer = execFooter(input.employee, input.routedBy);

  const tldrBullets = (input.tldrBullets ?? []).map((b) => oneLine(b)).filter(Boolean);
  const text = [
    `**TL;DR:** ${tldr}`,
    ...tldrBullets.map((b) => `${BULLET} ${b}`),
    "",
    ...sections.flatMap((s) => [`**${s.label}**`, ...s.bullets.map((b) => `${BULLET} ${b}`), ""]),
    ...(details ? [DETAILS_RULE, "", details, ""] : []),
    footer,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return {
    subject: execSubject(input.employee, input.what),
    text,
    html: renderHtml({ tldr, tldrBullets, sections, details, footer }),
  };
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escaped text with **bold** and bare URLs turned into markup. Nothing else is interpreted. */
export function inlineHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(https?:\/\/[^\s<)"']+)/g, (u) => `<a href="${u}" style="color:#1a1a1a">${u}</a>`);
}

/**
 * The details block, lightly structured: headings, bullets, paragraphs. Brand-neutral, dark on
 * light, no images — it is an email, not a page.
 */
function detailsHtml(details: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushList = () => {
    if (list.length) out.push(`<ul style="margin:0 0 12px 18px;padding:0">${list.map((l) => `<li style="margin:2px 0">${l}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushPara = () => {
    if (para.length) out.push(`<p style="margin:0 0 12px">${para.join("<br>")}</p>`);
    para = [];
  };
  for (const line of details.split("\n")) {
    const t = line.trim();
    if (t === "") {
      flushList();
      flushPara();
      continue;
    }
    const heading = t.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      flushPara();
      const level = Math.min(heading[1]!.length + 2, 5);
      out.push(`<h${level} style="margin:16px 0 6px;font-size:${level === 3 ? 16 : 14}px">${inlineHtml(heading[2]!)}</h${level}>`);
      continue;
    }
    if (isBullet(t)) {
      flushPara();
      list.push(inlineHtml(t.replace(/^(?:[•·\-*]|\d+[.)])\s+/, "")));
      continue;
    }
    if (/^\*\*[^*]+\*\*:?$/.test(t)) {
      flushList();
      flushPara();
      out.push(`<p style="margin:12px 0 4px"><strong>${escapeHtml(t.replace(/^\*\*|\*\*:?$/g, ""))}</strong></p>`);
      continue;
    }
    flushList();
    para.push(inlineHtml(t));
  }
  flushList();
  flushPara();
  return out.join("\n");
}

function renderHtml(parts: { tldr: string; tldrBullets: readonly string[]; sections: ExecEmailSection[]; details: string; footer: string }): string {
  const body = [
    `<p style="margin:0 0 ${parts.tldrBullets.length ? 4 : 16}px"><strong>TL;DR:</strong> ${inlineHtml(parts.tldr)}</p>`,
    ...(parts.tldrBullets.length ? [`<ul style="margin:0 0 16px 18px;padding:0">${parts.tldrBullets.map((b) => `<li style="margin:2px 0">${inlineHtml(b)}</li>`).join("")}</ul>`] : []),
    ...parts.sections.map(
      (s) =>
        `<p style="margin:14px 0 4px"><strong>${escapeHtml(s.label)}</strong></p>` +
        `<ul style="margin:0 0 0 18px;padding:0">${s.bullets.map((b) => `<li style="margin:2px 0">${inlineHtml(b)}</li>`).join("")}</ul>`,
    ),
    ...(parts.details
      ? [`<hr style="border:0;border-top:1px solid #d9d9d9;margin:20px 0">`, `<p style="margin:0 0 12px;color:#555;font-size:13px">${escapeHtml(DETAILS_RULE)}</p>`, detailsHtml(parts.details)]
      : []),
    `<hr style="border:0;border-top:1px solid #d9d9d9;margin:20px 0">`,
    `<p style="margin:0;color:#555;font-size:13px">${inlineHtml(parts.footer)}</p>`,
  ].join("\n");
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45;color:#1a1a1a;background:#ffffff;max-width:640px;padding:16px">` +
    body +
    `</div>`
  );
}

// ── The rules, checked ───────────────────────────────────────────────────────

/**
 * Every way a rendered email can break the format, in words. Empty means it conforms. Run on the
 * OUTPUT of `renderExecEmail` — and on anything else that claims to be one, which is how the
 * self-test proves the lint still bites.
 */
export function lintExecEmail(subject: string, text: string, employee?: string): string[] {
  const v: string[] = [];
  if (subject.length > SUBJECT_MAX) v.push(`subject is ${subject.length} characters; the limit is ${SUBJECT_MAX}`);
  if (!/^[A-Z][A-Za-z]+: \S/.test(subject)) v.push(`subject does not read "<Employee>: <what it is>": "${subject.slice(0, 40)}"`);
  if (employee && !subject.startsWith(`${employee}: `)) v.push(`subject does not start with "${employee}: "`);

  const lines = text.split("\n");
  const first = lines.find((l) => l.trim() !== "") ?? "";
  if (!/^\*{0,2}TL;DR:\*{0,2}\s+\S/.test(first.trim())) v.push("the first line is not a TL;DR");

  const ruleAt = lines.findIndex((l) => l.trim() === DETAILS_RULE);
  const top = ruleAt === -1 ? lines : lines.slice(0, ruleAt);
  const footerLine = lines.slice().reverse().find((l) => l.trim() !== "") ?? "";
  const topWithoutFooter = ruleAt === -1 ? top.filter((l) => l !== footerLine) : top;

  const labels = topWithoutFooter.filter((l) => /^\*\*[^*]+\*\*:?$/.test(l.trim()));
  if (labels.length < 2) v.push(`only ${labels.length} labelled section(s) above the details; the format has at least two (What you asked / What I did / What I found / Your call)`);

  // Above the rule: nothing but the TL;DR, labels, bullets and blank lines.
  for (const l of topWithoutFooter) {
    const t = l.trim();
    if (t === "" || /^\*{0,2}TL;DR:/.test(t) || isBulletOrLabel(t)) continue;
    v.push(`a line above the details is neither a label nor a bullet: "${t.slice(0, 60)}"`);
    break;
  }

  // No section over six lines.
  let section: string | null = null;
  let count = 0;
  for (const l of topWithoutFooter) {
    const t = l.trim();
    if (/^\*\*[^*]+\*\*:?$/.test(t)) {
      section = t;
      count = 0;
    } else if (t !== "" && section) {
      count += 1;
      if (count > SECTION_MAX_LINES) {
        v.push(`section ${section} runs past ${SECTION_MAX_LINES} lines`);
        section = null;
      }
    }
  }

  // No wall of prose anywhere.
  let run = 0;
  for (const l of lines) {
    const t = l.trim();
    if (t === "") { run = 0; continue; }
    run = isBulletOrLabel(t) ? 0 : run + 1;
    if (run > PROSE_RUN_MAX) {
      v.push(`a wall of prose: more than ${PROSE_RUN_MAX} consecutive lines without a bullet or label`);
      break;
    }
  }

  if (!footerLine.includes(INTAKE_MAILBOX) || !/^—\s*\S/.test(footerLine.trim())) v.push("the last line is not the employee's footer naming os@joinwestpeek.com");
  if (employee && !footerLine.includes(employee)) v.push(`the footer does not name ${employee}`);
  return v;
}

/**
 * Free text into bullets: one per sentence or line, for a finding an employee wrote as prose.
 * Used by the senders that carry a model's own words, so the summary is bullets even when the
 * source was a paragraph. The full text still goes under the details.
 */
export function bulletsFrom(text: string, max = 10): string[] {
  const pieces = text
    .split(/\n+/)
    .flatMap((l) => l.replace(/^(?:[•·\-*]|\d+[.)])\s+/, "").split(/(?<=[.!?])\s+(?=[A-Z"“(])/))
    .map(oneLine)
    .filter((p) => p.length > 1);
  return pieces.slice(0, max);
}
