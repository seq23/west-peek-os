import type { InviteCheck, RoomBrief, RoomConcept, RoomEconomics, RunOfShowLine, SponsorTier } from "./roomPacket";
import { WORKSHOP_LENGTH_RANGE, WORKSHOP_WHERE, normaliseSponsorship, parkerWorkshopIntroduction, type WorkshopConcept, type WorkshopView } from "./workshopPacket";

/**
 * The Room packet as a document — HTML a browser prints to PDF (15 Sep 2026).
 *
 * WHY A PDF. Operator: "he needs to develop a packet for it that i can download." A packet that
 * lives only on a page is read once, in the OS, by whoever opens it; a PDF is forwarded to a
 * co-host, printed for a venue walk-through, and attached to the sponsor's follow-up. The same
 * render is used for every packet, so two packets a month apart read as one firm's work.
 *
 * WHAT IS ON THE COVER, and why it is Parker. Operator: "he needs to intro himself and what he does
 * for the firm in each one." The two-line introduction opens the PDF and the email alike — see
 * `parkerIntroduction()` — so the first packet Scooter opens tells him who wrote it.
 *
 * The same brand ground as the deck (WEST_PEEK_BRAND_SYSTEM.md: paper, ink, the canonical orange
 * used once as the rule). Letter portrait, because a packet is read, not presented. Pure: the
 * worker assembles the view from the rows and calls `renderPacketHtml`.
 */

export interface VenueView {
  name: string;
  city: string | null;
  address: string | null;
  capacity: number | null;
  whyHere: string | null;
  roomMinimumUsd: number | null;
  priceLowUsd: number | null;
  priceHighUsd: number | null;
  priceNote: string | null;
  estimateLowUsd: number | null;
  estimateHighUsd: number | null;
  estimateBasis: string | null;
  bookingPhone: string | null;
  bookingEmail: string | null;
  sourceUrl: string;
  isFallback: boolean;
}

export interface SponsorView {
  rank: number | null;
  orgName: string;
  category: string;
  tier: SponsorTier | string;
  askUsd: number | null;
  fitArgument: string | null;
  pitch: string | null;
  evidenceUrl: string | null;
  evidenceNote: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactSourceUrl: string | null;
  note: string | null;
  fromBrief: boolean;
}

export interface PacketView {
  packetId: string;
  title: string;
  theme: string;
  centralQuestion: string | null;
  /** YYYY-MM */
  month: string;
  format: string;
  targetMin: number;
  targetMax: number;
  audience: string | null;
  origin: "PARKER" | "PARTNER_BRIEF";
  brief: RoomBrief | null;
  pushback: string | null;
  concepts: RoomConcept[];
  conceptChoiceMd: string | null;
  runOfShow: RunOfShowLine[];
  agendaMd: string | null;
  seedQuestions: string[];
  guestIdeas: Array<{ description: string; why: string | null }>;
  venues: VenueView[];
  sponsors: SponsorView[];
  economics: RoomEconomics | null;
  sponsorThesis: string | null;
  risks: string[];
  commitmentMd: string | null;
  pitchEmail: { to: string; subject: string; body: string } | null;
  inviteCheck: InviteCheck | null;
  /** Organisations discovery looked at whose cited page did not answer — said, so the list reads as searched, not short. */
  alsoLookedAt: string[];
  /** 0251: the degraded-quality sentence when a free model not marked FULL wrote the packet; null otherwise. */
  qualityNote?: string | null;
  /** ISO timestamp of the build. */
  generatedAt: string;
}

/** Parker, in two lines. Opens the email and the PDF, every time. */
export function parkerIntroduction(): string[] {
  return [
    "I'm Parker, West Peek's Event Marketing Coordinator. I build the firm's Rooms end to end — the concept, the sponsors and the money behind it, the venue, the run of show — and hand you a packet you can act on.",
    "This is the Room of the month. Nothing is booked, nobody outside the firm has been contacted, and every venue and contact in here is unverified until one of us has called.",
  ];
}

export function monthWord(yyyyMm: string): string {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const m = Number(yyyyMm.slice(5, 7));
  return `${names[m - 1] ?? yyyyMm} ${yyyyMm.slice(0, 4)}`;
}

const usd = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`);

function esc(text: string | null | undefined): string {
  return (text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function paras(text: string | null | undefined): string {
  if (!text) return "";
  return text.split(/\n{2,}|\n(?=[-•*] )/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}

function tierWord(t: string): string {
  return t === "PRESENTING" ? "Title" : t === "SUPPORTING" ? "Supporting" : t === "IN_KIND" ? "In kind" : t;
}

function link(url: string | null | undefined, label?: string): string {
  if (!url) return "";
  const shown = label ?? url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `<a href="${esc(url)}">${esc(shown.length > 70 ? `${shown.slice(0, 67)}…` : shown)}</a>`;
}

/** The packet's file name, for the document and the download. */
export function packetFilename(view: Pick<PacketView, "title" | "month">): string {
  const slug = view.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "room-packet";
  return `west-peek-room-${view.month}-${slug}.pdf`;
}

/** The one stylesheet both packets print with: the family ground and ink, the canonical orange as the rule. */
const PACKET_CSS = `  /* The family ground and ink (WEST_PEEK_BRAND_SYSTEM.md); the canonical orange as the one rule. */
  :root{ --paper:#F7F2EA; --ink:#050505; --muted:#5F5B55; --rule:#D9D2C6; --accent:#F05A1A; --warn:#A8422A; }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--paper);color:var(--ink)}
  body{font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;font-size:11.5px;line-height:1.5}
  /* A SECTION FLOWS ONTO THE NEXT SHEET; only the cover is a full sheet. The first render fixed
     every section at 11in and broke after it, so a section that ran long left a sheet that was
     nine-tenths blank (found by reading the rendered PDF, not the HTML). */
  .page{width:8.5in;padding:0.6in 0.7in 0.55in;background:var(--paper);page-break-after:always;break-after:page;position:relative;display:flex;flex-direction:column}
  .page.cover{min-height:11in}
  .page:last-child{page-break-after:auto;break-after:auto}
  tr,.venue,.fit,.concept,.callout,.email{break-inside:avoid;page-break-inside:avoid}
  header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--rule);padding-bottom:6px;margin-bottom:18px}
  .wordmark{font-family:"Oswald","Public Sans",sans-serif;font-weight:600;letter-spacing:.18em;font-size:11px}
  .folio{font-size:9.5px;color:var(--muted);letter-spacing:.04em}
  footer{margin-top:auto;padding-top:10px;border-top:1px solid var(--rule);font-size:8.5px;color:var(--muted);letter-spacing:.03em}
  h1{font-family:"Oswald","Public Sans",sans-serif;font-weight:500;font-size:44px;line-height:1.04;margin:6px 0 14px;text-transform:uppercase;max-width:14ch;text-wrap:balance}
  h2{font-family:"Oswald","Public Sans",sans-serif;font-weight:500;font-size:22px;line-height:1.1;text-transform:uppercase;letter-spacing:.01em;margin:14px 0 8px;padding-top:6px;border-top:3px solid var(--accent);display:inline-block}
  h2 + *{margin-top:0}
  h3{font-size:12.5px;font-weight:600;margin:12px 0 4px}
  p{margin:0 0 6px;max-width:72ch}
  ul{margin:0 0 8px 18px;padding:0}li{margin:0 0 3px}
  .muted{color:var(--muted)}.warn{color:var(--warn)}
  .kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:40px}
  .question{font-size:17px;line-height:1.4;max-width:52ch;margin:0 0 10px}
  .meta{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .intro{margin-top:34px;max-width:64ch;border-left:3px solid var(--accent);padding-left:14px}
  .intro p{font-size:12.5px}
  .sig{font-family:"Oswald","Public Sans",sans-serif;font-size:13px;letter-spacing:.06em}
  .cover-facts{display:flex;gap:26px;margin-top:auto;padding-top:22px;flex-wrap:wrap}
  .cover-facts div{display:flex;flex-direction:column;gap:2px}
  .cover-facts .label{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  .cover-facts .value{font-family:"Oswald","Public Sans",sans-serif;font-size:20px;font-variant-numeric:tabular-nums}
  .callout{border:1px solid var(--rule);border-left:3px solid var(--accent);padding:8px 12px;margin:10px 0}
  .callout h3{margin-top:0}
  .tag{display:inline-block;font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--ink);border-radius:2px;padding:0 4px;margin-left:4px;vertical-align:middle}
  table{width:100%;border-collapse:collapse;margin:4px 0 12px;font-size:10.5px}
  th,td{text-align:left;vertical-align:top;padding:5px 6px;border-bottom:1px solid var(--rule)}
  thead th{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--ink)}
  tbody th{font-weight:600}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  tr.total th,tr.total td{border-bottom:2px solid var(--ink);font-weight:600}
  tr.chosen th,tr.chosen td{background:rgba(240,90,26,.07)}
  .ros td.time{white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:600}
  .concept{margin:0 0 10px}.concept.chosen{border-left:3px solid var(--accent);padding-left:10px}
  .venue{margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--rule)}.venue.fallback{opacity:.85}
  .fit{margin:0 0 8px}
  .email{border:1px solid var(--rule);padding:10px 14px;margin:6px 0 8px;background:rgba(5,5,5,.02)}
  a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--rule)}
  @page{size:8.5in 11in;margin:0}
  @media print{.page{margin:0}}
`;

export function renderPacketHtml(v: PacketView): string {
  const chosen = v.concepts.find((c) => c.chosen) ?? null;
  const others = v.concepts.filter((c) => !c.chosen);
  const eco = v.economics;
  const first = v.sponsors.find((s) => (s.rank ?? 99) === 1) ?? v.sponsors[0] ?? null;
  const dateWord = new Date(v.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

  const cover = `<section class="page cover">
  <header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">Room packet · ${esc(monthWord(v.month))}</span></header>
  <p class="kicker">The ${esc(monthWord(v.month))} Room</p>
  <h1>${esc(v.title)}</h1>
  ${v.centralQuestion ? `<p class="question">“${esc(v.centralQuestion)}”</p>` : ""}
  ${v.qualityNote ? `<p class="muted"><strong>Quality note:</strong> ${esc(v.qualityNote)}</p>` : ""}
  <p class="meta">${esc(v.format.replace(/_/g, " ").toLowerCase())} · ${v.targetMin}–${v.targetMax} people · ${esc(v.brief?.city ?? v.venues[0]?.city ?? "")}</p>
  <div class="intro">
    ${parkerIntroduction().map((l) => `<p>${esc(l)}</p>`).join("")}
    <p class="sig">— Parker</p>
  </div>
  <div class="cover-facts">
    ${eco ? `<div><span class="label">All-in cost</span><span class="value">${usd(eco.estimatedCostLowUsd)}–${usd(eco.estimatedCostHighUsd)}</span></div>` : ""}
    ${eco ? `<div><span class="label">Sponsorship, all slots</span><span class="value">${usd(eco.sponsorTargetHighUsd)}</span></div>` : ""}
    ${eco ? `<div><span class="label">The firm keeps</span><span class="value">${usd(eco.netHighUsd)}${eco.reachesKeep ? "" : " (short of target)"}</span></div>` : ""}
    <div><span class="label">Sponsors ranked</span><span class="value">${v.sponsors.length}</span></div>
  </div>
  <footer>Prepared ${esc(dateWord)} by Parker for Sequoia Taylor and Scooter Taylor · Private &amp; Confidential</footer>
</section>`;

  const briefBlock = v.brief
    ? `<h3>What was asked for</h3>
  <p>${esc(v.brief.audience)}${v.brief.city ? ` · ${esc(v.brief.city)}` : ""} · ${esc(monthWord(v.brief.month))}</p>
  ${v.brief.sponsorProspects.length ? `<p><strong>Sponsors named:</strong> ${esc(v.brief.sponsorProspects.join(", "))}</p>` : ""}
  ${v.brief.notes ? `<p class="muted">${esc(v.brief.notes)}</p>` : ""}`
    : `<h3>Parker's own idea for the month</h3><p>Nobody asked for a particular Room; this is the one Parker thinks the community needs now.</p>`;

  const verdict = `<section class="page">
  <header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">${esc(v.title)}</span></header>
  <h2>The brief, and Parker's read of it</h2>
  ${briefBlock}
  ${v.pushback ? `<div class="callout"><h3>Where I push back</h3>${paras(v.pushback)}</div>` : ""}
  <h3>Theme</h3><p>${esc(v.theme)}</p>
  <h3>Who should be in the room</h3><p>${esc(v.audience ?? "Parker did not say.")}</p>
  ${v.inviteCheck ? `<h3>Can our own list fill it?</h3>
  <p><strong>${esc(v.inviteCheck.verdict.replace(/_/g, " ").toLowerCase())}.</strong> ${v.inviteCheck.matchingCount} of ${v.inviteCheck.totalContacts} contacts in the firm's records read as ${esc(v.inviteCheck.matchedOn.join(" / "))}. ${esc(v.inviteCheck.note)}</p>
  ${v.inviteCheck.archetypes.length ? `<p><strong>Archetypes already on the list:</strong> ${esc(v.inviteCheck.archetypes.join("; "))}</p>` : ""}
  ${v.inviteCheck.namedFromRecords.length ? `<p><strong>A starting list, from our records:</strong> ${esc(v.inviteCheck.namedFromRecords.join(", "))}</p>` : ""}` : ""}
  ${v.guestIdeas.length ? `<h3>Guests worth asking</h3><ul>${v.guestIdeas.map((g) => `<li>${esc(g.description)}${g.why ? ` <span class="muted">— ${esc(g.why)}</span>` : ""}</li>`).join("")}</ul>` : ""}
  ${v.seedQuestions.length ? `<h3>Questions to seed it with</h3><ul>${v.seedQuestions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
</section>`;

  const conceptRow = (c: RoomConcept) => `<tr class="${c.chosen ? "chosen" : ""}">
    <th scope="row">${esc(c.title)}${c.chosen ? ' <span class="tag">chosen</span>' : ""}<br><span class="muted">${esc(c.format.replace(/_/g, " ").toLowerCase())}</span></th>
    <td>${esc(c.tone)}</td><td>${esc(c.valueToSponsor)}</td><td>${esc(c.whoItFits)}</td><td>${esc(c.costBand)}</td>
  </tr>`;
  const concepts = v.concepts.length
    ? `<section class="page">
  <header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">${esc(v.title)}</span></header>
  <h2>Three concepts, compared — and the one I chose</h2>
  ${v.concepts.map((c) => `<div class="concept${c.chosen ? " chosen" : ""}"><h3>${esc(c.title)}${c.chosen ? ' <span class="tag">chosen</span>' : ""}</h3><p>${esc(c.premise)}</p><p class="muted"><strong>Signature moment:</strong> ${esc(c.signatureMoment)}</p></div>`).join("")}
  <table class="compare"><thead><tr><th>Concept</th><th>Tone</th><th>Value to the sponsor</th><th>Who it fits</th><th>Cost band</th></tr></thead><tbody>${v.concepts.map(conceptRow).join("")}</tbody></table>
  ${v.conceptChoiceMd ? `<div class="callout"><h3>Why ${esc(chosen?.title ?? "this one")} wins</h3>${paras(v.conceptChoiceMd)}</div>` : ""}
</section>`
    : "";

  const ros = `<section class="page">
  <header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">${esc(v.title)}</span></header>
  <h2>Run of show</h2>
  ${v.runOfShow.length
    ? `<table class="ros"><thead><tr><th>Time</th><th>Min</th><th>What happens</th><th>Who</th></tr></thead><tbody>${v.runOfShow.map((l) => `<tr><td class="time">${esc(l.time)}</td><td class="num">${l.minutes || ""}</td><td>${esc(l.what)}</td><td class="muted">${esc(l.who)}</td></tr>`).join("")}</tbody></table>`
    : v.agendaMd ? paras(v.agendaMd) : "<p>No run of show was written.</p>"}
  <h2>Where</h2>
  ${v.venues.length
    ? v.venues.map((venue) => `<div class="venue${venue.isFallback ? " fallback" : ""}">
      <h3>${esc(venue.name)}${venue.isFallback ? ' <span class="tag">fallback</span>' : ""}<span class="muted"> · ${esc([venue.city, venue.address].filter(Boolean).join(", "))}${venue.capacity ? ` · holds ${venue.capacity}` : ""}</span></h3>
      ${venue.whyHere ? `<p>${esc(venue.whyHere)}</p>` : ""}
      <p><strong>Estimate for this Room:</strong> ${usd(venue.estimateLowUsd)}–${usd(venue.estimateHighUsd)}${venue.roomMinimumUsd ? ` · room minimum ${usd(venue.roomMinimumUsd)}` : ""}${venue.priceLowUsd || venue.priceHighUsd ? ` · published ${usd(venue.priceLowUsd ?? venue.priceHighUsd)}–${usd(venue.priceHighUsd ?? venue.priceLowUsd)}` : " · no price published"}<br><span class="muted">${esc(venue.estimateBasis ?? "")}${venue.priceNote ? ` — ${esc(venue.priceNote)}` : ""}</span></p>
      <p class="muted">${venue.bookingPhone ? `${esc(venue.bookingPhone)} · ` : ""}${venue.bookingEmail ? `${esc(venue.bookingEmail)} · ` : ""}${link(venue.sourceUrl)} · unverified until called</p>
    </div>`).join("")
    : "<p>No venue survived sourcing; a person finds the space.</p>"}
</section>`;

  const sponsorRow = (s: SponsorView) => `<tr>
    <td class="num">${s.rank ?? ""}</td>
    <th scope="row">${esc(s.orgName)}${s.fromBrief ? ' <span class="tag">named by you</span>' : ""}<br><span class="muted">${esc(s.category.replace(/_/g, " ").toLowerCase())} · ${esc(tierWord(String(s.tier)))} · ${usd(s.askUsd)}</span></th>
    <td>${s.evidenceUrl ? `${esc(s.evidenceNote ?? "")}<br>${link(s.evidenceUrl)}` : '<span class="warn">no sponsorship history found on a public page</span>'}</td>
    <td>${s.contactName ? `${esc(s.contactName)}<br><span class="muted">${esc(s.contactTitle ?? "")}</span><br>${link(s.contactSourceUrl, "read from this page")}` : '<span class="muted">no named contact on a public page — a person finds one</span>'}</td>
  </tr>`;
  const sponsors = `<section class="page">
  <header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">${esc(v.title)}</span></header>
  <h2>Who pays for it — ranked</h2>
  ${v.sponsorThesis ? `<p><strong>What a sponsor underwrites:</strong> ${esc(v.sponsorThesis.replace(/[.\s]+$/, ""))}. Sponsors underwrite the experience; they never buy access to members.</p>` : ""}
  ${v.sponsors.length
    ? `<table class="sponsors"><thead><tr><th>#</th><th>Organisation</th><th>Evidence they sponsor</th><th>Who runs partnerships</th></tr></thead><tbody>${v.sponsors.map(sponsorRow).join("")}</tbody></table>
  ${v.sponsors.map((s) => (s.fitArgument || s.pitch || s.note) ? `<div class="fit"><h3>${s.rank ?? ""}. ${esc(s.orgName)}</h3>${s.fitArgument ? `<p>${esc(s.fitArgument)}</p>` : ""}${s.pitch ? `<p class="muted"><strong>Open with:</strong> ${esc(s.pitch)}</p>` : ""}${s.note ? `<p class="muted">${esc(s.note)}</p>` : ""}</div>` : "").join("")}`
    : "<p>Nobody to approach was named. A Room with no prospect is spend the fund carries alone.</p>"}
  ${v.alsoLookedAt.length ? `<p class="muted">Also looked at, left out because the cited page did not answer when checked: ${esc(v.alsoLookedAt.join(", "))}.</p>` : ""}
</section>`;

  const money = eco
    ? `<section class="page">
  <header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">${esc(v.title)}</span></header>
  <h2>What it costs</h2>
  <table class="budget"><thead><tr><th>Line</th><th class="num">Low</th><th class="num">High</th><th>Basis</th></tr></thead><tbody>
  ${eco.lines.map((l) => `<tr><th scope="row">${esc(l.label)}</th><td class="num">${usd(l.lowUsd)}</td><td class="num">${usd(l.highUsd)}</td><td class="muted">${esc(l.basis)}</td></tr>`).join("")}
  <tr class="total"><th scope="row">Total at ${eco.targetAttendees} people</th><td class="num">${usd(eco.estimatedCostLowUsd)}</td><td class="num">${usd(eco.estimatedCostHighUsd)}</td><td></td></tr>
  </tbody></table>
  <h2>How the sponsorship is structured</h2>
  <p>${esc(eco.structure.rationale)}</p>
  <table class="slots"><thead><tr><th>Slot</th><th class="num">How many</th><th class="num">Ask</th><th>What they get</th></tr></thead><tbody>
  ${eco.structure.slots.map((s) => `<tr><th scope="row">${esc(tierWord(s.tier))}</th><td class="num">${s.count}</td><td class="num">${usd(s.askUsd)}</td><td class="muted">${esc(s.gets)}</td></tr>`).join("")}
  ${eco.structure.exclusiveUsd ? `<tr><th scope="row">Exclusive (one sponsor, the whole room)</th><td class="num">1</td><td class="num">${usd(eco.structure.exclusiveUsd)}</td><td class="muted">${esc(eco.structure.exclusiveGets ?? "")}</td></tr>` : ""}
  </tbody></table>
  <p><strong>Priced against:</strong> the high-case cost ${usd(eco.estimatedCostHighUsd)} plus the firm's target keep ${usd(eco.keepTargetUsd)} = ${usd(eco.requiredUsd)}. All slots sold bring ${usd(eco.sponsorTargetHighUsd)} — ${eco.reachesKeep ? "the target is reached" : `short of the target by ${usd(eco.requiredUsd - eco.sponsorTargetHighUsd)}; Parker says so rather than rounding`}.</p>
  <h3>What is left as sponsors say yes</h3>
  <table class="scenarios"><thead><tr><th>Sponsors</th><th class="num">Sponsorship</th><th class="num">Left over (low case)</th><th class="num">Left over (high case)</th></tr></thead><tbody>
  ${eco.scenarios.map((s) => `<tr><th scope="row">${s.sponsors} — ${esc(s.description)}</th><td class="num">${usd(s.sponsorshipUsd)}</td><td class="num${s.netLowUsd < 0 ? " warn" : ""}">${usd(s.netLowUsd)}</td><td class="num${s.netHighUsd < 0 ? " warn" : ""}">${usd(s.netHighUsd)}</td></tr>`).join("")}
  ${eco.exclusiveScenario ? `<tr><th scope="row">Exclusive</th><td class="num">${usd(eco.exclusiveScenario.sponsorshipUsd)}</td><td class="num">${usd(eco.exclusiveScenario.netLowUsd)}</td><td class="num">${usd(eco.exclusiveScenario.netHighUsd)}</td></tr>` : ""}
  </tbody></table>
</section>`
    : "";

  const pitch = `<section class="page">
  <header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">${esc(v.title)}</span></header>
  <h2>The pitch — a draft for Sequoia to send</h2>
  ${v.pitchEmail
    ? `<div class="email"><p class="muted">To: ${esc(v.pitchEmail.to || (first ? `${first.contactName ? `${first.contactName}, ${first.contactTitle ?? ""}, ` : "the partnerships team at "}${first.orgName}` : ""))}</p><p><strong>${esc(v.pitchEmail.subject)}</strong></p>${paras(v.pitchEmail.body)}</div><p class="muted">Nothing has been sent. Copy, edit, send from your own account.</p>`
    : "<p>Parker did not draft the pitch.</p>"}
  <h2>What could go wrong</h2>
  ${v.risks.length ? `<ul>${v.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "<p>No risks named. Assume there are some.</p>"}
  <h2>What keeping it commits the firm to</h2>
  ${paras(v.commitmentMd ?? "Parker did not say — decide before you keep it.")}
</section>`;

  const appendix = others.length
    ? `<section class="page">
  <header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">${esc(v.title)} · appendix</span></header>
  <h2>Appendix — the two concepts this one beat</h2>
  ${others.map((c) => `<div class="concept"><h3>${esc(c.title)} <span class="muted">· ${esc(c.format.replace(/_/g, " ").toLowerCase())} · ${esc(c.costBand)}</span></h3><p>${esc(c.premise)}</p><p><strong>Tone:</strong> ${esc(c.tone)}</p><p><strong>Value to the sponsor:</strong> ${esc(c.valueToSponsor)}</p><p><strong>Who it fits:</strong> ${esc(c.whoItFits)}</p><p><strong>Signature moment:</strong> ${esc(c.signatureMoment)}</p><p class="muted"><strong>Venue direction:</strong> ${esc(c.venueDirection)}</p></div>`).join("")}
  <footer>Packet ${esc(v.packetId)} · built ${esc(v.generatedAt)} · West Peek OS</footer>
</section>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(v.title)} — Room packet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600&family=Public+Sans:ital,wght@0,400;0,600;1,400&display=swap">
<style>
${PACKET_CSS}</style></head>
<body>
${cover}
${verdict}
${concepts}
${ros}
${sponsors}
${money}
${pitch}
${appendix}
</body></html>`;
}

/**
 * THE WORKSHOP PACKET as a document (16 Sep 2026). The same paper, ink and rule as the Room packet
 * — two packets a month apart read as one firm's work — with the Workshop's own pages: the
 * promise, three ways to run it, the run of show with its breakouts, WHERE as a delivery plan on
 * West Peek Live (never a venue), what they leave with, the invitations, the money, the risks.
 */
export function renderWorkshopHtml(v: PacketView, w: WorkshopView): string {
  const title = v.title.replace(/^Workshop: /, "");
  const concepts = v.concepts as WorkshopConcept[];
  const chosen = concepts.find((c) => c.chosen) ?? null;
  const others = concepts.filter((c) => !c.chosen);
  const eco = w.economics;
  // Stored JSON from before 17 Sep 2026 carries the old `{ free, categoryFit, askUsd }` shape.
  const wsp = normaliseSponsorship(w.sponsorship);
  const dateWord = new Date(v.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const head = (folio: string) => `<header><span class="wordmark">WEST&thinsp;PEEK VENTURES</span><span class="folio">${esc(folio)}</span></header>`;

  const cover = `<section class="page cover">
  ${head(`Workshop packet · ${monthWord(v.month)}`)}
  <p class="kicker">The ${esc(monthWord(v.month))} Workshop · topic: ${esc(w.topic ?? title)}${w.topicSetBy === "PARKER" ? " (Parker's own pick)" : " (set by the partners)"}</p>
  <h1>${esc(title)}</h1>
  <p class="question">${esc(w.promise)}</p>
  <p class="meta">${esc(WORKSHOP_WHERE)} · ${esc(WORKSHOP_LENGTH_RANGE)} · ${v.targetMin}–${v.targetMax} people · ${esc(w.mode.toLowerCase())} · free to attend</p>
  <div class="intro">
    ${parkerWorkshopIntroduction().map((l) => `<p>${esc(l)}</p>`).join("")}
    <p class="sig">— Parker</p>
  </div>
  <div class="cover-facts">
    <div><span class="label">Host</span><span class="value">${esc(w.facilitator.name)}</span></div>
    <div><span class="label">Co-host</span><span class="value">${esc(w.coHost?.name ?? "not named yet")}</span></div>
    <div><span class="label">Cost to attend</span><span class="value">free, by design</span></div>
    <div><span class="label">Suggested sponsor</span><span class="value">${wsp.suggested ? `${esc(wsp.suggested.categoryFit)} · ${usd(wsp.suggested.askUsd ?? 0)}` : "none suggested"}</span></div>
    <div><span class="label">Breakout exercises</span><span class="value">${w.runOfShow.filter((l) => l.segment === "BREAKOUT").length}</span></div>
  </div>
  <footer>Prepared ${esc(dateWord)} by Parker for Sequoia Taylor and Scooter Taylor · Private &amp; Confidential</footer>
</section>`;

  const brief = `<section class="page">
  ${head(title)}
  <h2>The brief, and Parker's read of it</h2>
  ${w.topicSetBy === "PARTNERS" ? `<h3>The topic was set by the partners</h3><p>The ${esc(monthWord(v.month))} Workshop's topic was decided: <strong>${esc(w.topic ?? title)}</strong>. Parker worked up three angles on it and chose one; he did not re-ideate the subject.</p>` : `<h3>Parker chose the topic</h3><p>Nobody had set one for ${esc(monthWord(v.month))}, so Parker picked <strong>${esc(w.topic ?? title)}</strong> and worked up three angles on it.</p>`}
  ${v.pushback ? `<div class="callout"><h3>Where I push back</h3>${paras(v.pushback)}</div>` : ""}
  <h3>Who it is for</h3><p>${esc(w.whoItsFor)}</p>
  <h3>The promise — what they can do by the end</h3><p>${esc(w.promise)}</p>
  <h3>Who runs it</h3><p><strong>${esc(w.facilitator.name)}</strong> (host, ${w.facilitator.kind === "PARTNER" ? "partner" : "guest"}) — ${esc(w.facilitator.why)}${w.facilitator.evidenceUrl ? ` · ${link(w.facilitator.evidenceUrl)}` : ""}</p>
  ${w.coHost ? `<p><strong>${esc(w.coHost.name)}</strong> (co-host, ${w.coHost.kind === "PARTNER" ? "partner" : "guest"}) — ${esc(w.coHost.why)}</p>` : `<p class="muted">No co-host named. A Workshop usually has one — decide who before you keep this.</p>`}
  ${w.notes.length ? `<h3>What the audience is asking this month</h3><ul>${w.notes.map((n) => `<li>${esc(n.fact)} <span class="muted">— ${esc(n.source)}${n.date ? `, ${esc(n.date)}` : ""} · ${link(n.url)}</span></li>`).join("")}</ul>` : "<p class=\"muted\">No research note survived the live check and the judgement pass; the design is from the brief.</p>"}
</section>`;

  const conceptRow = (c: WorkshopConcept) => `<tr class="${c.chosen ? "chosen" : ""}">
    <th scope="row">${esc(c.title === title ? c.promise : c.title)}${c.chosen ? ' <span class="tag">chosen</span>' : ""}<br><span class="muted">${esc(c.mode.toLowerCase())}</span></th>
    <td>${esc(c.whoItsFor)}</td><td>${esc(c.signatureMoment)}</td><td>${esc(c.leaveWith)}</td><td>${esc(c.facilitator.name)}${c.coHost ? ` with ${esc(c.coHost.name)}` : ""}</td><td>${esc((c.angleKind ?? "FRAMING").toLowerCase().replace(/_/g, " "))}</td>
  </tr>`;
  const conceptsPage = concepts.length
    ? `<section class="page">
  ${head(title)}
  <h2>Three angles on the topic, compared — and the one I chose</h2>
  ${concepts.map((c) => `<div class="concept${c.chosen ? " chosen" : ""}"><h3>${esc(c.title === title ? c.promise : c.title)}${c.chosen ? ' <span class="tag">chosen</span>' : ""}</h3><p>${esc(c.title === title ? `${c.mode.toLowerCase()} — ${c.signatureMoment}` : c.promise)}</p><p class="muted"><strong>They leave with:</strong> ${esc(c.leaveWith)}</p></div>`).join("")}
  <table class="compare"><thead><tr><th>Angle</th><th>Who it is for</th><th>Signature exercise</th><th>They leave with</th><th>Hosts</th><th>What it varies</th></tr></thead><tbody>${concepts.map(conceptRow).join("")}</tbody></table>
  ${v.conceptChoiceMd ? `<div class="callout"><h3>Why ${esc(chosen ? (chosen.title === title ? "this way" : chosen.title) : "this one")} wins</h3>${paras(v.conceptChoiceMd)}</div>` : ""}
</section>`
    : "";

  const ros = `<section class="page">
  ${head(title)}
  <h2>Run of show — ${esc(WORKSHOP_LENGTH_RANGE)}</h2>
  ${w.runOfShow.length
    ? `<table class="ros"><thead><tr><th>Time</th><th>Min</th><th>Where</th><th>What happens</th><th>Who</th></tr></thead><tbody>${w.runOfShow.map((l) => `<tr><td class="time">${esc(l.time)}</td><td class="num">${l.minutes || ""}</td><td class="muted">${l.segment === "BREAKOUT" ? "breakout" : "stage"}</td><td>${esc(l.what)}</td><td class="muted">${esc(l.who)}</td></tr>`).join("")}</tbody></table>`
    : "<p>No run of show was written.</p>"}
  <h3>The exercises</h3>
  ${w.exercises.length ? `<ul>${w.exercises.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : "<p class=\"muted\">None written.</p>"}
  <h3>What they leave with</h3>
  ${w.leaveWith.length ? `<ul>${w.leaveWith.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : "<p class=\"warn\">Not stated — a Workshop with no artifact is a talk.</p>"}
  <h2>Where — ${esc(WORKSHOP_WHERE)}</h2>
  <p>Virtual only: a live stage for the facilitator, attendee join by code, chat, hand-raise, breakouts for the exercises. No venue, no catering, no travel.</p>
  <h3>Platform run of show</h3>
  ${w.delivery.platformRunOfShow.length ? `<ol>${w.delivery.platformRunOfShow.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : "<p class=\"muted\">Not written.</p>"}
  <h3>On screen</h3>
  ${w.delivery.onScreen.length ? `<ul>${w.delivery.onScreen.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "<p class=\"muted\">Not written.</p>"}
  <h3>The join-code invitation flow</h3>
  ${w.delivery.joinFlow.length ? `<ol>${w.delivery.joinFlow.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : "<p class=\"muted\">Not written.</p>"}
  ${w.delivery.techCheck ? `<h3>Tech check</h3>${paras(w.delivery.techCheck)}` : ""}
</section>`;

  const invites = `<section class="page">
  ${head(title)}
  <h2>Getting people in</h2>
  ${w.promoOneLiner ? `<h3>The promo line</h3><p class="question">“${esc(w.promoOneLiner)}”</p>` : ""}
  <h3>Three invitation emails — yours to send</h3>
  ${w.invitations.length ? w.invitations.map((i) => `<div class="email"><p class="muted">${i.n}. ${esc(i.sendWhen)}</p><p><strong>${esc(i.subject)}</strong></p>${paras(i.body)}</div>`).join("") : "<p class=\"muted\">No invitations were drafted.</p>"}
  <p class="muted">Nothing has been sent. Copy, edit, send from your own account.</p>
</section>`;

  const money = `<section class="page">
  ${head(title)}
  <h2>What it costs</h2>
  <table class="budget"><thead><tr><th>Line</th><th class="num">Low</th><th class="num">High</th><th>Basis</th></tr></thead><tbody>
  ${eco.lines.map((l) => `<tr><th scope="row">${esc(l.label)}</th><td class="num">${usd(l.lowUsd)}</td><td class="num">${usd(l.highUsd)}</td><td class="muted">${esc(l.basis)}</td></tr>`).join("")}
  <tr class="total"><th scope="row">Total</th><td class="num">${usd(eco.estimatedCostLowUsd)}</td><td class="num">${usd(eco.estimatedCostHighUsd)}</td><td class="muted">no venue, no food and beverage, no room hire — a Workshop is virtual</td></tr>
  </tbody></table>
  <h2>Cost to attend, and the sponsor suggestion</h2>
  <p><strong>Free to attend — always, by design.</strong> ${esc(wsp.note)} The firm carries ${usd(eco.estimatedCostLowUsd)}–${usd(eco.estimatedCostHighUsd)} as community work.</p>
  ${wsp.suggested
    ? `<p><strong>A small sponsor worth asking:</strong> ${esc(wsp.suggested.categoryFit)}, about ${usd(wsp.suggested.askUsd ?? 0)} — ${esc(wsp.suggested.why)} It is a suggestion, not a commitment: the session runs either way and would still be free to attend. It would cover ${usd(eco.wouldCoverUsd)} of the high case. No company is named without evidence; sponsor research can follow on request.</p>`
    : `<p class="muted">No sponsor was suggested. One always should be — it is free to have suggested one, and the firm may simply not use it. Ask Parker again.</p>`}
  <h2>What could go wrong</h2>
  ${v.risks.length ? `<ul>${v.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "<p>No risks named. Assume there are some.</p>"}
  <h2>What keeping it commits the firm to</h2>
  ${paras(v.commitmentMd ?? "Parker did not say — decide before you keep it.")}
  ${w.flags.length ? `<p class="muted">Flags: ${esc(w.flags.map((f) => f.detail).join("; "))}.</p>` : ""}
</section>`;

  const appendix = others.length
    ? `<section class="page">
  ${head(`${title} · appendix`)}
  <h2>Appendix — the two ways this one beat</h2>
  ${others.map((c) => `<div class="concept"><h3>${esc(c.title === title ? c.promise : c.title)} <span class="muted">· ${esc(c.mode.toLowerCase())} · ${esc(c.costBand)}</span></h3><p>${esc(c.title === title ? c.signatureMoment : c.promise)}</p><p><strong>Who it is for:</strong> ${esc(c.whoItsFor)}</p><p><strong>They leave with:</strong> ${esc(c.leaveWith)}</p><p><strong>Facilitator:</strong> ${esc(c.facilitator.name)} — ${esc(c.facilitator.why)}</p></div>`).join("")}
  <footer>Packet ${esc(v.packetId)} · built ${esc(v.generatedAt)} · West Peek OS</footer>
</section>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)} — Workshop packet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600&family=Public+Sans:ital,wght@0,400;0,600;1,400&display=swap">
<style>
${PACKET_CSS}</style></head>
<body>
${cover}
${brief}
${conceptsPage}
${ros}
${invites}
${money}
${appendix}
</body></html>`;
}
