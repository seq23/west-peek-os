import { useState } from "react";
import { api, useApi } from "../lib/api";
import { EventsPage } from "./EventsPage";
import { EVENT_ETHOS, OPERATING_RHYTHM, WHY_THE_RHYTHM } from "@shared/events/programme";
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
  sponsor_thesis: string | null;
  economics_json: string;
  event_id: string | null;
  decided_by: string | null;
  created_at: string;
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
  decline_reason: string | null;
}

interface Economics {
  venueLowUsd: number;
  venueHighUsd: number;
  targetAttendees: number;
  sponsorTargetLowUsd: number;
  sponsorTargetHighUsd: number;
  estimatedCostLowUsd: number;
  estimatedCostHighUsd: number;
  netLowUsd: number;
  netHighUsd: number;
}

const usd = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;

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
  DRAFT: { label: "Still being written", tone: "help-tag help-tag-muted" },
  PROPOSED: { label: "Waiting on you", tone: "help-tag help-tag-warn" },
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

  async function propose(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const res = await api<{ flags: { detail: string }[]; venuesKept: number; searchDetail: string }>(
      "/api/rooms/packets", { method: "POST", body: {} },
    );
    setBusy(false);
    if (res.status === 201 && res.data) {
      const flags = res.data.flags ?? [];
      setMessage(
        `Proposed. ${res.data.venuesKept} venue(s) found — ${res.data.searchDetail}.` +
        (flags.length ? ` ${flags.length} thing(s) to know: ${flags.map((f) => f.detail).join(" · ")}` : ""),
      );
      packets.reload();
    } else {
      setMessage(`Parker could not propose a Room (${res.status}). Live search or the model may be unavailable.`);
    }
  }

  async function decide(id: string, decision: "APPROVED" | "DECLINED"): Promise<void> {
    const res = await api(`/api/rooms/packets/${id}/decide`, { method: "POST", body: { decision } });
    if (res.status !== 200) setMessage(`Could not record that decision (${res.status}).`);
    packets.reload();
  }

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

      <div className="form-row">
        <button type="button" className="btn-strong" onClick={propose} disabled={busy} data-testid="propose-room">
          {busy ? "Parker is working…" : "Ask Parker for a Room"}
        </button>
        <span className="muted small">
          He picks the question, finds candidate venues by live search, and reads prices off the page
          he cites. Nothing is booked and nobody is contacted.
        </span>
      </div>

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
            {declined.map((p) => (
              <li key={p.id} data-testid={`declined-${p.id}`}>
                <strong>{p.title}</strong>
                <span className="muted">
                  {" "}
                  — proposed for {p.proposed_for_month}
                  {p.decided_by ? `, turned down by ${p.decided_by}` : ""}
                </span>
              </li>
            ))}
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
          "Read the Room Parker proposed this month and approve it, or decline it",
          "Call a venue and mark it confirmed, wrong or unreachable",
          "Put a gathering on the record, and move it through its life",
          "Close out a gathering that has happened — who came, and what we said we would do",
          "Move a sponsor along, and record what they committed",
        ]}
        aiDoes={[
          "Parker proposes at least one Room a month with a theme, agenda, seed questions and guest ideas",
          "Parker finds candidate venues by live search and reads prices off the page it cites",
          "Parker reads close-out notes and turns what West Peek committed to into assigned work",
          "Wynn keeps the sponsor pipeline and drafts the approach",
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
  const detail = useApi<{
    packet: PacketRow & { agenda_md: string | null; seed_questions_json: string; guest_ideas_json: string; audience: string | null };
    venues: VenueRow[];
    sponsors: SponsorRow[];
  }>(`/api/rooms/packets/${p.id}`, [p.id]);

  const state = PACKET_STATE[p.status] ?? { label: p.status.toLowerCase(), tone: "help-tag help-tag-muted" };

  let economics: Economics | null = null;
  try { economics = JSON.parse(p.economics_json) as Economics; } catch { economics = null; }

  const d = detail.data;
  const seedQuestions: string[] = d ? safeList<string>(d.packet.seed_questions_json) : [];
  const guestIdeas = d ? safeList<{ description: string; why: string | null }>(d.packet.guest_ideas_json) : [];

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

      {detail.loading && <p className="state-empty">Reading the packet…</p>}

      {!detail.loading && !d && (
        <p className="state-empty">
          The packet behind this Room could not be loaded, so the question, venues and costs are not
          shown. The decision below still works; the case for it does not.
        </p>
      )}

      {d && (
        <>
          <p className="small">
            <strong>Who should be in the room:</strong>{" "}
            {d.packet.audience ?? <span className="muted">Parker did not say. Decide who this is for before you invite anybody.</span>}
          </p>

          <p className="small"><strong>Questions to seed it with</strong></p>
          {seedQuestions.length === 0 ? (
            <p className="state-empty">None suggested. A Room with no opening question becomes a networking event.</p>
          ) : (
            <ul className="card-list small">{seedQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
          )}

          <p className="small"><strong>Guests worth asking</strong></p>
          {guestIdeas.length === 0 ? (
            <p className="state-empty">None suggested. The guest list is yours to build.</p>
          ) : (
            <ul className="card-list small">
              {guestIdeas.map((g) => (
                <li key={g.description}>{g.description}{g.why ? <span className="muted"> — {g.why}</span> : null}</li>
              ))}
            </ul>
          )}

          {d.packet.agenda_md && (
            <details>
              <summary>How the evening runs</summary>
              <p className="small" style={{ whiteSpace: "pre-wrap" }}>{d.packet.agenda_md}</p>
            </details>
          )}

          <p className="small"><strong>Where it could be held</strong></p>
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
        </>
      )}

      <p className="small"><strong>What it costs if it runs</strong></p>
      {economics ? (
        <table>
          <tbody>
            <tr><th scope="row">Venue</th><td>{usd(economics.venueLowUsd)}–{usd(economics.venueHighUsd)}</td></tr>
            <tr><th scope="row">Estimated cost</th><td>{usd(economics.estimatedCostLowUsd)}–{usd(economics.estimatedCostHighUsd)} at {economics.targetAttendees} people</td></tr>
            <tr><th scope="row">Sponsor target</th><td>{usd(economics.sponsorTargetLowUsd)}–{usd(economics.sponsorTargetHighUsd)}</td></tr>
            <tr>
              <th scope="row">Left over</th>
              <td>
                {usd(economics.netLowUsd)}–{usd(economics.netHighUsd)}
                {economics.netLowUsd < 0 && <span className="muted"> — the low case does not cover itself</span>}
              </td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p className="state-empty">Parker did not cost this one. Approving it commits spend nobody has sized.</p>
      )}

      {p.sponsor_thesis && (
        <p className="small"><strong>Why a sponsor underwrites this:</strong> {p.sponsor_thesis}</p>
      )}

      {(p.status === "PROPOSED" || p.status === "DRAFT") && (
        <div className="form-row">
          <button type="button" className="btn-strong" onClick={() => props.onDecide(p.id, "APPROVED")} data-testid={`approve-${p.id}`}>
            Approve this Room
          </button>
          <button type="button" onClick={() => props.onDecide(p.id, "DECLINED")} data-testid={`decline-${p.id}`}>
            Decline it
          </button>
          <span className="muted small">Declining keeps it, greyed, further down this page.</span>
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
          {v.city && <span className="muted"> · {v.city}</span>}
          {v.capacity && <span className="muted"> · holds {v.capacity}</span>}
        </span>
        <span className={state.tone} data-testid={`venue-state-${v.id}`}>{state.label}</span>
      </div>
      <p className="small">
        {range(v.price_low_usd, v.price_high_usd)}
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
