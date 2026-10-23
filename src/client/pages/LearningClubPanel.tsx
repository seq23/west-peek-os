import { useState } from "react";
import { api, useApi } from "../lib/api";
import { PartnersPanel } from "./PartnersPanel";

/**
 * THE TOP OF EVENTS & ROOMS (owner, 22 Oct 2026): "rooms are our event series and TLC is a series within the
 * Rooms piece… being on the events and rooms page in the OS should explain the organization of it all".
 * A plain map of how the pieces fit, then The Learning Club: its months and one-sheets, the playbook, and the
 * ideas list — every idea anyone sent, who sent it, when, where it came from, and where it stands.
 */

interface TlcEvent {
  id: string;
  month: string;
  topic: string | null;
  status: string;
  one_pager_url: string | null;
  seats?: { min: number; max: number };
  goal?: { goalUsd: number; costBudgetUsd: number };
  backup_json?: string | null;
  switch_deadline?: string | null;
}
interface TlcIdea {
  id: string;
  topic: string;
  note: string | null;
  origin: string;
  origin_label: string;
  suggested_by: string;
  suggested_at: string;
  preferred_month: string | null;
  status: "LATER" | "PICKED" | "ALTERNATIVE" | "DROPPED" | "MERGED";
  merged_into?: string | null;
  earliest_month?: string | null;
  status_month: string | null;
  dropped_at: string | null;
}
interface TlcResearch {
  id: string;
  kind: string;
  kind_label: string;
  title: string;
  body: string | null;
  topic: string | null;
  source_title: string | null;
  source_url: string | null;
  published_on: string | null;
  found_at: string;
  found_by: string;
}
type ApprovalState = "APPROVED" | "CHANGED" | "NOT_APPROVED";
interface TlcApprovals {
  pitch: { state: ApprovalState; hash: string; approved_at: string | null };
  playbook: { state: ApprovalState; hash: string; approved_at: string | null };
  sending: boolean;
  pitches: Array<{ month: string; topic: string; url: string | null; pdf_url: string | null }>;
}
interface TlcOverview {
  approvals?: TlcApprovals;
  send_gate?: { open: boolean; reasons: string[] };
  settings?: Record<string, string | null>;
  events: TlcEvent[];
  ideas: TlcIdea[];
  research: TlcResearch[];
  playbook_document_id: string | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthWords = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

const STATUS_WORDS: Record<TlcEvent["status"], string> = {
  PLANNING: "being picked",
  TOPIC_PROPOSED: "picked — goes ahead unless you say no",
  TOPIC_READY: "agreed",
  SWAP_FLAGGED: "being swapped",
  ESCALATED: "short of the go-ahead",
  GO: "going ahead",
  DONE: "happened",
  CANCELLED: "cancelled",
};

function ideaStatus(i: TlcIdea): string {
  if (i.status === "PICKED") return i.status_month ? `Picked for ${monthWords(i.status_month)}` : "Picked";
  if (i.status === "ALTERNATIVE") return "In the alternatives";
  if (i.status === "MERGED") return `Merged into ${i.merged_into ?? "a bigger idea"}`;
  if (i.status === "DROPPED") return `Set aside${i.dropped_at ? ` on ${i.dropped_at.slice(0, 10)}` : ""}`;
  return "Later";
}

function openDocument(id: string): void {
  try {
    window.sessionStorage.setItem("wpos.documents.focus", id);
  } catch {
    /* the list still opens without the focus */
  }
  window.location.hash = "#/documents";
}

export function RoomsMap(): JSX.Element {
  return (
    <section className="hint" data-testid="rooms-map">
      <h3>How events work here</h3>
      <ul>
        <li>
          <strong>West Peek Rooms</strong> is our event series: one topic a month, with angles inside it.
          <ul>
            <li>
              <strong>The Learning Club (TLC)</strong> is a series inside Rooms: one New York room of 25–40 people,
              3–4 hours on one topic, paid for by brand sponsors, with a $10 ticket.
            </li>
            <li>
              <strong>Workshops</strong> are the free, hands-on online sessions beside the Room.
            </li>
          </ul>
        </li>
        <li>
          <strong>Who does what:</strong> Parker picks the topics and builds the packets; Wynn sells TLC
          partnerships, in emails signed by Sequoia; Sequoia decides every TLC deal, and every TLC email goes to
          her only. The partners book and pay for everything.
        </li>
        <li>
          <strong>On this page:</strong> The Learning Club first (its months, each one-sheet, the playbook and the
          ideas list), then the Rooms and Workshops waiting on you, then what has happened.
        </li>
        <li>
          <strong>Research library:</strong> the background Parker and Wynn draw on — the trend story with its
          sources, brands spending now, trends, and regulatory checks. It updates quietly; nobody is emailed about it.
        </li>
      </ul>
    </section>
  );
}

export function LearningClubPanel(): JSX.Element {
  const tlc = useApi<TlcOverview>("/api/tlc");
  const [topic, setTopic] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    if (topic.trim().length < 2) {
      setMessage("Write the idea in a few words first.");
      return;
    }
    const res = await api<{ detail?: string }>("/api/tlc/ideas", { method: "POST", body: { topic: topic.trim(), ...(note.trim() ? { note: note.trim() } : {}) } });
    if (res.status === 200) {
      setTopic("");
      setNote("");
      setMessage("Added. Parker reads the list first every time he picks.");
      tlc.reload();
    } else setMessage(res.data?.detail ?? "That did not save. Try again.");
  };
  const change = async (id: string, to: "drop" | "restore"): Promise<void> => {
    const res = await api(`/api/tlc/ideas/${id}/${to}`, { method: "POST" });
    setMessage(res.status === 200 ? (to === "drop" ? "Set aside. It stays on the list." : "Back on the list.") : "That did not save. Try again.");
    tlc.reload();
  };

  const data = tlc.data;
  return (
    <section data-testid="tlc-panel">
      <h3>The Learning Club</h3>
      {tlc.loading ? (
        <p className="state-empty">Reading the Learning Club…</p>
      ) : !data ? (
        <p className="state-empty">The Learning Club could not be read just now. Reload the page to try again.</p>
      ) : (
        <>
          <h4>The next months</h4>
          {data.events.length === 0 ? (
            <p className="state-empty">No month is being planned yet. Parker starts three months ahead.</p>
          ) : (
            <ul className="card-list" data-testid="tlc-months">
              {data.events.map((e) => (
                <li key={e.id}>
                  <strong>{monthWords(e.month)}:</strong> {e.topic ?? "not picked yet"}{" "}
                  <span className="muted">({STATUS_WORDS[e.status] ?? e.status.toLowerCase()})</span>
                  <RoomSize ev={e} onSaved={tlc.reload} />
                  {e.one_pager_url && (
                    <>
                      {" "}
                      · <a href={e.one_pager_url} target="_blank" rel="noreferrer">Open the internal one-pager</a> ·{" "}
                      <a href={`${e.one_pager_url}?doc=pitch`} target="_blank" rel="noreferrer">Open the brand pitch</a>
                      {e.backup_json && (
                        <>
                          {" "}· Backup:{" "}
                          <a href={`${e.one_pager_url}?doc=backup-internal`} target="_blank" rel="noreferrer">its internal one-pager</a> ·{" "}
                          <a href={`${e.one_pager_url}?doc=backup-pitch`} target="_blank" rel="noreferrer">its brand pitch</a>
                          {e.switch_deadline && <span className="muted"> (switches in automatically on {e.switch_deadline.slice(0, 10)} if too few brands say yes)</span>}
                        </>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h4>Partners (brands that said yes)</h4>
          <PartnersPanel source="TLC" />

          {data.approvals && <BrandSending approvals={data.approvals} gate={data.send_gate ?? { open: false, reasons: [] }} callLink={data.settings?.call_link ?? null} playbookId={data.playbook_document_id} onChange={tlc.reload} />}

          <p>
            {data.playbook_document_id ? (
              <a href="#/documents" data-testid="tlc-playbook-link" onClick={(ev) => { ev.preventDefault(); openDocument(data.playbook_document_id!); }}>
                The Learning Club playbook
              </a>
            ) : (
              <span className="muted">The playbook is not in Documents yet.</span>
            )}{" "}
            <span className="muted small">Parker and Wynn read this copy every time they work.</span>
          </p>

          <h4>Ideas list</h4>
          <p className="muted small">
            Every topic idea, from you, from brands spending now, and from what people are curious about. Parker reads
            this first every time he picks and decides on merit. Nothing is ever removed; set-aside ideas stay here.
          </p>
          {message && <p className="notice" role="status">{message}</p>}
          {data.ideas.length === 0 ? (
            <p className="state-empty">No ideas yet. Add one below.</p>
          ) : (
            <div className="table-wrap">
            <table data-testid="tlc-ideas">
              <thead>
                <tr>
                  <th>Idea</th>
                  <th>Where from</th>
                  <th>Who, when</th>
                  <th>Where it stands</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.ideas.map((i) => (
                  <tr key={i.id} data-testid={`tlc-idea-${i.id}`}>
                    <td>
                      <strong>{i.topic}</strong>
                      {i.note && <div className="muted small">{i.note}</div>}
                      {i.preferred_month && <div className="muted small">Preferred: {monthWords(i.preferred_month)}</div>}
                      {i.earliest_month && <div className="muted small">Not before {monthWords(i.earliest_month)}</div>}
                    </td>
                    <td>{i.origin_label}</td>
                    <td>
                      {i.suggested_by}, {i.suggested_at.slice(0, 10)}
                    </td>
                    <td>{ideaStatus(i)}</td>
                    <td>
                      {i.status === "MERGED" ? null : i.status === "DROPPED" ? (
                        <button type="button" className="link-button" onClick={() => void change(i.id, "restore")}>Bring back</button>
                      ) : (
                        <button type="button" className="link-button" onClick={() => void change(i.id, "drop")}>Set aside</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          <div className="form-row" data-testid="tlc-idea-add">
            <label>
              An idea
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Peptides and biohacking" maxLength={160} />
            </label>
            <label>
              A note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. New Year, new me — January if it fits" maxLength={600} />
            </label>
            <button type="button" onClick={() => void add()}>Add to the list</button>
          </div>

          <h4>Research library</h4>
          <p className="muted small">
            Background for building and selling each club, newest first. Every entry is dated and says what kind it is;
            facts carry their source. Parker and Wynn read this whenever they build a room, a booking pack or a brand list.
          </p>
          {data.research.length === 0 ? (
            <p className="state-empty">Nothing in the library yet. Wynn's quarterly research fills it.</p>
          ) : (
            <ul className="card-list" data-testid="tlc-research">
              {data.research.map((r) => (
                <li key={r.id}>
                  <span className="muted small">
                    {r.kind_label} · {(r.published_on || r.found_at).slice(0, 10)} · {r.found_by}
                  </span>
                  <div>
                    {r.topic && <strong>{r.topic}: </strong>}
                    {r.title}
                  </div>
                  {r.body && <div className="muted small">{r.body}</div>}
                  {r.source_url && (
                    <div className="small">
                      <a href={r.source_url} target="_blank" rel="noreferrer">{r.source_title || r.source_url}</a>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const STATE_WORDS: Record<ApprovalState, { words: string; badge: string }> = {
  APPROVED: { words: "Approved", badge: "badge badge-ok" },
  CHANGED: { words: "Changed since you approved it: look again", badge: "badge badge-gate" },
  NOT_APPROVED: { words: "Not approved yet", badge: "badge badge-gate" },
};

/**
 * BRAND SENDING, IN THREE PLAIN STEPS (owner, 22 Oct 2026; make-it-calm). Approve the brand pitch,
 * approve the playbook, then start sending. Each asks "are you sure?" first. An approval is of the
 * exact words on screen: the button sends the hash of what was shown, and any later change clears
 * it and says so here. "Stop sending" is always one tap, at the top, never hidden.
 */
function BrandSending(props: { approvals: TlcApprovals; gate: { open: boolean; reasons: string[] }; callLink: string | null; playbookId: string | null; onChange: () => void }): JSX.Element {
  const { approvals, gate } = props;
  const [confirming, setConfirming] = useState<null | "pitch" | "playbook" | "brand_send_on">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState(props.callLink ?? "");
  const both = approvals.pitch.state === "APPROVED" && approvals.playbook.state === "APPROVED";

  const send = async (what: "pitch" | "playbook" | "brand_send_on" | "brand_send_off" | "call_link"): Promise<void> => {
    const body: Record<string, string> = { what };
    if (what === "pitch") body.hash = approvals.pitch.hash;
    if (what === "playbook") body.hash = approvals.playbook.hash;
    if (what === "call_link") body.call_link = link.trim();
    const res = await api<{ detail?: string }>("/api/tlc/approve", { method: "POST", body });
    setConfirming(null);
    setMessage(
      res.status === 200
        ? { pitch: "The brand pitch is approved, exactly as it reads now.", playbook: "The playbook is approved, exactly as it reads now.", brand_send_on: "Sending to brands is on. Each email still waits for your approval.", brand_send_off: "Sending to brands is off. Nothing more goes to any brand.", call_link: "Your call link is saved." }[what]
        : res.data?.detail ?? "That did not save. Try again.",
    );
    props.onChange();
  };

  const Confirm = (p: { what: "pitch" | "playbook" | "brand_send_on"; sentence: string; yes: string }): JSX.Element =>
    confirming === p.what ? (
      <div className="notice" role="alert">
        <p>{p.sentence}</p>
        <button type="button" onClick={() => void send(p.what)}>{p.yes}</button>{" "}
        <button type="button" className="link-button" onClick={() => setConfirming(null)}>Cancel, change nothing</button>
      </div>
    ) : (
      <></>
    );

  return (
    <section data-testid="tlc-brand-sending">
      <h4>Brand sending</h4>
      {approvals.sending ? (
        <p>
          <span className="badge badge-ok">Sending to brands is ON</span>{" "}
          <button type="button" data-testid="tlc-stop-sending" onClick={() => void send("brand_send_off")}>Stop sending to brands</button>
        </p>
      ) : (
        <p><span className="badge badge-quiet">Sending to brands is OFF</span> Nothing goes to any brand.</p>
      )}
      {!gate.open && gate.reasons.length > 0 && (
        <p className="muted small" data-testid="tlc-gate-reasons">Why nothing is going yet: {gate.reasons.join("; ")}.</p>
      )}
      {message && <p className="notice" role="status">{message}</p>}
      <ol className="card-list">
        <li data-testid="tlc-step-pitch">
          <strong>Step 1. Approve the brand pitch.</strong> <span className={STATE_WORDS[approvals.pitch.state].badge}>{STATE_WORDS[approvals.pitch.state].words}</span>
          {approvals.pitch.state === "APPROVED" && approvals.pitch.approved_at && <span className="muted small"> on {approvals.pitch.approved_at.slice(0, 10)}</span>}
          <div className="small">
            Read what a brand will see:{" "}
            {approvals.pitches.map((p, i) => (
              <span key={p.month}>
                {i > 0 && " · "}
                {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{monthWords(p.month)}: {p.topic} (tap to open)</a> : `${monthWords(p.month)}: ${p.topic}`}
              </span>
            ))}
          </div>
          {approvals.pitch.state !== "APPROVED" && confirming !== "pitch" && <button type="button" onClick={() => setConfirming("pitch")}>Approve the brand pitch</button>}
          <Confirm what="pitch" sentence="You are approving these pitches exactly as they read now. If any word changes later, this approval clears and this page will say so." yes="Yes, approve the brand pitch" />
        </li>
        <li data-testid="tlc-step-playbook">
          <strong>Step 2. Approve the playbook.</strong> <span className={STATE_WORDS[approvals.playbook.state].badge}>{STATE_WORDS[approvals.playbook.state].words}</span>
          <div className="small">
            {props.playbookId ? (
              <a href="#/documents" onClick={(ev) => { ev.preventDefault(); openDocument(props.playbookId!); }}>Read the playbook (tap to open)</a>
            ) : (
              <span className="muted">The playbook is not in Documents yet.</span>
            )}
          </div>
          {approvals.playbook.state !== "APPROVED" && confirming !== "playbook" && <button type="button" onClick={() => setConfirming("playbook")}>Approve the playbook</button>}
          <Confirm what="playbook" sentence="You are approving the playbook exactly as it reads now. If it changes later, this approval clears." yes="Yes, approve the playbook" />
        </li>
        <li data-testid="tlc-step-start">
          <strong>Step 3. Start sending to brands.</strong>{" "}
          {approvals.sending ? (
            <span className="badge badge-ok">On</span>
          ) : both ? (
            confirming !== "brand_send_on" && <button type="button" onClick={() => setConfirming("brand_send_on")}>Start sending to brands</button>
          ) : (
            <span className="muted small">Approve steps 1 and 2 first.</span>
          )}
          <Confirm what="brand_send_on" sentence="Brands will start getting short emails signed by you, a few a day, and each one waits for your approval before it goes. You can stop at any time." yes="Yes, start sending" />
        </li>
      </ol>
      <div className="form-row">
        <label>
          Your call link (brands who say yes get it with the pitch)
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" maxLength={400} />
        </label>
        <button type="button" onClick={() => void send("call_link")}>Save the call link</button>
      </div>
    </section>
  );
}

/**
 * THE ROOM, SIZED TO ITS SPONSORS (owner, 22 Oct 2026). Shows the planned size and goal in words;
 * "Change the room size" opens two numbers and a goal, then a plain Save. Everything that speaks
 * of the room (the pitch, the drip, the booking pack, the ticket cap) reads what is saved here.
 */
function RoomSize(props: { ev: TlcEvent; onSaved: () => void }): JSX.Element {
  const seats = props.ev.seats ?? { min: 25, max: 40 };
  const goal = props.ev.goal ?? { goalUsd: 25_000, costBudgetUsd: 15_000 };
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState(String(seats.min));
  const [max, setMax] = useState(String(seats.max));
  const [g, setG] = useState(String(goal.goalUsd));
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const res = await api<{ detail?: string }>(`/api/tlc/events/${props.ev.id}/plan`, { method: "POST", body: { seats_min: Number(min), seats_max: Number(max), sponsor_goal_usd: Number(g) } });
    setMsg(res.status === 200 ? "Saved." : res.data?.detail ?? "That did not save. Try again.");
    if (res.status === 200) { setOpen(false); props.onSaved(); }
  };
  return (
    <div className="small" data-testid={`tlc-room-${props.ev.id}`}>
      Room: {seats.min === seats.max ? seats.min : `${seats.min}–${seats.max}`} people · Goal ${goal.goalUsd.toLocaleString("en-US")} from sponsors (costs up to ${goal.costBudgetUsd.toLocaleString("en-US")}){" "}
      {!open && <button type="button" className="link-button" onClick={() => setOpen(true)}>Change the room size</button>}
      {msg && <span className="muted"> {msg}</span>}
      {open && (
        <div className="form-row">
          <label>Fewest people<input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} /></label>
          <label>Most people<input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} /></label>
          <label>Sponsor goal ($)<input inputMode="numeric" value={g} onChange={(e) => setG(e.target.value)} /></label>
          <button type="button" onClick={() => void save()}>Save the room size</button>{" "}
          <button type="button" className="link-button" onClick={() => setOpen(false)}>Cancel, change nothing</button>
        </div>
      )}
    </div>
  );
}
