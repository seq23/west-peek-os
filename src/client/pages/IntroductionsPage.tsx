import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";

/**
 * Introductions (P51, docs/COMMUNITY.md).
 *
 * "Good people should meet good people" is the community's founding line, and this is the only
 * page that acts on it directly.
 *
 * TWO DESIGN CHOICES WORTH KNOWING. First, an empty state here is SUCCESS, not failure — the
 * matcher is tuned so most months produce nothing, and the copy says so, because otherwise
 * somebody will "fix" the quiet by lowering the bar. Second, nothing on this page sends anything.
 * A partner writes the actual introduction; the page only gets them to the point of writing it
 * with both sides having said yes.
 */

interface MatchRow {
  id: string;
  person_a_id: string;
  person_b_id: string;
  person_a_name: string;
  person_b_name: string;
  rationale: string;
  need_signal: string | null;
  experience_signal: string | null;
  strength: number;
  status: string;
  consent_a: number;
  consent_b: number;
  approved_by: string | null;
}

interface SignalRow {
  id: string;
  person_id: string;
  full_name: string;
  kind: string;
  body: string;
  expires_at: string;
  expired: number;
}

const daysLeft = (iso: string): number =>
  Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);

/**
 * `embedded` is set when this renders INSIDE Community rather than as its own route.
 *
 * Embedded it drops its own explainer and steps its headings down a level, because a page that
 * opens with one heading and then contains two more of the same rank is not a hierarchy, and two
 * "How this works" panels on one page is one too many. The guidance is not lost — Community's own
 * panel carries it.
 */
export function IntroductionsPage({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
  const matches = useApi<{ matches: MatchRow[] }>("/api/introductions");
  const signals = useApi<{ signals: SignalRow[] }>("/api/introductions/signals");
  const people = useApi<{ people: { id: string; full_name: string }[] }>("/api/people?limit=300");
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(): Promise<void> {
    setRunning(true);
    const res = await api<{ detail: string }>("/api/introductions/run", { method: "POST", body: {} });
    setRunning(false);
    setMessage(res.data?.detail ?? `Could not run matching (${res.status}).`);
    matches.reload();
  }

  async function decide(id: string, decision: "APPROVE" | "DISMISS"): Promise<void> {
    const reason = decision === "DISMISS" ? window.prompt("Why not? (optional)") ?? undefined : undefined;
    await api(`/api/introductions/${id}`, { method: "POST", body: { decision, reason } });
    matches.reload();
  }

  async function consent(id: string, side: "A" | "B"): Promise<void> {
    await api(`/api/introductions/${id}/consent`, { method: "POST", body: { side } });
    matches.reload();
  }

  async function connected(id: string): Promise<void> {
    await api(`/api/introductions/${id}/connected`, { method: "POST", body: {} });
    matches.reload();
  }

  const rows = (matches.data?.matches ?? []).filter((m) => m.status !== "DISMISSED");
  // Which kind of empty this is. Told apart because they mean opposite things: one is a system
  // nobody has set up, the other is a bar that held.
  const peopleCount = people.data?.people?.length ?? 0;
  const signalCount = signals.data?.signals?.length ?? 0;

  return (
    <div className="stack">
      {!embedded && (
      <HowThisWorks
        title="Introductions"
        what="Suggested introductions between people we know, based on what one person needs and what another has actually done. Deliberately rare: a handful a month at most."
        when="When you have a few minutes to make a connection, or when you have just learned something about someone and want to write it down."
        operatorDoes={[
          "Note what someone needs or what they could help with",
          "Approve a suggestion worth pursuing, or dismiss it",
          "Ask both people, and record that they said yes",
          "Write the introduction yourself, then mark it made",
        ]}
        aiDoes={["Looks for pairs where one person's need meets another's experience, and writes the reason in a sentence you could paste into an email"]}
        requiresOperator={[
          "Every introduction. Nothing here sends anything — an introduction in West Peek's name is written by a person",
          "Asking both sides first. A connection either party resents costs more than it was worth",
        ]}
        next="Once both people have said yes, you write the introduction and mark it made. It is then recorded against both of them."
        blocked={[
          "Nothing suggested is the normal result. This only speaks up when a match is obvious — a quiet month means the bar held, not that it is broken.",
          "A pair is never suggested twice, including one you dismissed.",
          "Notes expire, so an old job hunt cannot resurface as a suggestion a year later.",
        ]}
        testId="introductions"
      />
      )}

      <section className="panel">
        <header className="panel-head">
          {embedded ? <h3>Introductions</h3> : <h2>Suggested</h2>}
          <button type="button" onClick={run} disabled={running} data-testid="run-matching">
            {running ? "Looking…" : "Look for matches"}
          </button>
        </header>
        {message && <p className="notice" data-testid="matching-message">{message}</p>}

        {rows.length === 0 ? (
          /* THREE DIFFERENT EMPTINESSES, and they used to read identically. "Nothing to suggest,
             that is the normal state" is TRUE once there are people and notes to match on — and
             actively misleading before that, when the real answer is that nothing has been set up
             yet. A page that says "working as intended" to somebody staring at an unconfigured
             system teaches them to distrust it. */
          <p className="muted" data-testid="no-matches">
            {peopleCount === 0 ? (
              <>
                <strong>No people to match yet.</strong> Network OS owns who the community is, and
                none are visible here. Once members exist, note what each one needs or could help
                with, and suggestions come from that.
              </>
            ) : signalCount === 0 ? (
              <>
                <strong>Nothing to match on yet.</strong> {peopleCount} {peopleCount === 1 ? "person" : "people"}{" "}
                known, but nothing written down about what any of them need or could help with.
                That is what matching runs on — add a note or two below.
              </>
            ) : (
              <>
                <strong>Nothing obvious this month.</strong> That is the normal result and not a
                fault: this stays quiet unless a match is clear, because an introduction spends West
                Peek&apos;s credibility. {signalCount} note{signalCount === 1 ? "" : "s"} on{" "}
                {peopleCount} {peopleCount === 1 ? "person" : "people"} were considered.
              </>
            )}
          </p>
        ) : (
          <ul className="card-list">
            {rows.map((m) => (
              <li key={m.id} className="card" data-testid={`match-${m.id}`}>
                <div className="card-head-static">
                  <strong>{m.person_a_name} → {m.person_b_name}</strong>
                  <span className={`pill pill-${m.status.toLowerCase()}`}>{m.status.replace(/_/g, " ").toLowerCase()}</span>
                </div>
                <div className="card-body stack">
                  <p>{m.rationale}</p>

                  {m.status === "PROPOSED" && (
                    <div className="row">
                      <button type="button" className="primary" onClick={() => decide(m.id, "APPROVE")} data-testid={`approve-match-${m.id}`}>
                        Worth doing — ask them both
                      </button>
                      <button type="button" onClick={() => decide(m.id, "DISMISS")}>Not this one</button>
                    </div>
                  )}

                  {m.status === "CONSENT_PENDING" && (
                    <>
                      <p className="muted">Ask each of them before connecting them.</p>
                      <div className="row">
                        <button type="button" disabled={m.consent_a === 1} onClick={() => consent(m.id, "A")}>
                          {m.consent_a === 1 ? `${m.person_a_name} said yes ✓` : `${m.person_a_name} said yes`}
                        </button>
                        <button type="button" disabled={m.consent_b === 1} onClick={() => consent(m.id, "B")}>
                          {m.consent_b === 1 ? `${m.person_b_name} said yes ✓` : `${m.person_b_name} said yes`}
                        </button>
                      </div>
                    </>
                  )}

                  {m.status === "CONSENTED" && (
                    <div className="row">
                      <p className="muted">Both said yes. Write the introduction, then:</p>
                      <button type="button" className="primary" onClick={() => connected(m.id)} data-testid={`connected-${m.id}`}>
                        I made the introduction
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SignalEntry
        embedded={embedded}
        people={people.data?.people ?? []}
        signals={signals.data?.signals ?? []}
        onChanged={() => { signals.reload(); }}
      />
    </div>
  );
}

/**
 * Writing down what you know about someone.
 *
 * The expiry is shown on every note, not hidden in a setting. "Looking for a job" is true for a
 * season, and a partner seeing "expires in 118 days" understands the model immediately — that this
 * is a note with a shelf life, not a permanent label on a person.
 */
function SignalEntry(props: {
  people: { id: string; full_name: string }[];
  signals: SignalRow[];
  embedded?: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [personId, setPersonId] = useState("");
  const [kind, setKind] = useState<"NEED" | "OFFER">("NEED");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add(): Promise<void> {
    setError(null);
    const res = await api<{ detail?: string }>("/api/introductions/signals", {
      method: "POST", body: { person_id: personId, kind, body },
    });
    if (res.status === 201) { setBody(""); props.onChanged(); }
    else setError(res.data?.detail ?? `Could not save that (${res.status}).`);
  }

  async function retire(id: string): Promise<void> {
    await api(`/api/introductions/signals/${id}/retire`, { method: "POST", body: {} });
    props.onChanged();
  }

  return (
    <section className="panel">
      {props.embedded ? <h3>What we know about people</h3> : <h2>What we know</h2>}
      <p className="muted">
        Write down what someone needs, or what they could help someone else with. This is what
        matching runs on. Notes expire after about four months so an old situation cannot resurface
        as a suggestion — renew one that is still true.
      </p>

      <div className="row">
        <select value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Person" data-testid="signal-person">
          <option value="">Who…</option>
          {props.people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Kind">
          <option value="NEED">is looking for…</option>
          <option value="OFFER">can help with…</option>
        </select>
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={kind === "NEED" ? "a job in climate hardware" : "hiring a first engineering team"}
          aria-label="What"
          data-testid="signal-body"
        />
        <button type="button" onClick={add} disabled={!personId || body.trim().length < 8} data-testid="add-signal">
          Note it
        </button>
      </div>
      {error && <p className="warn">{error}</p>}

      {props.signals.length === 0 ? (
        <p className="muted">Nothing noted yet.</p>
      ) : (
        <ul className="card-list">
          {props.signals.map((s) => {
            const left = daysLeft(s.expires_at);
            return (
              <li key={s.id} className="card" data-testid={`signal-${s.id}`}>
                <div className="card-head-static">
                  <span>
                    <strong>{s.full_name}</strong>{" "}
                    {s.kind === "NEED" ? "is looking for" : "can help with"} {s.body}
                  </span>
                  <span className={s.expired ? "pill pill-expired" : "muted"}>
                    {s.expired ? "expired" : `${left} day${left === 1 ? "" : "s"} left`}
                  </span>
                </div>
                <div className="card-body">
                  <button type="button" onClick={() => retire(s.id)}>No longer true</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
