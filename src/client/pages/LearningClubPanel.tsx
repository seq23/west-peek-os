import { useState } from "react";
import { api, useApi } from "../lib/api";
import { PartnersPanel } from "./PartnersPanel";
import { MustPitchSection } from "./TlcMustPitch";
import { HowThisWorksFold, RoomsFold, RoomsLinks, dayWords, monthWords } from "./RoomsLinks";
import { IDEA_FILTERS, backupMonthFor, dedupeIdeas, isSetAside, matchesFilter, matchesSearch, orderIdeas, previewIdeas, type IdeaEntry, type IdeaFilter } from "@shared/tlc/ideasView";
import { ALLOWED_BY_OWNER, NOT_PITCHING, TITLE_SPONSORS_TO_PITCH_FIRST, TITLE_SPONSOR_RESEARCH_COUNT, TITLE_SPONSOR_RESEARCH_URL, TITLE_SPONSOR_RULE } from "@shared/tlc/titleSponsors";

/**
 * THE LEARNING CLUB, ITS IDEAS AND ITS RESEARCH (owner approved the v8 mock-up, 23 Oct 2026). What
 * used to be one long panel at the top of Events & Rooms is now:
 *
 *   - `IdeasCard`         — the ideas list, first on Events & Rooms: count, filter, search, notes.
 *   - `LearningClubPage`  — `#/learning-club`: sending, the next three clubs, the title sponsors to
 *                           pitch first, Brands we must pitch and Needs a way in (#270), Not pitching,
 *                           Partners who said yes, and the remaining steps folded away.
 *   - `ResearchLibraryPage` — `#/research-library`: the research pages, the trend story, the checks.
 *   - `RoomsMap`          — how events work here, inside "How this works" on Events & Rooms.
 *
 * Nothing that was on the panel is dropped; it moved. make-it-calm: plain words, one list, phone
 * first, every fold says what is inside and what to tap, colour means one thing.
 */

interface TlcEvent {
  id: string;
  month: string;
  topic: string | null;
  status: string;
  event_date?: string | null;
  one_pager_url: string | null;
  seats?: { min: number; max: number };
  goal?: { goalUsd: number; costBudgetUsd: number };
  backup_json?: string | null;
  switch_deadline?: string | null;
  deals?: Array<{ stage: string; tier?: string | null; cash_offer_usd: number | null }>;
}
interface TlcIdeaNote { id: string; body: string; author: string; created_at: string }
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
  notes?: TlcIdeaNote[];
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
interface TlcResearchLink { id: string; title: string; url: string; added_by: string; added_at: string }
type ApprovalState = "APPROVED" | "CHANGED" | "NOT_APPROVED";
interface TlcApprovals {
  pitch: { state: ApprovalState; hash: string; approved_at: string | null };
  playbook: { state: ApprovalState; hash: string; approved_at: string | null };
  sending: boolean;
  pitches: Array<{ month: string; topic: string; url: string | null; pdf_url: string | null }>;
}
interface SendGate { open: boolean; reasons: string[]; outside_email_allowed?: boolean }
interface TlcOverview {
  approvals?: TlcApprovals;
  send_gate?: SendGate;
  settings?: Record<string, string | null>;
  events: TlcEvent[];
  ideas: TlcIdea[];
  research: TlcResearch[];
  research_links?: TlcResearchLink[];
  playbook_document_id: string | null;
}

const usdK = (n: number): string => (n >= 1000 && n % 1000 === 0 ? `$${n / 1000}K` : `$${Math.round(n).toLocaleString("en-US")}`);

const STATUS_WORDS: Record<string, string> = {
  PLANNING: "being picked",
  TOPIC_PROPOSED: "picked — goes ahead unless you say no",
  TOPIC_READY: "agreed",
  SWAP_FLAGGED: "being swapped",
  ESCALATED: "short of the go-ahead",
  GO: "going ahead",
  DONE: "happened",
  CANCELLED: "cancelled",
};

/** Cut at a word, with "…" when anything was cut. */
function clipWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:—–-]+$/, "")}…`;
}

function openDocument(id: string): void {
  try {
    window.sessionStorage.setItem("wpos.documents.focus", id);
  } catch {
    /* the list still opens without the focus */
  }
  window.location.hash = "#/documents";
}

function backupOf(e: TlcEvent): { topic: string } | null {
  if (!e.backup_json) return null;
  try {
    const b = JSON.parse(e.backup_json) as { topic?: unknown };
    return typeof b.topic === "string" ? { topic: b.topic } : null;
  } catch {
    return null;
  }
}

/** Sponsor cash agreed or paid, the same rule the worker's economics uses (in-kind and product partners are never cash). */
function cashIn(e: TlcEvent): number {
  return (e.deals ?? []).filter((d) => ["AGREED", "PAID", "DELIVERED"].includes(d.stage) && d.tier !== "PRODUCT").reduce((s, d) => s + (d.cash_offer_usd ?? 0), 0);
}

const upcoming = (events: readonly TlcEvent[]): TlcEvent[] => events.filter((e) => e.status !== "DONE" && e.status !== "CANCELLED");

// ── How events work here (inside "How this works" on Events & Rooms) ─────────────────────────────

export function RoomsMap(): JSX.Element {
  return (
    <section className="hint" data-testid="rooms-map">
      <h3>How events work here</h3>
      <ul>
        <li>
          <strong>West Peek Rooms</strong> is our event series: one topic a month, with angles inside it.
          <ul>
            <li>
              <strong>The Learning Club (TLC)</strong> is a series inside Rooms: one New York room, 3–4 hours on one
              topic, paid for by brand sponsors, with a $10 ticket. Each club is sized to its sponsors — from about 30
              people up to 120 for March 2027.
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
          <strong>Four pages:</strong> Events &amp; Rooms (ideas, the record, asking Parker, every Room and
          Workshop), The Learning Club (sending, the next clubs, who we pitch), Room sponsors (who is paying for each
          Room) and the Research library.
        </li>
        <li>
          <strong>A Room's life:</strong> an idea; Parker's packet (proposed); kept for later, with its sponsors
          parked; then scheduled, which is the step that makes its sponsors live.
        </li>
      </ul>
    </section>
  );
}

// ── The ideas card, first on Events & Rooms ───────────────────────────────────────────────────────

export function IdeasCard(props: { meName: string | null }): JSX.Element {
  const tlc = useApi<TlcOverview>("/api/tlc");
  const [filter, setFilter] = useState<IdeaFilter>("live");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
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

  const data = tlc.data;
  const entries = dedupeIdeas(data?.ideas ?? []);
  const live = entries.filter((e) => !isSetAside(e.idea));
  const setAside = entries.filter((e) => isSetAside(e.idea));
  const picked = live.filter((e) => e.idea.status === "PICKED").length;
  const backups = upcoming(data?.events ?? []).flatMap((e) => {
    const b = backupOf(e);
    return b ? [{ month: e.month, topic: b.topic }] : [];
  });
  const narrowed = filter !== "live" || query.trim().length > 0;
  const ordered = orderIdeas(entries.filter((e) => matchesFilter(e.idea, filter) && matchesSearch(e, query)));
  const shown = narrowed || showAll ? ordered : previewIdeas(ordered);

  return (
    <section className="card" data-testid="tlc-ideas-card">
      <div className="rooms-card-head">
        <h3>Ideas</h3>
        <span className="muted small" data-testid="tlc-ideas-count">
          {live.length} idea{live.length === 1 ? "" : "s"} · {picked} picked
        </span>
      </div>
      {tlc.loading ? (
        <p className="state-empty">Reading the ideas…</p>
      ) : !data ? (
        <p className="state-empty">The ideas could not be read just now. Reload the page to try again.</p>
      ) : (
        <>
          <div className="form-row">
            <label>
              Show
              <select value={filter} onChange={(e) => { setFilter(e.target.value as IdeaFilter); setShowAll(false); }} data-testid="tlc-ideas-filter">
                {IDEA_FILTERS.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </select>
            </label>
            <label>
              Search ideas
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. matcha" data-testid="tlc-ideas-search" />
            </label>
          </div>
          {message && <p className="notice" role="status">{message}</p>}
          {shown.length === 0 ? (
            <p className="state-empty" data-testid="tlc-ideas-none">{narrowed ? "No idea matches. Clear the search or choose Everything." : "No ideas yet. Add one below."}</p>
          ) : (
            <ul className="idea-list" data-testid="tlc-ideas">
              {shown.map((e) => (
                <IdeaRow key={e.idea.id} entry={e} meName={props.meName} backups={backups} onChanged={tlc.reload} />
              ))}
            </ul>
          )}
          <div className="form-row">
            {!narrowed && ordered.length > shown.length && (
              <button type="button" className="link-button" data-testid="tlc-ideas-show-all" onClick={() => setShowAll(true)}>
                Show all {ordered.length} ▾
              </button>
            )}
            {!narrowed && showAll && (
              <button type="button" className="link-button" onClick={() => setShowAll(false)}>Show fewer ▴</button>
            )}
          </div>
          {filter !== "set-aside" && (
            <details className="idea-set-aside" data-testid="tlc-ideas-set-aside">
              <summary>Set aside ({setAside.length}) ▾</summary>
              {setAside.length === 0 ? (
                <p className="state-empty">Nothing set aside.</p>
              ) : (
                <ul className="idea-list">
                  {orderIdeas(setAside).map((e) => (
                    <IdeaRow key={e.idea.id} entry={e} meName={props.meName} backups={backups} onChanged={tlc.reload} />
                  ))}
                </ul>
              )}
            </details>
          )}
          <div className="form-row" data-testid="tlc-idea-add">
            <label>
              Add an idea
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Peptides and biohacking" maxLength={160} />
            </label>
            <label>
              A note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. New Year, new me — January if it fits" maxLength={600} />
            </label>
            <button type="button" onClick={() => void add()}>Add to the list</button>
          </div>
          <p className="muted small">
            Parker reads this list first every time he picks a club. Nothing is ever removed: an idea filed twice
            shows once, and a set-aside idea stays here.
          </p>
        </>
      )}
    </section>
  );
}

function IdeaRow(props: { entry: IdeaEntry<TlcIdea>; meName: string | null; backups: ReadonlyArray<{ month: string; topic: string }>; onChanged: () => void }): JSX.Element {
  const i = props.entry.idea;
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const backup = i.status === "ALTERNATIVE" || i.status === "LATER" ? backupMonthFor(i.topic, props.backups) : null;
  const isNew = i.status === "LATER" && Date.now() - Date.parse(i.suggested_at) < 7 * 86_400_000;
  const who = props.meName && i.suggested_by === props.meName ? "You" : i.suggested_by;
  const pill =
    i.status === "PICKED"
      ? { words: `Picked · ${monthWords(i.status_month, true)}`, cls: "help-tag help-tag-good" }
      : i.status === "ALTERNATIVE"
        ? { words: backup ? `Backup · ${monthWords(backup, true)}` : "Alternative", cls: "help-tag help-tag-muted" }
        : i.status === "MERGED"
          ? { words: `Merged into ${i.merged_into ?? "a bigger idea"}`, cls: "help-tag help-tag-muted" }
          : i.status === "DROPPED"
            ? { words: "Set aside", cls: "help-tag help-tag-muted" }
            : { words: isNew ? "New idea" : "For later", cls: "help-tag help-tag-muted" };

  const change = async (to: "drop" | "restore"): Promise<void> => {
    const res = await api(`/api/tlc/ideas/${i.id}/${to}`, { method: "POST" });
    setMsg(res.status === 200 ? (to === "drop" ? "Set aside. It stays on the list." : "Back on the list.") : "That did not save. Try again.");
    props.onChanged();
  };
  const saveNote = async (): Promise<void> => {
    if (text.trim().length < 2) {
      setMsg("Write the note in a few words first.");
      return;
    }
    const res = await api<{ detail?: string }>(`/api/tlc/ideas/${i.id}/notes`, { method: "POST", body: { body: text.trim() } });
    if (res.status === 200) {
      setText("");
      setWriting(false);
      setMsg("Note saved under this idea.");
      props.onChanged();
    } else setMsg(res.data?.detail ?? "That did not save. Try again.");
  };

  return (
    <li className="idea-row" data-testid={`tlc-idea-${i.id}`}>
      <div className="rooms-card-head">
        <strong>{i.topic}</strong>
        <span className={pill.cls}>{pill.words}</span>
      </div>
      <div className="muted small">
        {who} · {dayWords(i.suggested_at, { year: false })}
        {/* A preferred month is stale once the idea is picked for a month of its own. */}
        {i.preferred_month && i.status !== "PICKED" && !backup ? ` · prefers ${monthWords(i.preferred_month, true)}` : ""}
        {i.earliest_month && i.status !== "PICKED" ? ` · not before ${monthWords(i.earliest_month, true)}` : ""}
      </div>
      {i.note && <div className="small">{clipWords(i.note, 140)}</div>}
      {(i.notes ?? []).map((n) => (
        <div key={n.id} className="idea-note small" data-testid={`tlc-idea-note-${n.id}`}>
          <strong>{props.meName && n.author === props.meName ? "You" : n.author}</strong>, {dayWords(n.created_at)}: {n.body}
        </div>
      ))}
      {msg && <p className="notice small" role="status">{msg}</p>}
      {writing ? (
        <div className="form-row">
          <label>
            Your note on {i.topic}
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={600} data-testid={`tlc-idea-note-input-${i.id}`} />
          </label>
          <button type="button" onClick={() => void saveNote()} data-testid={`tlc-idea-note-save-${i.id}`}>Save the note</button>{" "}
          <button type="button" className="link-button" onClick={() => { setWriting(false); setText(""); }}>Cancel, change nothing</button>
        </div>
      ) : (
        <button type="button" className="link-button" onClick={() => setWriting(true)} data-testid={`tlc-idea-note-add-${i.id}`}>
          Add a note to this idea
        </button>
      )}
      <details className="small">
        <summary>More about {i.topic} ▾</summary>
        <p>Where it came from: {i.origin_label}.</p>
        {i.note && <p>{i.note}</p>}
        {props.entry.alsoListed.length > 0 && (
          <p className="muted" data-testid={`tlc-idea-also-${i.id}`}>
            Also filed as {props.entry.alsoListed.map((x) => `“${x.topic}” (${dayWords(x.suggested_at)})`).join(", ")}: the same idea, kept on the record.
          </p>
        )}
        {i.status === "MERGED" ? null : i.status === "DROPPED" ? (
          <button type="button" className="link-button" onClick={() => void change("restore")}>Bring {i.topic} back</button>
        ) : (
          <button type="button" className="link-button" onClick={() => void change("drop")}>Set {i.topic} aside</button>
        )}
      </details>
    </li>
  );
}

// ── The Learning Club page ────────────────────────────────────────────────────────────────────────

const STATE_WORDS: Record<ApprovalState, { words: string; badge: string }> = {
  APPROVED: { words: "Approved", badge: "badge badge-ok" },
  CHANGED: { words: "Changed since you approved it: look again", badge: "badge badge-gate" },
  NOT_APPROVED: { words: "Not approved yet", badge: "badge badge-gate" },
};

export function LearningClubPage(): JSX.Element {
  const tlc = useApi<TlcOverview>("/api/tlc");
  const data = tlc.data;
  const next = upcoming(data?.events ?? []).slice(0, 3);

  return (
    <section data-testid="learning-club-page">
      <RoomsLinks current="learning-club" />
      {tlc.loading ? (
        <p className="state-empty">Reading the Learning Club…</p>
      ) : !data ? (
        <p className="state-empty">The Learning Club could not be read just now. Reload the page to try again.</p>
      ) : (
        <>
          {data.approvals && <SendingCard approvals={data.approvals} gate={data.send_gate ?? { open: false, reasons: [] }} onChange={tlc.reload} />}

          <section className="card" data-testid="tlc-next-clubs">
            <h3>The next three clubs</h3>
            {next.length === 0 ? (
              <p className="state-empty">No club is being planned yet. Parker starts three months ahead.</p>
            ) : (
              <ul className="card-list" data-testid="tlc-months">
                {next.map((e) => <ClubRow key={e.id} ev={e} onSaved={tlc.reload} />)}
              </ul>
            )}
            <p className="muted small">Tap a club for its one-pager, its brand pitch, the backup's pages, or to change the room size.</p>
          </section>

          <section className="card" data-testid="tlc-title-sponsors">
            <div className="rooms-card-head">
              <h3>Title sponsors to pitch first</h3>
              <span className="muted small">$25K, one brand</span>
            </div>
            <p className="muted small">From the research: brands with the money and a reason to present a whole room alone. Wynn works these before his own picks.</p>
            <ul className="card-list">
              {TITLE_SPONSORS_TO_PITCH_FIRST.map((t) => (
                <li key={t.brand}>
                  <div className="rooms-card-head">
                    <strong>{t.brand}</strong>
                    <span className={t.odds === "High" ? "help-tag help-tag-good" : "help-tag help-tag-muted"}>{t.odds}</span>
                  </div>
                  <div className="small">{t.fit}</div>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Each shows &ldquo;Needs a way in&rdquo; below until Wynn finds a published address or you add a contact. {TITLE_SPONSOR_RULE}
            </p>
            <p className="small">
              <a href={TITLE_SPONSOR_RESEARCH_URL} target="_blank" rel="noreferrer noopener">See all {TITLE_SPONSOR_RESEARCH_COUNT} ranked, with sources (opens in a new tab) →</a>
              {" · "}
              <button type="button" className="link-button" onClick={() => document.querySelector('[data-testid="tlc-must-pitch-add"]')?.scrollIntoView({ block: "center" })}>
                + Add a brand
              </button>
            </p>
          </section>

          {/* #270's panels, moved here whole: "Brands we must pitch" and "Needs a way in". */}
          <div className="card">
            <MustPitchSection months={upcoming(data.events).map((e) => e.month)} />
          </div>

          <section className="card" data-testid="tlc-not-pitching">
            <div className="rooms-card-head">
              <h3>Not pitching</h3>
              <span className="muted small">{NOT_PITCHING.length} kinds</span>
            </div>
            <p className="small">{NOT_PITCHING.map((n) => n.what).join(" · ")}.</p>
            <p className="muted small">{ALLOWED_BY_OWNER}</p>
            <details className="small">
              <summary>Show why ▾</summary>
              <ul className="card-list">
                {NOT_PITCHING.map((n) => (
                  <li key={n.what}><strong>{n.what}:</strong> {n.why}</li>
                ))}
              </ul>
            </details>
          </section>

          {/* ONE LIST of partners who said yes, for every club and Room (it used to be two). */}
          <section className="card" data-testid="tlc-partners">
            <h3>Partners who said yes</h3>
            <PartnersPanel />
          </section>

          {data.approvals && (
            <>
              <RoomsFold
                title="Brand sending: steps 1–3"
                testId="tlc-steps-fold"
                count={data.approvals.pitch.state === "APPROVED" && data.approvals.playbook.state === "APPROVED" && data.approvals.sending ? "All approved" : "Something to approve"}
              >
                <SendingSteps approvals={data.approvals} playbookId={data.playbook_document_id} onChange={tlc.reload} />
              </RoomsFold>
              <div className="rooms-row" data-testid="tlc-outside-email-row">
                <strong>Outside email list</strong>
                <a href="#/outside-email">{data.send_gate?.outside_email_allowed ? "TLC allowed (tap to open) →" : "TLC not allowed yet (tap to open) →"}</a>
              </div>
              <RoomsFold title="Your call link" testId="tlc-call-link-fold" count={data.settings?.call_link ? "Set" : "Not set"}>
                <CallLink callLink={data.settings?.call_link ?? null} onChange={tlc.reload} />
              </RoomsFold>
            </>
          )}
          <div className="rooms-row" data-testid="tlc-playbook-row">
            <strong>The playbook</strong>
            {data.playbook_document_id ? (
              <a href="#/documents" data-testid="tlc-playbook-link" onClick={(ev) => { ev.preventDefault(); openDocument(data.playbook_document_id!); }}>
                Open it in Documents →
              </a>
            ) : (
              <span className="muted small">Not in Documents yet.</span>
            )}
          </div>

          <HowThisWorksFold page="The Learning Club" testId="tlc-how">
            <ul className="card-list small">
              <li>One New York room a month, 3–4 hours on one topic, paid for by brand sponsors, with a $10 ticket. Each club is sized to its sponsors; the goal is $25,000 from sponsors, so the firm keeps $10,000 after costs.</li>
              <li>Parker picks each club three months ahead and names a backup; if too few brands say yes by the switch date, the backup takes over by itself.</li>
              <li>Wynn pitches brands in short emails signed by Sequoia. Each email waits for her approval before it goes, and Stop sending is one tap at the top of this page.</li>
              <li>Brands that say yes move through: said yes → call → agreed → paid. Green means the money is agreed or paid.</li>
              <li>Unlike a Room, a club has no category exclusivity: two brands that sell the same kind of thing may both sponsor it.</li>
              <li>Who is paying for each Room (not a club) is on the Room sponsors page.</li>
            </ul>
          </HowThisWorksFold>
        </>
      )}
    </section>
  );
}

function ClubRow(props: { ev: TlcEvent; onSaved: () => void }): JSX.Element {
  const e = props.ev;
  const seats = e.seats ?? { min: 25, max: 40 };
  const goal = e.goal ?? { goalUsd: 25_000, costBudgetUsd: 15_000 };
  const backup = backupOf(e);
  return (
    <li data-testid={`tlc-club-${e.id}`}>
      <details>
        <summary>
          <span className="rooms-card-head">
            <strong>{e.event_date ? dayWords(e.event_date, { weekday: true, year: false }) : monthWords(e.month)} · {e.topic ?? "not picked yet"}</strong>
            <span className="muted small">{usdK(cashIn(e))} / {usdK(goal.goalUsd)}</span>
          </span>
          <span className="rooms-summary-line muted small">
            {seats.min === seats.max ? seats.min : `${seats.min}–${seats.max}`} people
            {backup ? ` · backup ${backup.topic}${e.switch_deadline ? `, switches ${dayWords(e.switch_deadline, { year: false })}` : ""}` : " · no backup named"}
            {" · "}{STATUS_WORDS[e.status] ?? "being planned"} · tap to open ▾
          </span>
        </summary>
        <div className="small">
          {e.one_pager_url ? (
            <p>
              <a href={e.one_pager_url} target="_blank" rel="noreferrer">The internal one-pager</a> ·{" "}
              <a href={`${e.one_pager_url}?doc=pitch`} target="_blank" rel="noreferrer">The brand pitch</a>
              {backup && (
                <>
                  {" "}· Backup: <a href={`${e.one_pager_url}?doc=backup-internal`} target="_blank" rel="noreferrer">its one-pager</a> ·{" "}
                  <a href={`${e.one_pager_url}?doc=backup-pitch`} target="_blank" rel="noreferrer">its brand pitch</a>
                  {e.switch_deadline && <span className="muted"> (switches in by itself on {dayWords(e.switch_deadline)} if too few brands say yes)</span>}
                </>
              )}
            </p>
          ) : (
            <p className="muted">No one-pager yet: the topic is not picked.</p>
          )}
          <RoomSize ev={e} onSaved={props.onSaved} />
        </div>
      </details>
    </li>
  );
}

/**
 * SENDING, AT THE TOP, ALWAYS (owner, 22 Oct 2026; make-it-calm). ON or OFF in words, "Stop sending"
 * one tap away, and why nothing is going yet. The three approval steps are folded below it.
 */
function SendingCard(props: { approvals: TlcApprovals; gate: SendGate; onChange: () => void }): JSX.Element {
  const { approvals, gate } = props;
  const [message, setMessage] = useState<string | null>(null);
  const stop = async (): Promise<void> => {
    const res = await api<{ detail?: string }>("/api/tlc/approve", { method: "POST", body: { what: "brand_send_off" } });
    setMessage(res.status === 200 ? "Sending to brands is off. Nothing more goes to any brand." : res.data?.detail ?? "That did not save. Try again.");
    props.onChange();
  };
  return (
    <section className="card" data-testid="tlc-brand-sending">
      {approvals.sending ? (
        <div className="rooms-card-head">
          <span className="badge badge-ok">Sending to brands is ON</span>
          <button type="button" data-testid="tlc-stop-sending" onClick={() => void stop()}>Stop sending to brands</button>
        </div>
      ) : (
        <p><span className="badge badge-quiet">Sending to brands is OFF</span> Nothing goes to any brand.</p>
      )}
      {!gate.open && gate.reasons.length > 0 && (
        <p className="muted small" data-testid="tlc-gate-reasons">
          Why nothing is going yet:{" "}
          {gate.reasons.map((r, i) => (
            <span key={r}>
              {i > 0 && "; "}
              {/tap to (allow|open your Outside email list)/.test(r) ? <a href="#/outside-email" data-testid="tlc-outside-email-link">{r}</a> : r}
            </span>
          ))}
        </p>
      )}
      {gate.outside_email_allowed && (
        <p className="muted small" data-testid="tlc-outside-email-allowed">TLC brand sales is on your <a href="#/outside-email">Outside email list (tap to open)</a>.</p>
      )}
      {message && <p className="notice" role="status">{message}</p>}
    </section>
  );
}

/**
 * BRAND SENDING, IN THREE PLAIN STEPS (owner, 22 Oct 2026; make-it-calm). Approve the brand pitch,
 * approve the playbook, then start sending. Each asks "are you sure?" first. An approval is of the
 * exact words on screen: the button sends the hash of what was shown, and any later change clears
 * it and says so here.
 */
function SendingSteps(props: { approvals: TlcApprovals; playbookId: string | null; onChange: () => void }): JSX.Element {
  const { approvals } = props;
  const [confirming, setConfirming] = useState<null | "pitch" | "playbook" | "brand_send_on">(null);
  const [message, setMessage] = useState<string | null>(null);
  const both = approvals.pitch.state === "APPROVED" && approvals.playbook.state === "APPROVED";

  const send = async (what: "pitch" | "playbook" | "brand_send_on"): Promise<void> => {
    const body: Record<string, string> = { what };
    if (what === "pitch") body.hash = approvals.pitch.hash;
    if (what === "playbook") body.hash = approvals.playbook.hash;
    const res = await api<{ detail?: string }>("/api/tlc/approve", { method: "POST", body });
    setConfirming(null);
    setMessage(
      res.status === 200
        ? { pitch: "The brand pitch is approved, exactly as it reads now.", playbook: "The playbook is approved, exactly as it reads now.", brand_send_on: "Sending to brands is on. Each email still waits for your approval." }[what]
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
    <div data-testid="tlc-steps">
      {message && <p className="notice" role="status">{message}</p>}
      <ol className="card-list">
        <li data-testid="tlc-step-pitch">
          <strong>Step 1. Approve the brand pitch.</strong> <span className={STATE_WORDS[approvals.pitch.state].badge}>{STATE_WORDS[approvals.pitch.state].words}</span>
          {approvals.pitch.state === "APPROVED" && approvals.pitch.approved_at && <span className="muted small"> on {dayWords(approvals.pitch.approved_at)}</span>}
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
    </div>
  );
}

function CallLink(props: { callLink: string | null; onChange: () => void }): JSX.Element {
  const [link, setLink] = useState(props.callLink ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const res = await api<{ detail?: string }>("/api/tlc/approve", { method: "POST", body: { what: "call_link", call_link: link.trim() } });
    setMessage(res.status === 200 ? "Your call link is saved." : res.data?.detail ?? "That did not save. Try again.");
    props.onChange();
  };
  return (
    <div className="form-row">
      <label>
        Your call link (brands who say yes get it with the pitch)
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" maxLength={400} />
      </label>
      <button type="button" onClick={() => void save()}>Save the call link</button>
      {message && <span className="muted small" role="status">{message}</span>}
    </div>
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

// ── The Research library page ────────────────────────────────────────────────────────────────────

type ResearchShow = "everything" | "pages" | "TREND_STORY" | "BRAND_SPEND" | "TREND" | "REGULATORY";
const RESEARCH_SHOW: ReadonlyArray<{ key: ResearchShow; label: string }> = [
  { key: "everything", label: "Everything" },
  { key: "pages", label: "Research pages" },
  { key: "TREND_STORY", label: "Trend story" },
  { key: "BRAND_SPEND", label: "Brands spending now" },
  { key: "TREND", label: "Trends" },
  { key: "REGULATORY", label: "Regulatory checks" },
];

export function ResearchLibraryPage(): JSX.Element {
  const tlc = useApi<TlcOverview>("/api/tlc");
  const [show, setShow] = useState<ResearchShow>("everything");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const data = tlc.data;

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (...parts: Array<string | null | undefined>): boolean => {
    const hay = parts.filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const wants = (k: ResearchShow): boolean => show === "everything" || show === k;
  const research = (data?.research ?? []).filter((r) => hit(r.title, r.body, r.topic, r.source_title));
  const links = (data?.research_links ?? []).filter((l) => hit(l.title, l.url));
  const story = research.find((r) => r.kind === "TREND_STORY" && /^Trend story\b/i.test(r.title)) ?? null;
  const storySources = research.filter((r) => r.kind === "TREND_STORY" && r.id !== story?.id);
  const byKind = (k: string) => research.filter((r) => r.kind === k);

  const addLink = async (): Promise<void> => {
    if (title.trim().length < 2 || !/^https:\/\/\S+$/i.test(url.trim())) {
      setMessage("Write a title, and a link that starts with https://");
      return;
    }
    const res = await api<{ detail?: string }>("/api/tlc/research-links", { method: "POST", body: { title: title.trim(), url: url.trim() } });
    if (res.status === 200) {
      setTitle("");
      setUrl("");
      setAdding(false);
      setMessage("Added to Research pages.");
      tlc.reload();
    } else setMessage(res.data?.detail ?? "That did not save. Try again.");
  };

  return (
    <section data-testid="research-library-page">
      <RoomsLinks current="research-library" />
      <p className="muted">What Parker and Wynn draw on. It updates quietly; nobody is emailed about it.</p>
      <div className="form-row">
        <label>
          Show
          <select value={show} onChange={(e) => setShow(e.target.value as ResearchShow)} data-testid="research-show">
            {RESEARCH_SHOW.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label>
          Search
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. fragrance" data-testid="research-search" />
        </label>
      </div>
      {message && <p className="notice" role="status">{message}</p>}
      {tlc.loading ? (
        <p className="state-empty">Reading the library…</p>
      ) : !data ? (
        <p className="state-empty">The library could not be read just now. Reload the page to try again.</p>
      ) : (
        <>
          {wants("pages") && (
            <section className="card" data-testid="research-pages">
              <div className="rooms-card-head">
                <h3>Research pages</h3>
                <span className="muted small">open in a new tab</span>
              </div>
              {links.length === 0 ? (
                <p className="state-empty">No research page yet. Add one below.</p>
              ) : (
                <ul className="card-list">
                  {links.map((l) => (
                    <li key={l.id} data-testid={`research-link-${l.id}`}>
                      <div className="rooms-card-head">
                        <strong>{l.title}</strong>
                        <a href={l.url} target="_blank" rel="noreferrer noopener">Open →</a>
                      </div>
                      <div className="muted small">Added by {l.added_by} · {dayWords(l.added_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
              {adding ? (
                <div className="form-row" data-testid="research-link-add">
                  <label>
                    Title
                    <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} data-testid="research-link-title" />
                  </label>
                  <label>
                    Link (https://…)
                    <input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} data-testid="research-link-url" />
                  </label>
                  <button type="button" onClick={() => void addLink()} data-testid="research-link-save">Add the research link</button>{" "}
                  <button type="button" className="link-button" onClick={() => setAdding(false)}>Cancel, change nothing</button>
                </div>
              ) : (
                <button type="button" className="link-button" onClick={() => setAdding(true)} data-testid="research-link-open">+ Add a research link</button>
              )}
            </section>
          )}

          {wants("TREND_STORY") && (
            <section className="card" data-testid="tlc-research">
              <div className="rooms-card-head">
                <h3>{story ? story.title : "Trend story"}</h3>
                {story && <span className="muted small">{story.found_by} · {dayWords(story.found_at)}</span>}
              </div>
              {!story && storySources.length === 0 ? (
                <p className="state-empty">No trend story yet. Wynn's quarterly research writes one.</p>
              ) : (
                <>
                  {story?.body && <p className="small">{clipWords(story.body, 220)}</p>}
                  <details className="small">
                    <summary>Read it with {storySources.length} source{storySources.length === 1 ? "" : "s"} ▾</summary>
                    {story?.body && <p style={{ whiteSpace: "pre-wrap" }}>{story.body}</p>}
                    <ul className="card-list">
                      {storySources.map((r) => <ResearchItem key={r.id} r={r} />)}
                    </ul>
                  </details>
                </>
              )}
            </section>
          )}

          {(["BRAND_SPEND", "TREND"] as const).map((k) =>
            wants(k) && byKind(k).length > 0 ? (
              <section className="card" key={k} data-testid={`research-${k.toLowerCase()}`}>
                <h3>{k === "BRAND_SPEND" ? "Brands spending now" : "Trends and curiosity"}</h3>
                <ul className="card-list">{byKind(k).map((r) => <ResearchItem key={r.id} r={r} />)}</ul>
              </section>
            ) : null,
          )}

          {wants("REGULATORY") && (
            <section className="card" data-testid="research-regulatory">
              <div className="rooms-card-head">
                <h3>Regulatory checks</h3>
                <span className="muted small">{byKind("REGULATORY").length}{byKind("REGULATORY")[0] ? ` · ${byKind("REGULATORY")[0]!.found_by} · ${dayWords(byKind("REGULATORY")[0]!.found_at)}` : ""}</span>
              </div>
              {byKind("REGULATORY").length === 0 ? (
                <p className="state-empty">No regulatory check yet.</p>
              ) : (
                <ul className="card-list">
                  {byKind("REGULATORY").map((r) => (
                    <li key={r.id}>
                      <details>
                        <summary><strong>{r.topic ?? "A check"}</strong> · Open ▾</summary>
                        <p className="small">{r.title}</p>
                        {r.body && <p className="small muted">{r.body}</p>}
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <HowThisWorksFold page="Research library" testId="research-how">
            <ul className="card-list small">
              <li>Every entry is dated and says what kind it is; facts carry their source.</li>
              <li>Parker and Wynn read the library whenever they build a club, a booking pack or a brand list. Wynn's quarterly research adds the trend story; Parker adds the regulatory checks.</li>
              <li>Research pages are longer write-ups, opened in a new tab. Add one with its title and link; it is kept with who added it and when.</li>
            </ul>
          </HowThisWorksFold>
        </>
      )}
    </section>
  );
}

function ResearchItem({ r }: { r: TlcResearch }): JSX.Element {
  return (
    <li>
      <span className="muted small">{r.kind_label} · {dayWords(r.published_on || r.found_at)} · {r.found_by}</span>
      <div>{r.topic && <strong>{r.topic}: </strong>}{r.title}</div>
      {r.body && <div className="muted small">{r.body}</div>}
      {r.source_url && (
        <div className="small"><a href={r.source_url} target="_blank" rel="noreferrer">{r.source_title || r.source_url.replace(/^https?:\/\//, "").slice(0, 60)}</a></div>
      )}
    </li>
  );
}
