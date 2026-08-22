import { useState } from "react";
import { api, useApi } from "../lib/api";
import { EventsPage } from "./EventsPage";
import { EVENT_ETHOS, OPERATING_RHYTHM, WHY_THE_RHYTHM } from "@shared/events/programme";
import { HowThisWorks } from "./HowThisWorks";

/**
 * Rooms — West Peek's flagship community product (P51, docs/COMMUNITY.md).
 *
 * A Room is a curated experience built around one question, for 25–35 people, and it is also where
 * the community makes money. Parker proposes one a month; a partner picks the ones worth running.
 *
 * THE ONE THING THIS UI MUST GET RIGHT. A packet exists so a partner can execute without
 * re-checking, and the single most dangerous element on the page is a venue phone number. Every
 * contact detail therefore shows its verification state, and UNVERIFIED is styled as a warning
 * rather than as neutral chrome — because the failure is discovered by someone standing on a phone,
 * not sitting at a desk. Marking a venue confirmed requires having actually called it.
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

const STAGES = ["IDENTIFIED", "RESEARCHING", "DRAFTED", "SENT", "IN_CONVERSATION", "COMMITTED", "DECLINED", "PARKED"] as const;
const CATEGORIES = ["CLOUD", "FINTECH_SPEND", "EQUITY_CAPTABLE", "LEGAL", "PAYROLL_HR", "BANKING", "HOSPITALITY", "RECRUITING", "OTHER"] as const;

/**
 * What West Peek is for, and how often it gathers.
 *
 * Sits above the Rooms machinery on purpose. The stance is a constraint on what gets scheduled —
 * "we are curators and conveners, not event organizers" is why the recommendations below are one
 * per interval rather than a calendar to fill — so showing the cadence without it invites exactly
 * the programming-for-its-own-sake the firm has decided against.
 *
 * Every word comes from `shared/events/programme.ts`, which mirrors docs/COMMUNITY.md and is
 * pinned by a test. Nothing here is restated, so nothing here can drift.
 */
function Programme(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <section className="card" data-testid="programme">
      <header className="module-card-head">
        <h4>How West Peek gathers</h4>
        <button type="button" className="link-button" data-testid="programme-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide the rhythm" : "Show the rhythm"}
        </button>
      </header>

      <p data-testid="programme-stance">
        <strong>{EVENT_ETHOS.stance}</strong> {EVENT_ETHOS.notThis.join(" ")}
      </p>
      <p className="small">{EVENT_ETHOS.job}</p>
      <p className="muted small">
        {EVENT_ETHOS.posture} {EVENT_ETHOS.product}
      </p>

      {open && (
        <>
          <p className="muted small" data-testid="programme-money">{EVENT_ETHOS.money}</p>
          <h5>At full speed</h5>
          <p className="muted small">
            The cadence when the community is running properly — not a promise about this month.
            Being earlier in the sequence is not being behind.
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
          <p className="muted small" data-testid="programme-why">{WHY_THE_RHYTHM}</p>
        </>
      )}
    </section>
  );
}

export function RoomsPage(): JSX.Element {
  const packets = useApi<{ packets: PacketRow[] }>("/api/rooms/packets");
  const sponsors = useApi<{ sponsors: SponsorRow[]; committedUsd: number }>("/api/sponsors");
  const [openId, setOpenId] = useState<string | null>(null);
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
        `Proposed. ${res.data.venuesKept} sourced venue(s) — ${res.data.searchDetail}.` +
        (flags.length ? ` ${flags.length} thing(s) to know: ${flags.map((f) => f.detail).join(" · ")}` : ""),
      );
      packets.reload();
    } else {
      setMessage(`Could not propose a Room (${res.status}). Live search or the model may be unavailable.`);
    }
  }

  async function decide(id: string, decision: "APPROVED" | "DECLINED"): Promise<void> {
    const res = await api(`/api/rooms/packets/${id}/decide`, { method: "POST", body: { decision } });
    if (res.status !== 200) setMessage(`Could not record that decision (${res.status}).`);
    packets.reload();
  }

  const rows = packets.data?.packets ?? [];
  const proposed = rows.filter((p) => p.status === "PROPOSED");

  return (
    <div className="stack">
      <Programme />

      <HowThisWorks
        title="Rooms"
        what="Rooms are West Peek's curated gatherings — a dinner, salon or workshop for 25–35 people built around one real question. They are how members build deeper relationships, and they are the part of the community that earns money through sponsors."
        when="Once a month, when you are choosing what to run next, or when you are working a sponsor."
        operatorDoes={[
          "Read the Room Parker proposed this month and approve it, or decline it",
          "Call a venue and mark it confirmed, wrong or unreachable",
          "Put the Room on the calendar once you have a date",
          "Move a sponsor along, and record what they committed",
        ]}
        aiDoes={[
          "Parker proposes at least one Room a month with a theme, agenda, seed questions and guest ideas",
          "Parker finds candidate venues by live search and reads prices off the page it cites",
          "Wynn keeps the sponsor pipeline and drafts the approach",
        ]}
        requiresOperator={[
          "Approving a Room — it commits the firm to spend and to approaching sponsors in its name",
          "Confirming a venue, which means having actually called it",
          "Recording a sponsor commitment, because it puts real money into a budget",
        ]}
        next="An approved Room becomes an event you can add attendees to. After it runs, its close-out records what came out of it."
        blocked={[
          "No venues found: live search may be off, or nothing in that city was sourceable. The Room is still proposable — a person finds the space.",
          "A sponsor is refused when another sponsor already holds its category for that Room.",
          "Attendee lists are never shared with a sponsor. Sponsors get aggregate counts.",
        ]}
        testId="rooms"
      />

      <section className="panel">
        <header className="panel-head">
          <h3>Proposals</h3>
          <button type="button" className="primary" onClick={propose} disabled={busy} data-testid="propose-room">
            {busy ? "Proposing…" : "Propose a Room"}
          </button>
        </header>
        <p className="muted">
          Parker proposes at least one a month. You will run far fewer than are proposed — that is the
          point. The shelf is there so you can pick, not so you commit to twelve Rooms a year.
        </p>
        {message && <p className="notice" data-testid="rooms-message">{message}</p>}

        {packets.loading && <p className="muted">Loading…</p>}
        {!packets.loading && rows.length === 0 && (
          <p className="muted">
            Nothing proposed yet. Propose one now, or switch on <strong>Monthly Room proposal</strong> in
            Scheduled work and Parker will do it each month.
          </p>
        )}

        <ul className="card-list">
          {rows.map((p) => (
            <li key={p.id} className="card" data-testid={`packet-${p.id}`}>
              <button
                type="button"
                className="card-head"
                aria-expanded={openId === p.id}
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
              >
                <span>
                  <strong>{p.title}</strong>
                  <span className={`pill pill-${p.status.toLowerCase()}`}>{p.status}</span>
                </span>
                <span className="muted">
                  {p.proposed_for_month} · {p.format} · {p.target_min}–{p.target_max}
                </span>
              </button>

              {openId === p.id && <PacketDetail packet={p} onDecide={decide} onChanged={() => packets.reload()} />}
            </li>
          ))}
        </ul>
        {proposed.length > 0 && (
          <p className="muted">{proposed.length} awaiting a decision.</p>
        )}
      </section>

      <SponsorPipeline
        sponsors={sponsors.data?.sponsors ?? []}
        committedUsd={sponsors.data?.committedUsd ?? 0}
        onChanged={() => sponsors.reload()}
      />
      {/* Events fold in here rather than living on their own tab. A Room IS an event, and two
          tabs for one idea made the operator choose between them every time. The distinction that
          matters is not Rooms-versus-Events but proposed-versus-happened: above is the Room being
          planned, below is the firm's record of what actually took place. */}
      <section data-testid="events-section">
        <h4>Every gathering on the record</h4>
        <p className="muted small">
          Rooms, dinners, workshops, masterminds and the summit, as firm records: who came, when,
          and what came out of it. West Peek Live runs the room itself; this is the record of it.
        </p>
        <EventsPage />
      </section>

    </div>
  );
}

function PacketDetail(props: {
  packet: PacketRow;
  onDecide: (id: string, decision: "APPROVED" | "DECLINED") => Promise<void>;
  onChanged: () => void;
}): JSX.Element {
  const detail = useApi<{ packet: PacketRow & { agenda_md: string | null; seed_questions_json: string; guest_ideas_json: string; audience: string | null }; venues: VenueRow[]; sponsors: SponsorRow[] }>(
    `/api/rooms/packets/${props.packet.id}`, [props.packet.id],
  );

  if (detail.loading) return <p className="muted">Loading packet…</p>;
  const d = detail.data;
  if (!d) return <p className="muted">Could not load this packet.</p>;

  let economics: Economics | null = null;
  try { economics = JSON.parse(props.packet.economics_json) as Economics; } catch { economics = null; }
  const seedQuestions: string[] = JSON.parse(d.packet.seed_questions_json || "[]");
  const guestIdeas: { description: string; why: string | null }[] = JSON.parse(d.packet.guest_ideas_json || "[]");

  return (
    <div className="card-body stack">
      {props.packet.central_question && (
        <p className="lede">“{props.packet.central_question}”</p>
      )}
      {d.packet.audience && <p><strong>Who should be in the room:</strong> {d.packet.audience}</p>}

      {seedQuestions.length > 0 && (
        <div>
          <h5>Questions to seed it with</h5>
          <ul>{seedQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
        </div>
      )}

      {guestIdeas.length > 0 && (
        <div>
          <h5>Guest ideas</h5>
          <ul>
            {guestIdeas.map((g) => (
              <li key={g.description}>{g.description}{g.why ? <span className="muted"> — {g.why}</span> : null}</li>
            ))}
          </ul>
        </div>
      )}

      {d.packet.agenda_md && (
        <details>
          <summary>Run of the evening</summary>
          <pre className="prewrap">{d.packet.agenda_md}</pre>
        </details>
      )}

      <div>
        <h5>Venues</h5>
        {d.venues.length === 0 ? (
          <p className="muted">
            No venue survived sourcing, so a person needs to find the space. That is a search
            problem, not a reason to drop the Room.
          </p>
        ) : (
          <ul className="card-list">
            {d.venues.map((v) => <Venue key={v.id} venue={v} onChanged={() => { detail.reload(); props.onChanged(); }} />)}
          </ul>
        )}
      </div>

      {economics && (
        <div>
          <h5>If it runs</h5>
          <table className="data">
            <tbody>
              <tr><th>Venue</th><td>{usd(economics.venueLowUsd)}–{usd(economics.venueHighUsd)}</td></tr>
              <tr><th>Estimated cost</th><td>{usd(economics.estimatedCostLowUsd)}–{usd(economics.estimatedCostHighUsd)} at {economics.targetAttendees} people</td></tr>
              <tr><th>Sponsor target</th><td>{usd(economics.sponsorTargetLowUsd)}–{usd(economics.sponsorTargetHighUsd)}</td></tr>
              <tr>
                <th>Net</th>
                <td className={economics.netLowUsd < 0 ? "negative" : undefined}>
                  {usd(economics.netLowUsd)}–{usd(economics.netHighUsd)}
                  {economics.netLowUsd < 0 && <span className="muted"> — the low case does not cover itself</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {props.packet.sponsor_thesis && (
        <p><strong>Why a sponsor underwrites this:</strong> {props.packet.sponsor_thesis}</p>
      )}

      {(props.packet.status === "PROPOSED" || props.packet.status === "DRAFT") && (
        <div className="row">
          <button type="button" className="primary" onClick={() => props.onDecide(props.packet.id, "APPROVED")} data-testid={`approve-${props.packet.id}`}>
            Approve this Room
          </button>
          <button type="button" onClick={() => props.onDecide(props.packet.id, "DECLINED")} data-testid={`decline-${props.packet.id}`}>
            Decline
          </button>
        </div>
      )}
      {props.packet.status === "APPROVED" && (
        <p className="muted">Approved by {props.packet.decided_by}. Add a date to put it on the calendar.</p>
      )}
    </div>
  );
}

/**
 * One venue.
 *
 * The verification badge is the point of this component. An UNVERIFIED phone number is shown
 * because it is worth calling, and marked because it is not yet worth trusting.
 */
function Venue(props: { venue: VenueRow; onChanged: () => void }): JSX.Element {
  const v = props.venue;
  const [busy, setBusy] = useState(false);

  async function mark(verification: "CONFIRMED" | "WRONG" | "UNREACHABLE"): Promise<void> {
    setBusy(true);
    await api(`/api/rooms/venues/${v.id}/verify`, { method: "POST", body: { verification } });
    setBusy(false);
    props.onChanged();
  }

  return (
    <li className="card" data-testid={`venue-${v.id}`}>
      <div className="card-head-static">
        <span>
          <strong>{v.name}</strong>
          {v.city && <span className="muted"> · {v.city}</span>}
          {v.capacity && <span className="muted"> · holds {v.capacity}</span>}
        </span>
        <span className={`pill pill-${v.verification.toLowerCase()}`} data-testid={`venue-state-${v.id}`}>
          {v.verification === "UNVERIFIED" ? "NOT YET CALLED" : v.verification}
        </span>
      </div>
      <div className="card-body">
        <p>{range(v.price_low_usd, v.price_high_usd)}{v.price_note ? <span className="muted"> — {v.price_note}</span> : null}</p>
        <p>
          {v.booking_phone && <span>{v.booking_phone} </span>}
          {v.booking_email && <span>{v.booking_email} </span>}
          {!v.booking_phone && !v.booking_email && <span className="muted">No contact on the cited page. </span>}
          <a href={v.source_url} target="_blank" rel="noreferrer noopener">source</a>
        </p>
        {v.verification === "UNVERIFIED" && (
          <p className="warn">
            These details came off the page above and nobody has called yet. Confirm before you
            build a guest list around this room.
          </p>
        )}
        {v.note && <p className="muted">{v.note}</p>}
        <div className="row">
          <button type="button" disabled={busy} onClick={() => mark("CONFIRMED")} data-testid={`confirm-${v.id}`}>I called — confirmed</button>
          <button type="button" disabled={busy} onClick={() => mark("WRONG")}>Details were wrong</button>
          <button type="button" disabled={busy} onClick={() => mark("UNREACHABLE")}>Could not reach them</button>
        </div>
      </div>
    </li>
  );
}

/**
 * The sponsor pipeline.
 *
 * Deliberately shows the decline reason next to declined prospects: why AWS said no is the most
 * useful thing anyone has when preparing the next Room, and it is exactly the detail that gets
 * lost when a row is just moved to a column.
 */
function SponsorPipeline(props: { sponsors: SponsorRow[]; committedUsd: number; onChanged: () => void }): JSX.Element {
  const [org, setOrg] = useState("");
  const [tier, setTier] = useState<"PRESENTING" | "SUPPORTING" | "IN_KIND">("PRESENTING");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("CLOUD");
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
      const reason = window.prompt("Why did they decline? This is the most useful note for the next Room.");
      if (!reason) return;
      body.decline_reason = reason;
    }
    const res = await api<{ detail?: string }>(`/api/sponsors/${id}/stage`, { method: "POST", body });
    if (res.status !== 200) setError(res.data?.detail ?? `Could not move that prospect (${res.status}).`);
    props.onChanged();
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Sponsors</h3>
        <span className="muted">{usd(props.committedUsd)} committed</span>
      </header>
      <p className="muted">
        One presenting partner, one supporting, one in-kind. Sponsors underwrite the experience —
        they never receive the guest list, and there is no export that would give it to them.
      </p>

      <div className="row">
        <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="AWS Startups" aria-label="Sponsor organisation" data-testid="sponsor-org" />
        <select value={tier} onChange={(e) => setTier(e.target.value as typeof tier)} aria-label="Tier">
          <option value="PRESENTING">Presenting</option>
          <option value="SUPPORTING">Supporting</option>
          <option value="IN_KIND">In kind</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} aria-label="Category">
          {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
        </select>
        <button type="button" onClick={add} disabled={org.trim().length < 2} data-testid="add-sponsor">Add prospect</button>
      </div>
      {error && <p className="warn" data-testid="sponsor-error">{error}</p>}

      {props.sponsors.length === 0 ? (
        <p className="muted">No prospects yet.</p>
      ) : (
        <table className="data">
          <thead>
            <tr><th>Organisation</th><th>Tier</th><th>Category</th><th>Ask</th><th>Stage</th><th>Move to</th></tr>
          </thead>
          <tbody>
            {props.sponsors.map((s) => (
              <tr key={s.id} data-testid={`sponsor-${s.id}`}>
                <td>
                  {s.org_name}
                  {s.decline_reason && <div className="muted">Declined: {s.decline_reason}</div>}
                </td>
                <td>{s.tier.replace(/_/g, " ").toLowerCase()}</td>
                <td>{s.category.replace(/_/g, " ").toLowerCase()}</td>
                <td>{s.committed_usd ? <strong>{usd(s.committed_usd)}</strong> : range(s.ask_low_usd, s.ask_high_usd)}</td>
                <td><span className={`pill pill-${s.stage.toLowerCase()}`}>{s.stage.replace(/_/g, " ").toLowerCase()}</span></td>
                <td>
                  <select
                    value=""
                    aria-label={`Move ${s.org_name}`}
                    onChange={(e) => { if (e.target.value) void move(s.id, e.target.value); }}
                  >
                    <option value="">…</option>
                    {STAGES.filter((st) => st !== s.stage).map((st) => (
                      <option key={st} value={st}>{st.replace(/_/g, " ").toLowerCase()}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
