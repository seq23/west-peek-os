/**
 * EVERY WYNN DRAFT EMAIL TO THE PARTNERS, ONE SHAPE (owner, 7 Nov 2026, on the Pinecone Pricing Reply v2 mock-up: "go
 * this is perfect! all emails from wynn should be like this").
 *
 *   Subject   "<Brand> <Document> · vN · ready for your OK · <ref>"; vN counts up per redraft and is stored on the reply.
 *   Line 1    the version, what it is and what to reply.
 *   Changes   "What changed since v(N-1)": one line per note, naming whose note and what was done. A note with no line
 *             holds the email (services/tlcBrandReply.ts, `unansweredNotes`), so a redraft that ignored a note can
 *             never reach her looking finished.
 *   Reply     the brand email word for word, with who it goes to.
 *   Sheet     the pricing sheet inline, as HTML (the PDF is made only from the approved version, when it goes).
 *   Link      one: "See the whole <Brand> story ›", a readable page (never an /api/ address).
 *   Ref       small print at the bottom, so her reply carries it back. No "we don't check individual inboxes" footer
 *             and no markdown in the plain-text part.
 * PURE: the worker gathers the facts and sends.
 */
export interface ChangeLine {
  /** Whose note it answers ("Scooter", "Sequoia"), or null for a change Wynn made himself. */
  who: string | null;
  /** Their words, short (a quote or the gist). */
  note: string | null;
  /** What was done about it. */
  done: string;
}
export interface SheetMini {
  title: string;
  line: string;
  headers: readonly string[];
  rows: ReadonlyArray<{ label: string; cells: readonly string[] }>;
  foot: string | null;
}
export interface WynnDraftEmailInput {
  brand: string;
  /** "Pricing Reply", "Reply", "Materials Reply", "Call Reply", "Agreement". */
  docName: string;
  version: number;
  /** Line 1, after the version: what it is and what to reply. */
  lead: string;
  /** What the brand wrote, quoted under line 1 (round 1: her first look at their message). */
  quote?: { label: string; text: string } | null;
  /** The lines for "What changed since v(N-1)"; null on a first version. */
  changes: readonly ChangeLine[] | null;
  /** Said instead of change lines when the words did not change (a draft she approved, now with Scooter too). */
  unchangedNote?: string | null;
  reply: { to: string; cc: readonly string[]; subject: string; body: string };
  sheet: SheetMini | null;
  /** Other things that go with this draft (the samples page, Wynn's research, a calendar note), one line each. */
  extras?: ReadonlyArray<{ label: string; text: string; url?: string | null; top?: boolean }>;
  /** What goes with the email when it is sent ("the partner-levels sheet as a PDF"). */
  attachmentsWord?: string | null;
  link: { label: string; url: string };
  ref: string;
  /** The thread's ref, carried in the subject for every version (the first email's); defaults to `ref`. */
  threadRef?: string | null;
  replyHint: string;
  /** Both partners must reply "approved" (the pricing round): the subject starts "ACTION REQUIRED: ". */
  bothMustApprove?: boolean;
}
export interface RenderedDraftEmail { subject: string; text: string; html: string }

/** The ref rides in the subject too (owner, 7 Nov 2026: "that code is still important"), so her reply always carries it back. */
/**
 * The ref rides in the subject too (owner, 7 Nov 2026: "that code is still important"), so her reply always carries it
 * back. A draft BOTH partners must approve starts "ACTION REQUIRED: " (her words: "IF WE BOTH NEED TO APPROVE SO SCOOTER
 * KNOWS HE NEEDS TO DO SOMETHING"); the round-1 email to her alone never does.
 */
export const ACTION_REQUIRED = "ACTION REQUIRED: ";
export const docSubject = (brand: string, docName: string, version: number, ref: string, both = false): string => `${both ? ACTION_REQUIRED : ""}${brand} ${docName} · v${version} · ready for your OK · ${ref}`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const changeText = (c: ChangeLine): string => `${c.who ? `${c.who}: ` : ""}${c.note ? `"${c.note}" → ` : ""}${c.done}`;
const recipientsLine = (r: WynnDraftEmailInput["reply"]): string => `To: ${r.to}${r.cc.length ? ` · Cc: ${r.cc.join(", ")}` : ""}`;

export function renderWynnDraftEmail(i: WynnDraftEmailInput): RenderedDraftEmail {
  const thread = i.threadRef ?? i.ref;
  const subject = docSubject(i.brand, i.docName, i.version, thread, i.bothMustApprove === true);
  const refLine = thread === i.ref ? `Ref ${i.ref}` : `Ref ${i.ref} · thread ${thread}`;
  const changesHead = `What changed since v${i.version - 1}`;
  const showChanges = i.version > 1 || (i.changes?.length ?? 0) > 0 || Boolean(i.unchangedNote);
  // An extra marked `top` (Wynn's research report) is read before the reply; the rest after the sheet.
  const top = (i.extras ?? []).filter((x) => x.top);
  const extras = (i.extras ?? []).filter((x) => !x.top);
  const text = [
    `V${i.version} · ${i.lead}`,
    "",
    ...(i.quote ? [`${i.quote.label}:`, i.quote.text.trim(), ""] : []),
    ...top.flatMap((x) => [`${x.label.toUpperCase()}`, x.text, ...(x.url ? [x.url] : []), ""]),
    ...(showChanges ? [changesHead.toUpperCase(), ...(i.changes?.length ? i.changes.map((c) => `- ${changeText(c)}`) : [`- ${i.unchangedNote ?? "Nothing in the words changed."}`]), ""] : []),
    "THE REPLY, WORD FOR WORD",
    recipientsLine(i.reply),
    i.reply.subject,
    "",
    i.reply.body.trim(),
    "",
    ...(i.sheet
      ? [
        `THE SHEET THEY GET${i.attachmentsWord ? ` (${i.attachmentsWord})` : ""}`,
        i.sheet.title,
        i.sheet.line,
        `${i.sheet.headers[0]}: ${i.sheet.headers.slice(1).join(" / ")}`,
        ...i.sheet.rows.map((r) => `- ${r.label}: ${r.cells.join(" / ")}`),
        ...(i.sheet.foot ? [i.sheet.foot] : []),
        "",
      ]
      : []),
    ...extras.flatMap((x) => [x.url ? `${x.label}: ${x.url}\n${x.text}` : `${x.label}: ${x.text}`, ""]),
    `${i.link.label}:`,
    i.link.url,
    "",
    `${i.replyHint} ${refLine}`,
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  const h4 = (t: string) => `<p style="margin:20px 0 6px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6b655d;font-weight:600">${esc(t)}</p>`;
  const para = (t: string) => esc(t).replace(/\n/g, "<br>");
  const sheetHtml = i.sheet
    ? `${h4(`The sheet they get${i.attachmentsWord ? ` (${i.attachmentsWord})` : ""}`)}
<div style="border:1px solid #ddd;border-radius:8px;overflow:hidden">
<div style="background:#111;color:#fff;padding:10px 12px;font-size:13px"><b style="color:#F05A1A">WP</b>&nbsp; West Peek Rooms · The Learning Club<br><span style="font-size:15px;font-weight:600">${esc(i.sheet.title)}</span></div>
<div style="padding:10px 12px;font-size:13px">
<p style="margin:0 0 8px">${esc(i.sheet.line)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px">
<tr>${i.sheet.headers.map((x) => `<th style="text-align:left;border-bottom:1px solid #eee;padding:5px 4px;color:#555;font-weight:600">${esc(x)}</th>`).join("")}</tr>
${i.sheet.rows.map((r) => `<tr><td style="border-bottom:1px solid #eee;padding:5px 4px">${esc(r.label)}</td>${r.cells.map((c) => `<td style="border-bottom:1px solid #eee;padding:5px 4px;white-space:nowrap">${esc(c)}</td>`).join("")}</tr>`).join("\n")}
</table>
${i.sheet.foot ? `<p style="margin:8px 0 0;font-size:12px;color:#666">${esc(i.sheet.foot)}</p>` : ""}
</div></div>`
    : "";
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;background:#ffffff;max-width:600px;padding:16px">
<p style="margin:0 0 4px"><span style="display:inline-block;background:#111;color:#fff;font:600 11px ui-monospace,Menlo,monospace;padding:2px 7px;border-radius:4px;letter-spacing:.06em">V${i.version}</span>&nbsp; ${esc(i.lead)}</p>
${i.quote ? `${h4(i.quote.label)}<div style="border-left:3px solid #b8892e;padding:6px 12px;font-size:14px;color:#333">${para(i.quote.text.trim())}</div>` : ""}
${top.map((x) => `${h4(x.label)}<p style="margin:0;font-size:14px">${para(x.text)}</p>`).join("\n")}
${showChanges ? `${h4(changesHead)}<ul style="margin:0;padding-left:18px;font-size:14px">${(i.changes?.length ? i.changes.map((c) => `<li style="margin:3px 0">${c.who ? `<b>${esc(c.who)}:</b> ` : ""}${c.note ? `"${esc(c.note)}" → ` : ""}${esc(c.done)}</li>`) : [`<li style="margin:3px 0">${esc(i.unchangedNote ?? "Nothing in the words changed.")}</li>`]).join("")}</ul>` : ""}
${h4("The reply, word for word")}
<div style="border-left:3px solid #F05A1A;background:#faf7f2;padding:10px 12px;font-size:14px;overflow-wrap:anywhere"><span style="color:#555">${esc(recipientsLine(i.reply))}<br>${esc(i.reply.subject)}</span><br><br>${para(i.reply.body.trim())}</div>
${sheetHtml}
${extras.map((x) => `${h4(x.label)}<p style="margin:0;font-size:14px">${para(x.text)}${x.url ? `<br><a href="${esc(x.url)}" style="color:#8a6418">${esc(x.url)}</a>` : ""}</p>`).join("\n")}
<p style="margin:18px 0 6px"><a href="${esc(i.link.url)}" style="display:inline-block;border:1.5px solid #2f7a4f;color:#2f7a4f;border-radius:8px;padding:11px 14px;font-weight:600;text-decoration:none">${esc(i.link.label)} ›</a></p>
<p style="margin:14px 0 0;font-size:11px;color:#999">${esc(i.replyHint)} ${esc(refLine)}</p>
</div>`;
  return { subject, text, html };
}

/** What would make a laid-out draft email wrong to send. [] when it is fit to go. */
export function draftEmailProblems(e: RenderedDraftEmail, ref: string, threadRef: string = ref): string[] {
  const out: string[] = [];
  if (!e.subject.endsWith(` · ready for your OK · ${threadRef}`) || !/ · v\d+ · ready for your OK · /.test(e.subject)) out.push('the subject is not "<Brand> <Document> · vN · ready for your OK · <ref>"');
  if (/\*\*|TL;DR/.test(e.text)) out.push("markdown stars or a TL;DR in the plain text");
  if (/individual inboxes/i.test(e.text)) out.push("the inbox footer");
  // The samples preview is the one /api/ page meant to be opened (the public pitch path); nothing else is.
  if (/\/api\/(?!tlc-pitch\/samples\/)/.test(e.text)) out.push("an /api/ address");
  if (!e.text.trimEnd().endsWith(threadRef === ref ? `Ref ${ref}` : `Ref ${ref} · thread ${threadRef}`)) out.push("the ref is not the last thing");
  if (!/THE REPLY, WORD FOR WORD/.test(e.text)) out.push("the reply is not in it word for word");
  if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.text)) out.push("a machine timestamp");
  if (new TextEncoder().encode(e.html).length > 80_000) out.push("over 80 KB of HTML");
  return out;
}

/**
 * THE NOTES A REDRAFT DID NOT ANSWER: each partner who wrote a note needs at least one change line under their name.
 * Non-empty means the email to her is held.
 */
export function unansweredNotes(notes: ReadonlyArray<{ who: string; note: string }>, changes: readonly ChangeLine[] | null): string[] {
  return notes.filter((n) => n.note.trim() && !(changes ?? []).some((c) => (c.who ?? "").toLowerCase() === n.who.toLowerCase() && c.done.trim())).map((n) => n.who);
}
