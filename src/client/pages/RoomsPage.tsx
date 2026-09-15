import { useState } from "react";
import { api, getDevUser, useApi } from "../lib/api";
import { EventsPage } from "./EventsPage";
import { EVENT_ETHOS, OPERATING_RHYTHM, WHY_THE_RHYTHM } from "@shared/events/programme";
import { sameOrg } from "@shared/events/roomPacket";
import { HowThisWorks } from "./HowThisWorks";

/**
 * Events & Rooms — the gathering side of the firm, on one page.
 *
 * WHAT WAS WRONG, in the operator's words: "add a final pass for every single tab that make sure
 * the pages are not jumbled like the events tab and look more like the LP tab", and "i dont
 * underestand why it cant be simple like the lp page. everything is there and its easy to follow."
 *
 * This page was four containers deep where LP is one. A panel held Proposals; each row was an
 * accordion; opening the accordion loaded a packet with its own sub-sections; and the entire
 * Events surface was mounted inside a subsection of all that, so an h3 rendered two levels below
 * another h3. Nothing about a Room — its question, its venues, its economics, the approve button —
 * was visible until you guessed that a row was clickable.
 *
 * THE ORDER, AND WHY THIS ONE. It is the sequence a partner actually asks walking in, which is
 * also the life of a Room:
 *
 *   1 What is Parker asking me to decide?   — the live proposals, each open, decision on the card.
 *   2 What have we already turned down?     — so the same idea in March is checked against February.
 *   3 Who is paying for it?                 — a Room and its funding are one decision, not two tabs.
 *   4 What actually happened?               — the firm's record of every gathering.
 *   5 How do I add one that Parker did not propose?
 *   6 How often should we be doing this?    — the stance and the rhythm.
 *
 * The alternative order — stance first, because it is the constraint on everything below — is what
 * this page used to do, and it is why the operator could not find the decision. The stance is a
 * rule about what NOT to schedule; it belongs where you go to check yourself, not in front of the
 * one thing the page exists to make you do. It is now stated in one line at the top of section 1,
 * where it constrains the decision being taken, and in full at the end.
 *
 * FORMS COME AFTER THE ANSWERS THEY FEED. Ask-Parker-for-one sits under the proposals; add-a-sponsor
 * under the sponsor table; add-an-event under the record. That is LP's order and it was inverted
 * here twice.
 *
 * ONE ORIENTATION BLOCK BEFORE THE CONTENT. The shell already renders PagePurposeBlock at the top;
 * this page stacked a HowThisWorks above the content as well, and Events stacked a second one. The
 * detailed version belongs at the bottom for someone already working — which is what
 * PagePurposeBlock's own docstring says — so there is now exactly one, at the end, covering both.
 *
 * THE ONE THING THIS UI MUST GET RIGHT. A packet exists so a partner can execute without
 * re-checking, and the single most dangerous element on the page is a venue phone number. Every
 * contact detail therefore shows its verification state, and "nobody has called yet" is styled as a
 * warning rather than as neutral chrome — because the failure is discovered by someone standing on
 * a phone, not sitting at a desk. Marking a venue confirmed requires having actually called it.
 */

interface PacketRow {
  id: string;
  title: string;
  theme: string;
  central_question: string | null;
  status: string;
  proposed_for_month: string;
  format: string;
  target_min: number;
  target_max: number;
  audience: string | null;
  sponsor_thesis: string | null;
  economics_json: string;
  event_id: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  /** Which door: her brief, or Parker's own idea. */
  origin: "PARKER" | "PARTNER_BRIEF";
  brief_json: string | null;
  requested_by: string | null;
  sponsor_count: number;
  sponsor_total_usd: number;
  build_error: string | null;
  build_attempts: number;
  parent_packet_id: string | null;
  emailed_at: string | null;
  /** Where Parker is in the chain while it is a DRAFT (QUEUED … DONE). */
  build_stage?: string;
  work_card_id?: string | null;
  /** The downloadable PDF, once rendered. */
  document_id?: string | null;
  pushback_md?: string | null;
}

/** What the page says while Parker is on each stage; mirrors BUILD_STAGE_LABELS on the worker. */
const BUILD_STAGES = ["DISCOVER", "RESEARCH", "CONCEPTS", "VENUES", "PACKET", "PDF"] as const;
const STAGE_LABELS: Record<string, string> = {
  QUEUED: "waiting for Parker to pick it up",
  DISCOVER: "reading the firm's list and finding who pays to be in front of this audience",
  RESEARCH: "researching each sponsor — their programme, the people who run it, their own words",
  CONCEPTS: "ideating three concepts and choosing one",
  VENUES: "searching venues for the chosen concept",
  PACKET: "writing the packet — run of show, budget, structure, the pitch",
  PDF: "rendering the PDF and emailing both partners",
  DONE: "done",
};

interface Concept { title: string; format: string; premise: string; tone: string; valueToSponsor: string; whoItFits: string; costBand: string; signatureMoment: string; venueDirection: string; chosen: boolean }
interface RunOfShowLine { time: string; minutes: number; what: string; who: string }
interface InviteCheck { totalContacts: number; matchingCount: number; matchedOn: string[]; archetypes: string[]; namedFromRecords: string[]; verdict: string; note: string }
interface PitchEmail { to: string; subject: string; body: string }

interface Brief {
  audience: string;
  month: string;
  city: string | null;
  sponsorProspects: string[];
  notes: string | null;
}

/** The brief as stored on a packet. Malformed is null, never a crash. */
function briefOf(p: Pick<PacketRow, "brief_json">): Brief | null {
  if (!p.brief_json) return null;
  try {
    const b = JSON.parse(p.brief_json) as Partial<Brief>;
    return b && typeof b.audience === "string"
      ? { audience: b.audience, month: b.month ?? "", city: b.city ?? null, sponsorProspects: Array.isArray(b.sponsorProspects) ? b.sponsorProspects : [], notes: b.notes ?? null }
      : null;
  } catch {
    return null;
  }
}

/** YYYY-MM for a month offset from now, for the request form's default (next month). */
function monthPlus(offset: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
}

function monthWord(yyyyMm: string): string {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const m = Number(yyyyMm.slice(5, 7));
  return names[m - 1] ? `${names[m - 1]} ${yyyyMm.slice(0, 4)}` : yyyyMm;
}

interface VenueRow {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  capacity: number | null;
  price_low_usd: number | null;
  price_high_usd: number | null;
  price_note: string | null;
  booking_phone: string | null;
  booking_email: string | null;
  booking_url: string | null;
  source_url: string;
  verification: string;
  note: string | null;
  estimate_low_usd?: number | null;
  estimate_high_usd?: number | null;
  estimate_basis?: string | null;
  why_here?: string | null;
  room_minimum_usd?: number | null;
  is_fallback?: number | null;
}

interface SponsorRow {
  id: string;
  org_name: string;
  tier: string;
  category: string;
  stage: string;
  ask_low_usd: number | null;
  ask_high_usd: number | null;
  committed_usd: number | null;
  pitch: string | null;
  ask_detail?: string | null;
  source_url?: string | null;
  note?: string | null;
  decline_reason: string | null;
  /** The chain's research (packets built from 15 Sep 2026): evidence, the named contact, the ranking. */
  evidence_url?: string | null;
  evidence_note?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  contact_source_url?: string | null;
  fit_argument?: string | null;
  rank?: number | null;
}

interface BudgetLine { key: string; label: string; lowUsd: number; highUsd: number; basis: string }
interface Scenario { sponsors: number; sponsorshipUsd: number; netLowUsd: number; netHighUsd: number; description?: string }
interface SponsorSlot { tier: string; count: number; askUsd: number; gets: string }
interface Structure { slots: SponsorSlot[]; exclusiveUsd: number | null; exclusiveGets: string | null; rationale: string }

interface Economics {
  venueLowUsd: number;
  venueHighUsd: number;
  targetAttendees: number;
  sponsorCount?: number;
  /** The full budget (packets built from 15 Sep 2026); older packets carry only the totals. */
  lines?: BudgetLine[];
  scenarios?: Scenario[];
  sponsorTargetLowUsd: number;
  sponsorTargetHighUsd: number;
  estimatedCostLowUsd: number;
  estimatedCostHighUsd: number;
  netLowUsd: number;
  netHighUsd: number;
  /** The structure priced to cost + the firm's keep (packets built from 15 Sep 2026). */
  structure?: Structure;
  keepTargetUsd?: number;
  requiredUsd?: number;
  reachesKeep?: boolean;
  exclusiveScenario?: Scenario | null;
}

const usd = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

/**
 * THE PDF, FETCHED WITH THE SAME IDENTITY EVERY OTHER CALL USES, then handed to the browser to save.
 * A plain link to the download route works behind Cloudflare Access (cookies) and nowhere the
 * identity is a header — the same finding as DocumentPreview. One way of getting a file, both places.
 */
async function downloadDocument(documentId: string, filename: string): Promise<string | null> {
  const headers: Record<string, string> = {};
  const devUser = getDevUser();
  if (devUser) headers["x-wpos-dev-user"] = devUser;
  try {
    const res = await fetch(`/api/documents/${documentId}/download`, { headers });
    if (!res.ok) return `Could not fetch the packet (HTTP ${res.status}).`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return null;
  } catch (err) {
    return `Could not fetch the packet (${err instanceof Error ? err.message : String(err)}).`;
  }
}

const range = (low: number | null, high: number | null): string => {
  if (low === null && high === null) return "not published";
  if (low !== null && high !== null && low !== high) return `${usd(low)}–${usd(high)}`;
  return usd(low ?? high);
};

/**
 * PLAIN ENGLISH ON SCREEN, THE ENUM IN THE CODE.
 *
 * The page rendered `PROPOSED`, `APPROVED`, `UNVERIFIED` and `IN_CONVERSATION` in capitals — the
 * database's words, shouted. Every branch below still tests the raw string, because that is what
 * the API sends and what it will keep sending; only the label a person reads changes.
 */
const PACKET_STATE: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: "Parker is building it", tone: "help-tag help-tag-muted" },
  PROPOSED: { label: "Keep it or dismiss it", tone: "help-tag help-tag-warn" },
  APPROVED: { label: "Approved", tone: "help-tag help-tag-good" },
  SCHEDULED: { label: "On the calendar", tone: "help-tag help-tag-good" },
  DECLINED: { label: "Turned down", tone: "help-tag help-tag-muted" },
};

const VENUE_STATE: Record<string, { label: string; tone: string }> = {
  UNVERIFIED: { label: "Nobody has called yet", tone: "help-tag help-tag-warn" },
  CONFIRMED: { label: "Called and confirmed", tone: "help-tag help-tag-good" },
  WRONG: { label: "Details were wrong", tone: "help-tag help-tag-muted" },
  UNREACHABLE: { label: "Could not reach them", tone: "help-tag help-tag-muted" },
};

/** Where a sponsor conversation has got to, said the way a partner would say it. */
const SPONSOR_STAGES = [
  { key: "IDENTIFIED", label: "On the list" },
  { key: "RESEARCHING", label: "Being researched" },
  { key: "DRAFTED", label: "Approach drafted" },
  { key: "SENT", label: "Approach sent" },
  { key: "IN_CONVERSATION", label: "In conversation" },
  { key: "COMMITTED", label: "Committed" },
  { key: "DECLINED", label: "Said no" },
  { key: "PARKED", label: "Parked for now" },
] as const;

const CATEGORIES = [
  { key: "CLOUD", label: "Cloud" },
  { key: "FINTECH_SPEND", label: "Spend and fintech" },
  { key: "EQUITY_CAPTABLE", label: "Cap table and equity" },
  { key: "LEGAL", label: "Legal" },
  { key: "PAYROLL_HR", label: "Payroll and HR" },
  { key: "BANKING", label: "Banking" },
  { key: "HOSPITALITY", label: "Hospitality" },
  { key: "RECRUITING", label: "Recruiting" },
  { key: "OTHER", label: "Something else" },
] as const;

const TIERS = [
  { key: "PRESENTING", label: "Presenting" },
  { key: "SUPPORTING", label: "Supporting" },
  { key: "IN_KIND", label: "In kind" },
] as const;

const stageLabel = (key: string): string =>
  SPONSOR_STAGES.find((s) => s.key === key)?.label ?? key.replace(/_/g, " ").toLowerCase();
const categoryLabel = (key: string): string =>
  CATEGORIES.find((c) => c.key === key)?.label ?? key.replace(/_/g, " ").toLowerCase();
const tierLabel = (key: string): string =>
  TIERS.find((t) => t.key === key)?.label ?? key.replace(/_/g, " ").toLowerCase();
/** DEEP_WORK is a format, not a shout. */
const formatLabel = (key: string): string => key.replace(/_/g, " ").toLowerCase();

export function RoomsPage(): JSX.Element {
  const packets = useApi<{ packets: PacketRow[] }>("/api/rooms/packets");
  const sponsors = useApi<{ sponsors: SponsorRow[]; committedUsd: number }>("/api/sponsors");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /*
   * TWO DOORS, ONE QUEUE. Operator, 15 Sep 2026: "basically the 'ask parker for a room' flow needs to
   * change where i can input what im thinking and he use my initial suggestions… i like that he can
   * think of a room on demand but i need to be able to do that OR ask for a specific type of room."
   *
   * An empty body is "Parker, think of one". A body with her brief is her Room, built to her
   * audience, month, city and named sponsors, and the packet records that it came from her. Both
   * land in the same list above, and both are emailed to the partners when built.
   */
  async function propose(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const res = await api<{ packet: PacketRow; queued: boolean; error?: string; detail?: string }>(
      "/api/rooms/packets", { method: "POST", body },
    );
    setBusy(false);
    packets.reload();
    if (res.status === 201 && res.data) {
      setMessage(
        res.data.queued
          ? "On Parker's desk. He runs the chain a stage every few minutes — sponsors with evidence, three concepts, venues, the packet, the PDF — and emails both partners when it lands, usually within the hour. The card below says which stage he is on."
          : `That Room is already ${(PACKET_STATE[res.data.packet.status]?.label ?? res.data.packet.status).toLowerCase()}: ${res.data.packet.title}.`,
      );
      return true;
    }
    setMessage(`Parker could not take that request (${res.data?.detail ?? res.status}).`);
    return false;
  }

  async function decide(id: string, decision: "APPROVED" | "DECLINED"): Promise<void> {
    const body: Record<string, unknown> = { decision };
    if (decision === "DECLINED") {
      // The note is what makes the shelf useful: "rooms we turned down need more info".
      const note = window.prompt("Why not? One line — it is shown on the shelf and given to Parker if you ask again.");
      if (note === null) return;
      if (note.trim()) body.note = note.trim();
    }
    const res = await api(`/api/rooms/packets/${id}/decide`, { method: "POST", body });
    if (res.status !== 200) setMessage(`Could not record that decision (${res.status}).`);
    packets.reload();
  }

  const [again, setAgain] = useState<PacketRow | null>(null);

  const all = packets.data?.packets ?? [];
  /*
   * A DECLINED PROPOSAL DOES NOT VANISH. Operator: "declined proposals should go somewhere after
   * they are declined, somewhere below greyed out."
   *
   * Same reasoning as the passed pile on Dealflow: what the firm turned down is one of the more
   * useful things it owns. Parker proposes a Room a month and most are declined by design, so a
   * list that silently drops them loses the record of what was considered — and the same idea
   * arriving again in March has nothing to be checked against.
   *
   * Below and greyed rather than in a separate view: it is history, so it should not compete with
   * what is live, and it should not be somewhere you have to remember to go and look.
   */
  const live = all.filter((p) => p.status !== "DECLINED");
  const declined = all.filter((p) => p.status === "DECLINED");
  const waiting = live.filter((p) => p.status === "PROPOSED" || p.status === "DRAFT");

  return (
    <section data-testid="rooms-page">
      <h3>Rooms we could run</h3>

      {/* The stance, in one line, where it constrains the decision being made. In full at the end. */}
      <p className="muted">
        {EVENT_ETHOS.stance} {EVENT_ETHOS.notThis.join(" ")} A Room is one evening built around one
        real question, for 25–35 people. Parker proposes at least one a month and you will run far
        fewer than are proposed — that is the point.
      </p>

      {message && <p className="notice" data-testid="rooms-message" role="status">{message}</p>}

      {packets.loading && <p className="state-empty">Reading what Parker has proposed…</p>}

      {!packets.loading && live.length === 0 && (
        <p className="state-empty" data-testid="rooms-empty">
          Nothing is proposed. Ask Parker for one below, or switch on <strong>Monthly Room
          proposal</strong> in Scheduled work and he will put one here each month.
        </p>
      )}

      {live.map((p) => (
        <RoomProposal key={p.id} packet={p} onDecide={decide} onChanged={() => packets.reload()} />
      ))}

      {waiting.length > 0 && (
        <p className="muted small">
          {waiting.length} waiting on a decision.
        </p>
      )}

      <RequestRoom
        busy={busy}
        again={again}
        onClearAgain={() => setAgain(null)}
        onSubmit={async (body) => {
          const ok = await propose(body);
          if (ok) setAgain(null);
          return ok;
        }}
      />

      <h3>Rooms we turned down</h3>
      <div className="declined-shelf" data-testid="declined-proposals">
        <p className="muted small">
          Kept because the same idea will be proposed again, and knowing it was already considered is
          the useful part.
        </p>
        {declined.length === 0 ? (
          <p className="state-empty">
            Nothing has been turned down yet. Declining a Room above moves it here rather than
            deleting it.
          </p>
        ) : (
          <ul className="card-list small">
            {declined.map((p) => {
              const b = briefOf(p);
              return (
                <li key={p.id} data-testid={`declined-${p.id}`}>
                  <strong>{p.title}</strong>
                  <span className="muted">
                    {" "}
                    — proposed for {monthWord(p.proposed_for_month)}
                    {p.origin === "PARTNER_BRIEF" ? ", asked for by a partner" : ", Parker's idea"}
                    {p.decided_by ? `, turned down by ${p.decided_by}` : ""}
                  </span>
                  {/* THE SUBSTANCE. Operator: "rooms we turned down need more info so i can see how
                      much was proposed and what the event was about and types of people to be
                      invited." A title and a month is a filing label, not a record. */}
                  <div className="small">
                    {p.central_question ? <>“{p.central_question}” · </> : null}
                    {p.theme}
                  </div>
                  <div className="small">
                    <strong>Who was to be invited:</strong> {p.audience ?? b?.audience ?? <span className="muted">not recorded</span>}
                  </div>
                  <div className="small">
                    <strong>Sponsorship proposed:</strong>{" "}
                    {p.sponsor_count > 0
                      ? `${usd(p.sponsor_total_usd)} from ${p.sponsor_count} sponsor${p.sponsor_count === 1 ? "" : "s"}`
                      : p.status === "DECLINED" && p.build_error
                        ? <span className="muted">never built — {p.build_error}</span>
                        : <span className="muted">none stated</span>}
                  </div>
                  <div className="small">
                    <strong>Why we said no:</strong>{" "}
                    {p.decision_note ?? <span className="muted">no reason was written down</span>}
                  </div>
                  <div className="form-row">
                    <button type="button" onClick={() => setAgain(p)} data-testid={`again-${p.id}`}>
                      Propose again with changes
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <SponsorPipeline
        sponsors={sponsors.data?.sponsors ?? []}
        committedUsd={sponsors.data?.committedUsd ?? 0}
        loading={sponsors.loading}
        onChanged={() => sponsors.reload()}
      />

      {/* Events fold in here rather than living on their own tab. A Room IS an event, and two tabs
          for one idea made the operator choose between them every time. The distinction that
          matters is not Rooms-versus-Events but proposed-versus-happened: above is the Room being
          planned, below is the firm's record of what actually took place. It renders its own h3
          sections at this level — it used to be mounted inside a subsection, two ranks down. */}
      <EventsPage />

      <Programme />

      {/* The detailed version, at the bottom, for someone already working. Covers both halves of the
          page because they are one page now. */}
      <HowThisWorks
        title="Events & Rooms"
        what="Rooms are West Peek's curated gatherings — a dinner, salon or workshop for 25–35 people built around one real question. They are how members build deeper relationships, and they are the part of the community that earns money through sponsors. Everything the firm has gathered, Room or not, is recorded here too."
        when="Once a month, when you are choosing what to run next, when you are working a sponsor, or just after a gathering has happened."
        operatorDoes={[
          "Ask Parker for a Room — your audience, month, city and named sponsors — or let him think of one",
          "Read the packet and keep it, or dismiss it with a line saying why",
          "Call a venue and mark it confirmed, wrong or unreachable",
          "Put a gathering on the record, and move it through its life",
          "Close out a gathering that has happened — who came, and what we said we would do",
          "Move a sponsor along, and record what they committed",
        ]}
        aiDoes={[
          "Parker builds the Room you asked for, or proposes one for next month, as a chain: who pays to be in front of this audience (with evidence and the named person who runs their partnerships), three concepts compared and one chosen, venues with a reason, the run of show to the minute, the budget with its basis, a sponsorship structure priced to cost plus the firm's keep, the pitch email — and a PDF emailed to both partners",
          "Parker reads the firm's own list and says whether it can fill the room before you commit",
          "Parker finds candidate venues by live search and reads prices off the page it cites",
          "Parker reads close-out notes and turns what West Peek committed to into assigned work",
          // Parker, not Wynn: that seat was retired in the cull and `brand_sponsorship_revenue` sits
          // on Parker now. Naming a colleague who no longer exists tells a partner to go and find
          // somebody who is not there.
          "Parker keeps the sponsor pipeline and drafts the approach",
        ]}
        requiresOperator={[
          "Approving a Room — it commits the firm to spend and to approaching sponsors in its name",
          "Confirming a venue, which means having actually called it",
          "Recording a sponsor commitment, because it puts real money into a budget",
          "Inviting anyone. Sending outside the firm needs an approval card; recording an attendee here does not contact them.",
        ]}
        next="An approved Room becomes an event you can add attendees to. After it runs, its close-out records who came and what came out of it."
        blocked={[
          "No venues found: live search may be off, or nothing in that city was sourceable. The Room is still proposable — a person finds the space.",
          "A sponsor is refused when another sponsor already holds its category for that Room.",
          "Attendee lists are never shared with a sponsor. Sponsors get aggregate counts.",
          "Recording a gathering needs the event.manage action in your role.",
        ]}
        testId="rooms"
      />
    </section>
  );
}

/**
 * One proposed Room, open.
 *
 * IT USED TO BE AN ACCORDION and everything below the title — the question, the audience, the
 * venues, the economics, and both decision buttons — existed only for a reader who guessed that a
 * row was clickable. A partner is being asked to approve firm spend; the case for it cannot be
 * behind a disclosure they have to find.
 *
 * The agenda is the one thing still folded, because it is a run-of-show several hundred words long
 * and it is read on the night rather than at the decision. It has a visible summary, so it is a
 * labelled door rather than a guess.
 */
function RoomProposal(props: {
  packet: PacketRow;
  onDecide: (id: string, decision: "APPROVED" | "DECLINED") => Promise<void>;
  onChanged: () => void;
}): JSX.Element {
  const p = props.packet;
  const [pdfProblem, setPdfProblem] = useState<string | null>(null);
  const detail = useApi<{
    packet: PacketRow & { agenda_md: string | null; seed_questions_json: string; guest_ideas_json: string; audience: string | null; risks_json: string; commitment_md: string | null; concepts_json?: string; concept_choice_md?: string | null; run_of_show_json?: string; pitch_email_json?: string | null; invite_check_json?: string | null };
    brief: Brief | null;
    venues: VenueRow[];
    sponsors: SponsorRow[];
    // Re-read when the row's status changes: a card first drawn while Parker was still building
    // (DRAFT) fetched an empty packet, and without this it kept showing "none suggested" after the
    // build finished — seen in production on the first run, 15 Sep 2026.
  }>(`/api/rooms/packets/${p.id}`, [p.id, p.status]);
  const brief = briefOf(p);

  const state = PACKET_STATE[p.status] ?? { label: p.status.toLowerCase(), tone: "help-tag help-tag-muted" };

  let economics: Economics | null = null;
  try { economics = JSON.parse(p.economics_json) as Economics; } catch { economics = null; }

  const d = detail.data;
  const seedQuestions: string[] = d ? safeList<string>(d.packet.seed_questions_json) : [];
  const guestIdeas = d ? safeList<{ description: string; why: string | null }>(d.packet.guest_ideas_json) : [];
  const risks: string[] = d ? safeList<string>(d.packet.risks_json ?? "[]") : [];
  const concepts: Concept[] = d ? safeList<Concept>(d.packet.concepts_json ?? "[]") : [];
  const runOfShow: RunOfShowLine[] = d ? safeList<RunOfShowLine>(d.packet.run_of_show_json ?? "[]") : [];
  const chosenConcept = concepts.find((c) => c.chosen) ?? null;
  let inviteCheck: InviteCheck | null = null;
  try { inviteCheck = d?.packet.invite_check_json ? (JSON.parse(d.packet.invite_check_json) as InviteCheck) : null; } catch { inviteCheck = null; }
  let pitchEmail: PitchEmail | null = null;
  try { pitchEmail = d?.packet.pitch_email_json ? (JSON.parse(d.packet.pitch_email_json) as PitchEmail) : null; } catch { pitchEmail = null; }

  // A DRAFT is a request Parker has not finished. It shows what was asked and where the build is,
  // and nothing else — there is no packet to read yet.
  if (p.status === "DRAFT") {
    return (
      <article className="card" data-testid={`packet-${p.id}`}>
        <div className="card-head-static">
          <h4>{p.title}</h4>
          <span className={state.tone} data-testid={`packet-state-${p.id}`}>{state.label}</span>
        </div>
        <p className="muted small">For {monthWord(p.proposed_for_month)}{brief?.city ? ` · ${brief.city}` : ""}</p>
        {brief && <BriefBlock brief={brief} />}
        <p className="small" data-testid={`build-stage-${p.id}`}>
          <strong>Stage {Math.max(1, BUILD_STAGES.indexOf((p.build_stage === "QUEUED" ? "DISCOVER" : p.build_stage ?? "DISCOVER") as (typeof BUILD_STAGES)[number]) + 1)} of {BUILD_STAGES.length}:</strong>{" "}
          {STAGE_LABELS[p.build_stage ?? "QUEUED"] ?? p.build_stage}.
          {p.work_card_id ? " The card is on Parker's desk on Work; the sweep advances it every few minutes." : " Parker's card opens on the next tick of the Rooms job."}
        </p>
        {p.build_error ? (
          <p className="notice notice-gate small" data-testid={`build-error-${p.id}`}>
            Parker could not finish that stage (attempt {p.build_attempts}): {p.build_error}. The sweep retries the
            same stage, up to three times; after that the card is blocked and waits for you to ask again or dismiss it.
          </p>
        ) : (
          <p className="state-empty">Parker is building this Room. Every stage he finishes is kept, so a retried tick picks up where he left off. It lands here, and in both partners' inboxes with the PDF, when the chain is done.</p>
        )}
        <div className="form-row">
          <button type="button" onClick={() => props.onDecide(p.id, "DECLINED")} data-testid={`decline-${p.id}`}>
            Dismiss the request
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="card" data-testid={`packet-${p.id}`}>
      <div className="card-head-static">
        <h4>{p.title}</h4>
        <span className={state.tone} data-testid={`packet-state-${p.id}`}>{state.label}</span>
      </div>
      <p className="muted small">
        For {p.proposed_for_month} · {formatLabel(p.format)} · {p.target_min}–{p.target_max} people ·{" "}
        {p.theme}
      </p>

      {p.central_question && <p>“{p.central_question}”</p>}

      <p className="muted small" data-testid={`origin-${p.id}`}>
        {p.origin === "PARTNER_BRIEF" ? "Asked for by a partner — Parker built it to the brief below." : "Parker's own idea for the month."}
        {p.emailed_at ? " Emailed to both partners." : ""}
      </p>
      {brief && <BriefBlock brief={brief} />}

      <p className="form-row" data-testid={`packet-pdf-${p.id}`}>
        {p.document_id ? (
          <>
            <button
              type="button"
              className="btn-strong"
              data-testid={`download-packet-${p.id}`}
              onClick={async () => {
                const problem = await downloadDocument(p.document_id!, `west-peek-room-${p.proposed_for_month}-${p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}.pdf`);
                setPdfProblem(problem);
              }}
            >
              Download the packet (PDF)
            </button>
            {pdfProblem && <span className="muted small">{pdfProblem}</span>}
          </>
        ) : (
          <span className="muted small">No PDF for this one — it was built before packets were rendered, or the browser was not available. The whole packet is below and in the email.</span>
        )}
      </p>

      {p.pushback_md && (
        <div className="notice notice-gate small" data-testid={`pushback-${p.id}`}>
          <strong>Where Parker pushes back:</strong> {p.pushback_md}
        </div>
      )}

      {detail.loading && <p className="state-empty">Reading the packet…</p>}

      {!detail.loading && !d && (
        <p className="state-empty">
          The packet behind this Room could not be loaded, so the question, venues and costs are not
          shown. The decision below still works; the case for it does not.
        </p>
      )}

      {d && (
        <>
          {/* Open by default: the one thing a partner reads before deciding whether to read on. */}
          <p className="small">
            <strong>Who should be in the room:</strong>{" "}
            {d.packet.audience ?? <span className="muted">Parker did not say. Decide who this is for before you invite anybody.</span>}
          </p>

          {/* EVERYTHING ELSE FOLDS. Operator, 15 Sep 2026: "each of its subheadings need to be
              collapsable with an arrow… it takes up too much space when things aren't collapsable
              and becomes too busy." Each summary line carries the one number that matters, so a
              closed packet still reads as a packet and not as a list of doors. */}
          <Fold title="The concept, and the two it beat" fact={concepts.length === 0 ? "built before Parker compared concepts" : `${chosenConcept?.title ?? "chosen"} over ${concepts.length - 1} other${concepts.length === 2 ? "" : "s"}`} testId={`fold-concepts-${p.id}`}>
            {concepts.length === 0 ? (
              <p className="state-empty">This packet was built in one pass, before Parker ideated three concepts and chose. Ask again to get the comparison.</p>
            ) : (
              <>
                <table data-testid={`packet-concepts-${p.id}`}>
                  <thead><tr><th>Concept</th><th>Tone</th><th>Value to the sponsor</th><th>Who it fits</th><th>Cost band</th></tr></thead>
                  <tbody>
                    {concepts.map((c) => (
                      <tr key={c.title}>
                        <th scope="row">{c.title}{c.chosen && <span className="help-tag help-tag-good"> chosen</span>}<div className="muted small">{formatLabel(c.format)} · {c.signatureMoment}</div></th>
                        <td className="small">{c.tone}</td><td className="small">{c.valueToSponsor}</td><td className="small">{c.whoItFits}</td><td className="small">{c.costBand}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.packet.concept_choice_md && <p className="small"><strong>Why this one:</strong> {d.packet.concept_choice_md}</p>}
              </>
            )}
          </Fold>

          <Fold title="Can our own list fill it?" fact={inviteCheck ? `${inviteCheck.verdict.replace(/_/g, " ").toLowerCase()} — ${inviteCheck.matchingCount} of ${inviteCheck.totalContacts} contacts match` : "not checked"} testId={`fold-invite-${p.id}`}>
            {!inviteCheck ? (
              <p className="state-empty">Parker did not read the firm's list for this one. Assume the guest list is a build project.</p>
            ) : (
              <>
                <p className="small">{inviteCheck.matchingCount} of {inviteCheck.totalContacts} contacts in the firm's records read as {inviteCheck.matchedOn.join(" / ")}. {inviteCheck.note}</p>
                {inviteCheck.archetypes.length > 0 && <p className="small"><strong>Already on the list:</strong> {inviteCheck.archetypes.join("; ")}</p>}
                {inviteCheck.namedFromRecords.length > 0 && <p className="muted small">A starting list, from our own records: {inviteCheck.namedFromRecords.join(", ")}</p>}
              </>
            )}
          </Fold>

          <Fold title="Questions to seed it with" fact={seedQuestions.length === 0 ? "none suggested" : `${seedQuestions.length} question${seedQuestions.length === 1 ? "" : "s"}`} testId={`fold-questions-${p.id}`}>
            {seedQuestions.length === 0 ? (
              <p className="state-empty">None suggested. A Room with no opening question becomes a networking event.</p>
            ) : (
              <ul className="card-list small">{seedQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
            )}
          </Fold>

          <Fold title="Guests worth asking" fact={guestIdeas.length === 0 ? "none suggested" : `${guestIdeas.length} archetype${guestIdeas.length === 1 ? "" : "s"}`} testId={`fold-guests-${p.id}`}>
            {guestIdeas.length === 0 ? (
              <p className="state-empty">None suggested. The guest list is yours to build.</p>
            ) : (
              <ul className="card-list small">
                {guestIdeas.map((g) => (
                  <li key={g.description}>{g.description}{g.why ? <span className="muted"> — {g.why}</span> : null}</li>
                ))}
              </ul>
            )}
          </Fold>

          <Fold title="Run of show" fact={runOfShow.length > 0 ? `${runOfShow.length} lines, ${runOfShow[0]!.time} to ${runOfShow[runOfShow.length - 1]!.time}` : d.packet.agenda_md ? `${formatLabel(p.format)}, ${p.target_min}–${p.target_max} people` : "no run of show written"} testId={`fold-agenda-${p.id}`}>
            {runOfShow.length > 0 ? (
              <table data-testid={`packet-ros-${p.id}`}>
                <thead><tr><th>Time</th><th>Min</th><th>What happens</th><th>Who</th></tr></thead>
                <tbody>
                  {runOfShow.map((l, i) => (
                    <tr key={`${l.time}-${i}`}><th scope="row">{l.time}</th><td>{l.minutes || ""}</td><td className="small">{l.what}</td><td className="muted small">{l.who}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : d.packet.agenda_md ? (
              <p className="small" style={{ whiteSpace: "pre-wrap" }}>{d.packet.agenda_md}</p>
            ) : (
              <p className="state-empty">Parker wrote no run of show. The evening has no shape yet.</p>
            )}
          </Fold>

          <Fold
            title="Where it could be held"
            fact={d.venues.length === 0 ? "no venue survived sourcing" : `${d.venues.length} venue${d.venues.length === 1 ? "" : "s"}, est. ${venueSpan(d.venues)}`}
            testId={`fold-venues-${p.id}`}
          >
            {d.venues.length === 0 ? (
              <p className="state-empty">
                No venue survived sourcing, so a person needs to find the space. That is a search
                problem, not a reason to drop the Room.
              </p>
            ) : (
              <ul className="card-list">
                {d.venues.map((v) => (
                  <Venue key={v.id} venue={v} onChanged={() => { detail.reload(); props.onChanged(); }} />
                ))}
              </ul>
            )}
          </Fold>

          <Fold
            title="Who pays for it"
            fact={`${p.sponsor_count} sponsor${p.sponsor_count === 1 ? "" : "s"}, ${usd(p.sponsor_total_usd)} asked`}
            testId={`fold-sponsors-${p.id}`}
          >
            <p className="muted small">{p.sponsor_count} slot{p.sponsor_count === 1 ? "" : "s"}, {usd(p.sponsor_total_usd)} if all land — the structure is under “What it costs”. Ranked: approach the first one first.</p>
            {d.sponsors.length === 0 ? (
              <p className="state-empty">Parker named nobody to approach. A Room with no prospect is spend the fund carries alone.</p>
            ) : (
              <ul className="card-list small" data-testid={`packet-sponsors-${p.id}`}>
                {d.sponsors.map((sp) => (
                  <li key={sp.id}>
                    <strong>{sp.rank ? `${sp.rank}. ` : ""}{sp.org_name}</strong>
                    <span className="muted"> · {categoryLabel(sp.category)} · {tierLabel(sp.tier)} · ask {usd(sp.ask_low_usd)}</span>
                    {(brief?.sponsorProspects ?? []).some((n) => sameOrg(n, sp.org_name)) && <span className="help-tag help-tag-muted"> named by you</span>}
                    <div>
                      <strong>Evidence they sponsor:</strong>{" "}
                      {sp.evidence_url ?? sp.source_url
                        ? <>{sp.evidence_note ? `${sp.evidence_note} — ` : ""}<a href={sp.evidence_url ?? sp.source_url ?? undefined} target="_blank" rel="noreferrer noopener">{(sp.evidence_url ?? sp.source_url ?? "").replace(/^https?:\/\//, "").slice(0, 70)}</a></>
                        : <span className="help-tag help-tag-warn">none found on a public page — not a qualified prospect yet</span>}
                    </div>
                    <div>
                      <strong>Who runs partnerships:</strong>{" "}
                      {sp.contact_name
                        ? <>{sp.contact_name}{sp.contact_title ? `, ${sp.contact_title}` : ""}{sp.contact_source_url && <> — <a href={sp.contact_source_url} target="_blank" rel="noreferrer noopener">read from this page</a></>}</>
                        : <span className="muted">no named contact on a public page — a person finds one</span>}
                    </div>
                    <div>{sp.fit_argument ?? sp.ask_detail ?? <span className="muted">Parker did not say why they fit.</span>}</div>
                    {sp.pitch && <div className="muted">Open with: {sp.pitch}</div>}
                    {sp.note && !sp.note.startsWith("Found by Parker") && !sp.note.startsWith("Named by the partner in her brief.") && <div className="muted">{sp.note}</div>}
                  </li>
                ))}
              </ul>
            )}
            {p.sponsor_thesis && (
              <p className="small"><strong>Why a sponsor underwrites this:</strong> {p.sponsor_thesis}</p>
            )}
          </Fold>

          <Fold
            title="What it costs, and what is left"
            fact={economics ? `${usd(economics.estimatedCostLowUsd)}–${usd(economics.estimatedCostHighUsd)} all-in; ${usd(economics.netLowUsd)} to ${usd(economics.netHighUsd)} left` : "not costed"}
            testId={`fold-budget-${p.id}`}
          >
            <Budget economics={economics} />
          </Fold>

          <Fold title="The pitch — a draft for Sequoia to send" fact={pitchEmail ? `to ${pitchEmail.to.slice(0, 60)}` : "not drafted"} testId={`fold-pitch-${p.id}`}>
            {pitchEmail ? (
              <div className="card small" data-testid={`packet-pitch-${p.id}`}>
                <p className="muted">To: {pitchEmail.to}</p>
                <p><strong>{pitchEmail.subject}</strong></p>
                <p style={{ whiteSpace: "pre-wrap" }}>{pitchEmail.body}</p>
                <p className="muted">Nothing has been sent. Copy it, edit it, send it from your own account.</p>
              </div>
            ) : (
              <p className="state-empty">Parker did not draft the approach. The first sponsor conversation starts from a blank page.</p>
            )}
          </Fold>

          <Fold title="What could go wrong" fact={risks.length === 0 ? "no risks named" : `${risks.length} risk${risks.length === 1 ? "" : "s"}`} testId={`fold-risks-${p.id}`}>
            {risks.length === 0 ? (
              <p className="state-empty">Parker named no risks. Assume there are some.</p>
            ) : (
              <ul className="card-list small">{risks.map((r) => <li key={r}>{r}</li>)}</ul>
            )}
          </Fold>

          <Fold title="What keeping it commits the firm to" fact={d.packet.commitment_md ? "spend, time and approaches in the firm's name" : "Parker did not say"} testId={`fold-commitment-${p.id}`}>
            {d.packet.commitment_md ? (
              <p className="small" style={{ whiteSpace: "pre-wrap" }}>{d.packet.commitment_md}</p>
            ) : (
              <p className="state-empty">Parker did not say. Decide what you are agreeing to before you keep it.</p>
            )}
          </Fold>
        </>
      )}

      {p.status === "PROPOSED" && (
        <div className="form-row">
          <button type="button" className="btn-strong" onClick={() => props.onDecide(p.id, "APPROVED")} data-testid={`approve-${p.id}`}>
            Keep this Room
          </button>
          <button type="button" onClick={() => props.onDecide(p.id, "DECLINED")} data-testid={`decline-${p.id}`}>
            Dismiss it
          </button>
          <span className="muted small">It is just a packet with a suggestion. Dismissing keeps it, greyed, further down this page.</span>
        </div>
      )}
      {p.status === "APPROVED" && (
        <p className="muted small">
          Approved{p.decided_by ? ` by ${p.decided_by}` : ""}. It is not on the calendar until it has
          a date — put it on the record below, with the date, and it becomes a gathering people can
          be added to.
        </p>
      )}
      {p.status === "SCHEDULED" && (
        <p className="muted small">On the calendar. It appears in the record of gatherings below.</p>
      )}
    </article>
  );
}

/** What she asked for, shown on the packet beside what Parker made of it. */
function BriefBlock({ brief }: { brief: Brief }): JSX.Element {
  return (
    <div className="card" data-testid="packet-brief">
      <p className="small"><strong>What was asked for</strong></p>
      <p className="small">{brief.audience}{brief.city ? ` · ${brief.city}` : ""}{brief.month ? ` · ${monthWord(brief.month)}` : ""}</p>
      {brief.sponsorProspects.length > 0 && (
        <p className="small"><strong>Sponsors named:</strong> {brief.sponsorProspects.join(", ")}</p>
      )}
      {brief.notes && <p className="muted small">{brief.notes}</p>}
    </div>
  );
}

/**
 * The request door.
 *
 * Operator: "i can input what im thinking and he use my initial suggestions". The fields are her
 * brief — audience or theme, month, city, sponsors she has in mind, notes — and the button beside
 * it is the old door, kept: "i like that he can think of a room on demand". When a declined Room is
 * being proposed again, the form is prefilled from it and carries the link.
 */
function RequestRoom(props: {
  busy: boolean;
  again: PacketRow | null;
  onClearAgain: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}): JSX.Element {
  const [audience, setAudience] = useState("");
  const [month, setMonth] = useState(monthPlus(1));
  const [city, setCity] = useState("New York");
  const [sponsors, setSponsors] = useState("");
  const [notes, setNotes] = useState("");
  const [seededFrom, setSeededFrom] = useState<string | null>(null);

  // Prefill from the declined packet once per "propose again" click, not on every render.
  if (props.again && seededFrom !== props.again.id) {
    const b = briefOf(props.again);
    setAudience(b?.audience ?? props.again.audience ?? props.again.theme);
    setMonth(props.again.proposed_for_month >= monthPlus(0) ? props.again.proposed_for_month : monthPlus(1));
    setCity(b?.city ?? "New York");
    setSponsors((b?.sponsorProspects ?? []).join(", "));
    setNotes(
      `Reworking "${props.again.title}"${props.again.decision_note ? ` — we said no because: ${props.again.decision_note}` : ""}. Change: `,
    );
    setSeededFrom(props.again.id);
  }

  async function submit(): Promise<void> {
    const ok = await props.onSubmit({
      audience: audience.trim(),
      month,
      city: city.trim() || undefined,
      sponsor_prospects: sponsors.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean),
      notes: notes.trim() || undefined,
      again_from: props.again?.id,
    });
    if (ok) {
      setAudience("");
      setSponsors("");
      setNotes("");
      setSeededFrom(null);
    }
  }

  return (
    <div className="card" data-testid="request-room">
      <h4>{props.again ? `Propose "${props.again.title}" again, with changes` : "Ask Parker for a Room"}</h4>
      <p className="muted small">
        Say what you are thinking and he builds it from your suggestions: who should be in the room,
        the month, the city, and any sponsor you already have in mind. A sponsor you name is a seed —
        he researches it, finds others, and ranks them all with evidence and a named contact. He
        compares three concepts, picks one, prices the sponsorship to cover the cost plus the firm's
        keep, and emails both partners the packet as a PDF. Nothing is booked and nobody outside the
        firm is contacted.
      </p>
      <div className="form-row">
        <label>
          Audience or theme{" "}
          <input
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            placeholder="top Black lawyers on the rise"
            data-testid="room-audience"
            style={{ minWidth: "18rem" }}
          />
        </label>
        <label>
          Month{" "}
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="room-month" />
        </label>
        <label>
          City{" "}
          <input value={city} onChange={(e) => setCity(e.target.value)} data-testid="room-city" />
        </label>
      </div>
      <div className="form-row">
        <label>
          Sponsor prospects you have in mind{" "}
          <input
            value={sponsors}
            onChange={(e) => setSponsors(e.target.value)}
            placeholder="Harvey AI (harvey.ai), Carta"
            data-testid="room-sponsors"
            style={{ minWidth: "18rem" }}
          />
        </label>
        <label>
          Notes{" "}
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="anything Parker should know" data-testid="room-notes" style={{ minWidth: "18rem" }} />
        </label>
      </div>
      <div className="form-row">
        <button
          type="button"
          className="btn-strong"
          onClick={submit}
          disabled={props.busy || audience.trim().length < 3 || !/^\d{4}-\d{2}$/.test(month)}
          data-testid="request-room-submit"
        >
          {props.busy ? "Parker is working…" : props.again ? "Ask Parker to propose it again" : "Ask Parker for this Room"}
        </button>
        {props.again ? (
          <button type="button" onClick={() => { props.onClearAgain(); setSeededFrom(null); setAudience(""); setSponsors(""); setNotes(""); }}>
            Never mind
          </button>
        ) : (
          <button type="button" onClick={() => void props.onSubmit({ month })} disabled={props.busy} data-testid="propose-room">
            Or let Parker think of one
          </button>
        )}
        <span className="muted small">Lands within the hour: the chain runs a stage every few minutes on Parker's desk, and the card below says where he is.</span>
      </div>
    </div>
  );
}

/**
 * One folded subsection of a packet. The summary carries the fact that matters, so a partner can
 * decide from the closed packet and open only what she wants to check.
 */
function Fold(props: { title: string; fact: string; testId: string; children: React.ReactNode }): JSX.Element {
  return (
    <details className="packet-fold" data-testid={props.testId}>
      <summary>
        <strong>{props.title}</strong>
        <span className="muted small"> — {props.fact}</span>
      </summary>
      {props.children}
    </details>
  );
}

/** Cheapest low to dearest high across the venue estimates. */
function venueSpan(venues: VenueRow[]): string {
  const lows = venues.map((v) => v.estimate_low_usd ?? v.price_low_usd).filter((n): n is number => typeof n === "number");
  const highs = venues.map((v) => v.estimate_high_usd ?? v.price_high_usd).filter((n): n is number => typeof n === "number");
  if (lows.length === 0 || highs.length === 0) return "not costed";
  return `${usd(Math.min(...lows))}–${usd(Math.max(...highs))}`;
}

/**
 * The full budget, "from the POV of a senior event designer and coordinator": every line with its
 * basis, the total, and what is left at one, two and four sponsors. An older packet with only the
 * totals still renders them.
 */
function Budget({ economics }: { economics: Economics | null }): JSX.Element {
  if (!economics) return <p className="state-empty">Parker did not cost this one. Keeping it commits spend nobody has sized.</p>;
  const lines = economics.lines ?? [];
  return (
    <>
      {lines.length > 0 ? (
        <table data-testid="packet-budget">
          <thead>
            <tr><th>Line</th><th>Low</th><th>High</th><th>Basis</th></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <th scope="row">{l.label}</th>
                <td>{usd(l.lowUsd)}</td>
                <td>{usd(l.highUsd)}</td>
                <td className="muted small">{l.basis}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Total at {economics.targetAttendees} people</th>
              <td><strong>{usd(economics.estimatedCostLowUsd)}</strong></td>
              <td><strong>{usd(economics.estimatedCostHighUsd)}</strong></td>
              <td className="muted small">lines plus contingency</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <table>
          <tbody>
            <tr><th scope="row">Venue</th><td>{usd(economics.venueLowUsd)}–{usd(economics.venueHighUsd)}</td></tr>
            <tr><th scope="row">Estimated cost</th><td>{usd(economics.estimatedCostLowUsd)}–{usd(economics.estimatedCostHighUsd)} at {economics.targetAttendees} people</td></tr>
          </tbody>
        </table>
      )}
      {economics.structure && economics.structure.slots.length > 0 && (
        <div data-testid="packet-structure">
          <p className="small"><strong>How the sponsorship is structured:</strong> {economics.structure.rationale}</p>
          <table>
            <thead><tr><th>Slot</th><th>How many</th><th>Ask</th><th>What they get</th></tr></thead>
            <tbody>
              {economics.structure.slots.map((sl) => (
                <tr key={`${sl.tier}-${sl.askUsd}`}><th scope="row">{tierLabel(sl.tier)}</th><td>{sl.count}</td><td>{usd(sl.askUsd)}</td><td className="muted small">{sl.gets}</td></tr>
              ))}
              {economics.structure.exclusiveUsd && (
                <tr><th scope="row">Exclusive — one sponsor, the whole room</th><td>1</td><td>{usd(economics.structure.exclusiveUsd)}</td><td className="muted small">{economics.structure.exclusiveGets}</td></tr>
              )}
            </tbody>
          </table>
          {typeof economics.requiredUsd === "number" && (
            <p className="small">
              Priced against the high-case cost {usd(economics.estimatedCostHighUsd)} plus the firm's target keep {usd(economics.keepTargetUsd)} = {usd(economics.requiredUsd)}.
              All slots sold bring {usd(economics.sponsorTargetHighUsd)} — {economics.reachesKeep ? "the target is reached." : <span className="muted">short by {usd(economics.requiredUsd - economics.sponsorTargetHighUsd)}; Parker says so rather than rounding.</span>}
            </p>
          )}
        </div>
      )}
      <p className="small">
        <strong>Sponsorship:</strong> {usd(economics.sponsorTargetLowUsd)}–{usd(economics.sponsorTargetHighUsd)} · <strong>Left for the firm:</strong>{" "}
        {usd(economics.netLowUsd)} to {usd(economics.netHighUsd)}
        {economics.netLowUsd < 0 && <span className="muted"> — the first slot alone does not cover the high case</span>}
      </p>
      {economics.scenarios && economics.scenarios.length > 0 ? (
        <ul className="card-list small" data-testid="packet-scenarios">
          {economics.scenarios.map((sc) => (
            <li key={sc.sponsors}>
              At <strong>{sc.sponsors} sponsor{sc.sponsors === 1 ? "" : "s"}</strong>{sc.description ? ` (${sc.description})` : ""} — {usd(sc.sponsorshipUsd)}: {usd(sc.netLowUsd)} to {usd(sc.netHighUsd)} left for the firm
              {sc.netHighUsd < 0 ? <span className="muted"> — does not pay for itself</span> : sc.netLowUsd < 0 ? <span className="muted"> — pays only at the cheap end</span> : null}
            </li>
          ))}
          {economics.exclusiveScenario && (
            <li>With <strong>one exclusive sponsor</strong> — {usd(economics.exclusiveScenario.sponsorshipUsd)}: {usd(economics.exclusiveScenario.netLowUsd)} to {usd(economics.exclusiveScenario.netHighUsd)} left for the firm</li>
          )}
        </ul>
      ) : (
        <p className="muted small">Built before the sponsor scenarios existed; ask Parker again to see what is left as each sponsor lands.</p>
      )}
    </>
  );
}

/** A packet field is JSON written by a model. A malformed one is a missing list, never a crash. */
function safeList<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * One venue.
 *
 * The verification badge is the point of this component. A number nobody has called is shown
 * because it is worth calling, and marked because it is not yet worth trusting.
 */
function Venue(props: { venue: VenueRow; onChanged: () => void }): JSX.Element {
  const v = props.venue;
  const [busy, setBusy] = useState(false);
  const state = VENUE_STATE[v.verification] ?? { label: v.verification.toLowerCase(), tone: "help-tag help-tag-muted" };

  async function mark(verification: "CONFIRMED" | "WRONG" | "UNREACHABLE"): Promise<void> {
    setBusy(true);
    await api(`/api/rooms/venues/${v.id}/verify`, { method: "POST", body: { verification } });
    setBusy(false);
    props.onChanged();
  }

  return (
    <li data-testid={`venue-${v.id}`}>
      <div className="card-head-static">
        <span>
          <strong>{v.name}</strong>
          {v.is_fallback ? <span className="help-tag help-tag-muted"> fallback</span> : null}
          {v.city && <span className="muted"> · {v.city}</span>}
          {v.capacity && <span className="muted"> · holds {v.capacity}</span>}
        </span>
        <span className={state.tone} data-testid={`venue-state-${v.id}`}>{state.label}</span>
      </div>
      {v.why_here && <p className="small">{v.why_here}</p>}
      {/* THE ESTIMATE FIRST. Operator: "no venue is truly $0 and best guesses using comps should be
          used." The published price, where the page states one, follows it. */}
      <p className="small">
        <strong>Est. {range(v.estimate_low_usd ?? v.price_low_usd, v.estimate_high_usd ?? v.price_high_usd)}</strong>
        {v.room_minimum_usd ? <span> · room minimum {usd(v.room_minimum_usd)}</span> : null}
        {v.estimate_basis ? <span className="muted"> — {v.estimate_basis}</span> : <span className="muted"> — estimate not recorded on this older packet</span>}
      </p>
      <p className="small">
        Published: {range(v.price_low_usd, v.price_high_usd)}
        {v.price_note ? <span className="muted"> — {v.price_note}</span> : null}
      </p>
      <p className="small">
        {v.booking_phone && <span>{v.booking_phone} </span>}
        {v.booking_email && <span>{v.booking_email} </span>}
        {!v.booking_phone && !v.booking_email && <span className="muted">No contact on the cited page. </span>}
        <a href={v.source_url} target="_blank" rel="noreferrer noopener">where this came from</a>
      </p>
      {v.verification === "UNVERIFIED" && (
        <p className="notice notice-gate small">
          These details came off the page above and nobody has called yet. Confirm before you build a
          guest list around this room.
        </p>
      )}
      {v.note && <p className="muted small">{v.note}</p>}
      <div className="form-row">
        <button type="button" disabled={busy} onClick={() => mark("CONFIRMED")} data-testid={`confirm-${v.id}`}>I called — confirmed</button>
        <button type="button" disabled={busy} onClick={() => mark("WRONG")}>Details were wrong</button>
        <button type="button" disabled={busy} onClick={() => mark("UNREACHABLE")}>Could not reach them</button>
      </div>
    </li>
  );
}

/**
 * Who is paying for it.
 *
 * The decline reason sits next to a sponsor who said no: why AWS said no is the most useful thing
 * anyone has when preparing the next Room, and it is exactly the detail that gets lost when a row
 * is just moved to a column.
 *
 * The add-a-prospect row moved BELOW the table. It used to sit above it, so the page asked you to
 * type before it told you what was already there.
 */
function SponsorPipeline(props: {
  sponsors: SponsorRow[];
  committedUsd: number;
  loading: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [org, setOrg] = useState("");
  const [tier, setTier] = useState<string>("PRESENTING");
  const [category, setCategory] = useState<string>("CLOUD");
  const [error, setError] = useState<string | null>(null);

  async function add(): Promise<void> {
    setError(null);
    const res = await api<{ detail?: string }>("/api/sponsors", {
      method: "POST", body: { org_name: org, tier, category },
    });
    if (res.status === 201) { setOrg(""); props.onChanged(); }
    else setError(res.data?.detail ?? `Could not add that prospect (${res.status}).`);
  }

  async function move(id: string, stage: string): Promise<void> {
    setError(null);
    const body: Record<string, unknown> = { stage };
    if (stage === "COMMITTED") {
      const amount = window.prompt("How much did they commit, in dollars?");
      if (!amount) return;
      body.committed_usd = Number(amount);
    }
    if (stage === "DECLINED") {
      const reason = window.prompt("Why did they say no? This is the most useful note for the next Room.");
      if (!reason) return;
      body.decline_reason = reason;
    }
    const res = await api<{ detail?: string }>(`/api/sponsors/${id}/stage`, { method: "POST", body });
    if (res.status !== 200) setError(res.data?.detail ?? `Could not move that prospect (${res.status}).`);
    props.onChanged();
  }

  return (
    <>
      <h3>Who is paying for it</h3>
      <p className="muted">
        One presenting partner, one supporting, one in-kind. Sponsors underwrite the experience —
        they never receive the guest list, and there is no export that would give it to them.{" "}
        <strong>{usd(props.committedUsd)} committed so far.</strong>
      </p>

      {props.loading && <p className="state-empty">Reading the sponsor pipeline…</p>}

      {!props.loading && props.sponsors.length === 0 ? (
        <p className="state-empty" data-testid="sponsors-empty">
          Nobody is being approached. Add the first prospect below — a Room without a sponsor is
          spend the fund carries on its own.
        </p>
      ) : (
        <table data-testid="sponsor-table">
          <thead>
            <tr>
              <th>Who</th>
              <th>Tier</th>
              <th>What they sell</th>
              <th>Money</th>
              <th>Where it stands</th>
              <th>Move it to</th>
            </tr>
          </thead>
          <tbody>
            {props.sponsors.map((s) => (
              <tr key={s.id} data-testid={`sponsor-${s.id}`}>
                <td>
                  {s.org_name}
                  {s.decline_reason && <div className="muted small">Said no: {s.decline_reason}</div>}
                </td>
                <td>{tierLabel(s.tier)}</td>
                <td>{categoryLabel(s.category)}</td>
                <td>{s.committed_usd ? <strong>{usd(s.committed_usd)}</strong> : range(s.ask_low_usd, s.ask_high_usd)}</td>
                <td>{stageLabel(s.stage)}</td>
                <td>
                  <select
                    value=""
                    aria-label={`Move ${s.org_name}`}
                    onChange={(e) => { if (e.target.value) void move(s.id, e.target.value); }}
                  >
                    <option value="">— pick one —</option>
                    {SPONSOR_STAGES.filter((st) => st.key !== s.stage).map((st) => (
                      <option key={st.key} value={st.key}>{st.label}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="card">
        <h4>Add a prospect</h4>
        <div className="form-row">
          <label>
            Who{" "}
            <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="AWS Startups" data-testid="sponsor-org" />
          </label>
          <label>
            Tier{" "}
            <select value={tier} onChange={(e) => setTier(e.target.value)}>
              {TIERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
          <label>
            What they sell{" "}
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <button type="button" onClick={add} disabled={org.trim().length < 2} data-testid="add-sponsor">
            Add prospect
          </button>
        </div>
        <p className="muted small">
          Adding a prospect records intent. Nobody is contacted until a partner approves the approach.
        </p>
        {error && <p className="notice notice-gate small" data-testid="sponsor-error" role="status">{error}</p>}
      </div>
    </>
  );
}

/**
 * How often West Peek gathers, and what that is for.
 *
 * WHAT WAS WRONG: half of this sat behind a "Show the rhythm" toggle that defaulted closed, so the
 * only part of the page that answers "what should we be running" was invisible until somebody
 * clicked a link they had no reason to click. Nothing here is expensive to render and nothing here
 * is private; the toggle was hiding the content from the person it was written for.
 *
 * Every word comes from `shared/events/programme.ts`, which mirrors docs/COMMUNITY.md and is pinned
 * by a test. Nothing is restated here, so nothing here can drift.
 */
function Programme(): JSX.Element {
  return (
    <>
      <h3>How often West Peek gathers</h3>
      <p data-testid="programme-stance">
        <strong>{EVENT_ETHOS.stance}</strong> {EVENT_ETHOS.notThis.join(" ")}
      </p>
      <p className="small">{EVENT_ETHOS.job}</p>
      <p className="muted small">
        {EVENT_ETHOS.posture} {EVENT_ETHOS.product}
      </p>
      <p className="muted small" data-testid="programme-money">{EVENT_ETHOS.money}</p>

      <div className="card">
        <h4>At full speed</h4>
        <p className="muted small">
          The cadence when the community is running properly — not a promise about this month. Being
          earlier in the sequence is not being behind.
        </p>
        <ul className="card-list" data-testid="programme-rhythm">
          {OPERATING_RHYTHM.map((i) => (
            <li key={i.key} data-testid={`rhythm-${i.key}`}>
              <strong>{i.label}</strong> — {i.runs.join(" · ")}
              <br />
              <span className="muted small">{i.purpose}</span>
              <br />
              <span className="small">
                <em>Parker suggests:</em> {i.recommendation}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="muted small" data-testid="programme-why">{WHY_THE_RHYTHM}</p>
    </>
  );
}
