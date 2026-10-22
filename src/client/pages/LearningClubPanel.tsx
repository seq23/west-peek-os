import { useState } from "react";
import { api, useApi } from "../lib/api";

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
  status: "LATER" | "PICKED" | "ALTERNATIVE" | "DROPPED";
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
interface TlcOverview {
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
          sponsorships; you and Scooter decide every deal and book and pay for everything.
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
                  {e.one_pager_url && (
                    <>
                      {" "}
                      · <a href={e.one_pager_url} target="_blank" rel="noreferrer">the one-sheet a brand would see</a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

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
                    </td>
                    <td>{i.origin_label}</td>
                    <td>
                      {i.suggested_by}, {i.suggested_at.slice(0, 10)}
                    </td>
                    <td>{ideaStatus(i)}</td>
                    <td>
                      {i.status === "DROPPED" ? (
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
