import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorksFold, RoomsLinks, dayWords, monthWords } from "./RoomsLinks";
import { CATEGORIES, SPONSOR_STAGES, ScheduleRoomButton, TIERS, categoryLabel, stageLabel, tierLabel, usd } from "./ScheduleRoom";

/**
 * ROOM SPONSORS — WHO IS PAYING FOR IT (owner approved the v8 mock-up, 23 Oct 2026). `#/room-sponsors`.
 *
 * What used to be one long table at the foot of Events & Rooms ("Who is paying for it": every
 * prospect with a stage pull-down, and Add a prospect) is now grouped under its Room, with the Room's
 * status beside it. A Room kept for later shows its sponsors PARKED — attached, visible, worked by
 * nobody — and the "Schedule this Room" button that makes them live. Sponsors never get the guest list.
 *
 * Kept from the old pipeline, deliberately: the decline reason beside a sponsor who said no (the most
 * useful thing anyone has when preparing the next Room), the committed total, the stage pull-down,
 * and the add form below the list it adds to.
 */

interface SponsorRow {
  id: string;
  org_name: string;
  tier: string;
  category: string;
  stage: string;
  ask_low_usd: number | null;
  ask_high_usd: number | null;
  committed_usd: number | null;
  packet_id: string | null;
  event_id: string | null;
  decline_reason: string | null;
  rank?: number | null;
  packet_title?: string | null;
  packet_status?: string | null;
  packet_month?: string | null;
}
interface PacketRow {
  id: string;
  title: string;
  status: string;
  kind?: "ROOM" | "WORKSHOP" | null;
  proposed_for_month: string;
  event_id: string | null;
  sponsor_total_usd: number;
}
interface EventRow { id: string; starts_at: string | null; location: string | null }

const ROOM_STATE: Record<string, { label: string; tone: string }> = {
  PROPOSED: { label: "Proposed · waiting on you", tone: "help-tag help-tag-muted" },
  DRAFT: { label: "Parker is building it", tone: "help-tag help-tag-muted" },
  APPROVED: { label: "Kept for later · parked", tone: "help-tag help-tag-muted" },
  SCHEDULED: { label: "Scheduled", tone: "help-tag help-tag-good" },
};

const askWords = (s: SponsorRow): string =>
  s.committed_usd ? `${usd(s.committed_usd)} committed` : s.ask_low_usd !== null && s.ask_high_usd !== null && s.ask_low_usd !== s.ask_high_usd ? `${usd(s.ask_low_usd)}–${usd(s.ask_high_usd)}` : s.ask_low_usd ?? s.ask_high_usd ? usd(s.ask_low_usd ?? s.ask_high_usd) : "no ask yet";

export function RoomSponsorsPage(): JSX.Element {
  const sponsors = useApi<{ sponsors: SponsorRow[]; committedUsd: number }>("/api/sponsors");
  const packets = useApi<{ packets: PacketRow[] }>("/api/rooms/packets");
  const events = useApi<{ events: EventRow[] }>("/api/events");
  const [error, setError] = useState<string | null>(null);

  const rows = sponsors.data?.sponsors ?? [];
  const allPackets = packets.data?.packets ?? [];
  const reload = (): void => { sponsors.reload(); packets.reload(); events.reload(); };

  // Every Room the firm is pursuing (kept or scheduled, or proposed with sponsors), newest month first.
  const roomIds = new Set(rows.map((r) => r.packet_id).filter((x): x is string => !!x));
  const rooms = allPackets
    .filter((p) => (p.kind ?? "ROOM") === "ROOM" && (p.status === "APPROVED" || p.status === "SCHEDULED" || roomIds.has(p.id)) && p.status !== "DECLINED")
    .sort((a, b) => (a.status === "SCHEDULED" ? 0 : 1) - (b.status === "SCHEDULED" ? 0 : 1) || (a.proposed_for_month < b.proposed_for_month ? 1 : -1));
  const loose = rows.filter((r) => !r.packet_id || !rooms.some((p) => p.id === r.packet_id));

  return (
    <section data-testid="room-sponsors-page">
      <RoomsLinks current="room-sponsors" />
      <h3>Who is paying for it</h3>
      <p className="muted">
        Sponsors sit under their Room. They go live only when the Room gets a date. One presenting partner, one
        supporting, one in kind. Sponsors never get the guest list, and there is no export that would give it to
        them. <strong data-testid="sponsors-committed">{usd(sponsors.data?.committedUsd ?? 0)} committed so far.</strong>
      </p>
      {error && <p className="notice notice-gate small" data-testid="sponsor-error" role="status">{error}</p>}
      {(sponsors.loading || packets.loading) && <p className="state-empty">Reading the sponsors…</p>}

      <div data-testid="sponsor-table">
        {!sponsors.loading && !packets.loading && rows.length === 0 && rooms.length === 0 && (
          <p className="state-empty" data-testid="sponsors-empty">
            Nobody is being approached. Add the first sponsor below — a Room without a sponsor is spend the fund
            carries on its own.
          </p>
        )}
        {rooms.map((p) => (
          <RoomCard
            key={p.id}
            packet={p}
            when={events.data?.events.find((e) => e.id === p.event_id) ?? null}
            sponsors={rows.filter((r) => r.packet_id === p.id).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))}
            onChanged={reload}
            onError={setError}
          />
        ))}
        {loose.length > 0 && (
          <section className="card" data-testid="sponsors-loose">
            <h3>Not tied to a Room yet</h3>
            <SponsorList sponsors={loose} onChanged={reload} onError={setError} />
          </section>
        )}
      </div>

      <AddSponsor rooms={rooms} onAdded={reload} onError={setError} />

      <HowThisWorksFold page="Room sponsors" testId="room-sponsors-how">
        <ul className="card-list small">
          <li>Parker suggests the sponsors for every Room he builds, ranked, with evidence and the named person who runs their partnerships.</li>
          <li>A Room you keep for later is banked, not booked: its sponsors stay attached to it, parked, and nobody works them.</li>
          <li>&ldquo;Schedule this Room&rdquo; gives it a date and a place. Only then do its sponsors go live: on the list, then approach drafted, approach sent, in conversation, committed. Nobody is contacted until a partner approves the approach.</li>
          <li>A sponsor is refused when another sponsor already holds its category for that Room. In kind and &ldquo;something else&rdquo; never clash.</li>
          <li>A commitment is recorded by a person, with the amount, because it puts real money into a Room's budget. A sponsor who said no keeps the reason, for the next Room.</li>
          <li>The Learning Club's brands are on The Learning Club page; every brand that said yes, club or Room, is listed there once under Partners who said yes.</li>
        </ul>
      </HowThisWorksFold>
    </section>
  );
}

function RoomCard(props: { packet: PacketRow; when: EventRow | null; sponsors: SponsorRow[]; onChanged: () => void; onError: (e: string | null) => void }): JSX.Element {
  const p = props.packet;
  const state = ROOM_STATE[p.status] ?? { label: "Being planned", tone: "help-tag help-tag-muted" };
  const parked = props.sponsors.filter((s) => s.stage === "PARKED").length;
  const committed = props.sponsors.reduce((sum, s) => sum + (s.stage === "COMMITTED" ? s.committed_usd ?? 0 : 0), 0);
  return (
    <section className="card" data-testid={`sponsor-room-${p.id}`}>
      <div className="rooms-card-head">
        <h3>{p.title} · {monthWords(p.proposed_for_month, true)}</h3>
        <span className={state.tone} data-testid={`sponsor-room-state-${p.id}`}>
          {state.label}{p.status === "SCHEDULED" && props.when?.starts_at ? ` · ${dayWords(props.when.starts_at)}` : ""}
        </span>
      </div>
      <p className="muted small">
        {p.status === "SCHEDULED"
          ? `${props.sponsors.length} sponsor${props.sponsors.length === 1 ? "" : "s"} · ${usd(committed)} committed of ${usd(p.sponsor_total_usd)} asked${props.when?.location ? ` · ${props.when.location}` : ""}`
          : `${props.sponsors.length} proposed · ${parked > 0 ? "parked until this Room gets a date" : "none parked"}`}
      </p>
      {p.status === "APPROVED" && <ScheduleRoomButton packetId={p.id} title={p.title} parkedSponsors={parked} onDone={props.onChanged} />}
      {props.sponsors.length === 0 ? (
        <p className="state-empty">No sponsor on this Room yet. Add one below.</p>
      ) : (
        <SponsorList sponsors={props.sponsors} onChanged={props.onChanged} onError={props.onError} />
      )}
    </section>
  );
}

function SponsorList(props: { sponsors: SponsorRow[]; onChanged: () => void; onError: (e: string | null) => void }): JSX.Element {
  const [all, setAll] = useState(false);
  const [changing, setChanging] = useState(false);
  const shown = all ? props.sponsors : props.sponsors.slice(0, 4);

  async function move(s: SponsorRow, stage: string): Promise<void> {
    props.onError(null);
    const body: Record<string, unknown> = { stage };
    if (stage === "COMMITTED") {
      const amount = window.prompt(`How much did ${s.org_name} commit, in dollars?`);
      if (!amount) return;
      body.committed_usd = Number(amount);
    }
    if (stage === "DECLINED") {
      const reason = window.prompt(`Why did ${s.org_name} say no? This is the most useful note for the next Room.`);
      if (!reason) return;
      body.decline_reason = reason;
    }
    const res = await api<{ detail?: string }>(`/api/sponsors/${s.id}/stage`, { method: "POST", body });
    if (res.status !== 200) props.onError(res.data?.detail ?? `Could not move ${s.org_name} (${res.status}).`);
    props.onChanged();
  }

  return (
    <>
      <ul className="card-list sponsor-rows">
        {shown.map((s) => (
          <li key={s.id} data-testid={`sponsor-${s.id}`}>
            <div className="rooms-card-head">
              <strong>{s.org_name}</strong>
              <span className="small">{askWords(s)}</span>
            </div>
            <div className="muted small">
              {tierLabel(s.tier)} · {categoryLabel(s.category)} · {stageLabel(s.stage)}
            </div>
            {s.decline_reason && <div className="muted small">Said no: {s.decline_reason}</div>}
            {changing && (
              <label className="small">
                Move {s.org_name} to{" "}
                <select value="" aria-label={`Move ${s.org_name}`} onChange={(e) => { if (e.target.value) void move(s, e.target.value); }}>
                  <option value="">— pick one —</option>
                  {SPONSOR_STAGES.filter((st) => st.key !== s.stage).map((st) => (
                    <option key={st.key} value={st.key}>{st.label}</option>
                  ))}
                </select>
              </label>
            )}
          </li>
        ))}
      </ul>
      <div className="form-row">
        {props.sponsors.length > 4 && (
          <button type="button" className="link-button" onClick={() => setAll(!all)}>
            {all ? "Show fewer ▴" : `Show all ${props.sponsors.length} ▾`}
          </button>
        )}
        <button type="button" className="link-button" onClick={() => setChanging(!changing)}>
          {changing ? "Done changing stages ▴" : "Change a stage ▾"}
        </button>
      </div>
    </>
  );
}

function AddSponsor(props: { rooms: PacketRow[]; onAdded: () => void; onError: (e: string | null) => void }): JSX.Element {
  const [room, setRoom] = useState("");
  const [org, setOrg] = useState("");
  const [tier, setTier] = useState<string>("PRESENTING");
  const [category, setCategory] = useState<string>("CLOUD");
  const [done, setDone] = useState<string | null>(null);

  async function add(): Promise<void> {
    props.onError(null);
    setDone(null);
    const res = await api<{ detail?: string; stage?: string }>("/api/sponsors", {
      method: "POST",
      body: { org_name: org.trim(), tier, category, ...(room ? { packet_id: room } : {}) },
    });
    if (res.status === 201) {
      const r = props.rooms.find((p) => p.id === room);
      setDone(r ? `${org.trim()} is on ${r.title}${r.status === "SCHEDULED" ? ", on the list." : ", parked until the Room gets a date."}` : `${org.trim()} is added, not tied to a Room.`);
      setOrg("");
      props.onAdded();
    } else props.onError(res.data?.detail ?? `Could not add that sponsor (${res.status}).`);
  }

  return (
    <section className="card" data-testid="add-sponsor-card">
      <h3>Add a sponsor to a Room</h3>
      <div className="form-row">
        <label>
          Which Room
          <select value={room} onChange={(e) => setRoom(e.target.value)} data-testid="sponsor-room">
            <option value="">Not tied to a Room</option>
            {props.rooms.map((p) => <option key={p.id} value={p.id}>{p.title} ({monthWords(p.proposed_for_month, true)})</option>)}
          </select>
        </label>
        <label>
          Who
          <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="AWS Startups" data-testid="sponsor-org" />
        </label>
        <label>
          Tier
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            {TIERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label>
          What they sell
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void add()} disabled={org.trim().length < 2} data-testid="add-sponsor">
          Add
        </button>
      </div>
      <p className="muted small">
        Adding a sponsor records intent. On a Room with no date it waits, parked, with the others. Nobody is
        contacted until a partner approves the approach.
      </p>
      {done && <p className="notice small" role="status" data-testid="sponsor-added">{done}</p>}
    </section>
  );
}
