import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { DeliverableList } from "./DeliverableList";

/**
 * Ask — one page, one way.
 *
 * WHAT THIS REPLACED, and why it was rebuilt rather than tidied. This page carried TWO products.
 * The original was "work packets": you wrote a rough thought, the system derived ambiguities,
 * assumptions, risks, acceptance criteria and a lens stack, and you executed the packet. Ask was
 * built on top of it later and folded the packet flow into a disclosure — so the page had an old
 * way and a new way, and the old one's vocabulary (packet, lens bench, blocking, acceptance
 * criteria) sat in accordions underneath the new one.
 *
 * Zero packets were ever created through that flow, in months. Not because the machinery was bad —
 * the lens gate is genuinely good — but because no partner has ever thought in those words. The
 * operator asked ten times for it to stop being a separate thing, and folding it away repeatedly
 * was the wrong answer to the wrong question: a disclosure still means the page has two products,
 * one of them hidden.
 *
 * So there is one way now. You describe what you need. The system decides which of four things it
 * is and does that thing. What it has produced is listed on the page, not behind a control. What
 * checks the work before it runs is explained on the page, in the same words.
 *
 * THE FOUR OUTCOMES, and the distinctions that make them worth separating:
 *   GO    — the answer already exists on a page. A task to go and look at something already there
 *           is not work; it is a wrong turn.
 *   TELL  — answerable outright. No page, no work.
 *   WORK  — somebody has to carry it. That is a card: an owner and a next action.
 *   BRIEF — you want a document. Nobody carries a brief; you asked for it and you receive it.
 *
 * WORK vs BRIEF is the one that took longest to see, and it is the distinction the old packet flow
 * never made: "check whether Psyflo still lists a VP of Sales" is one act and then it is over;
 * "what are comparable seed valuations in devtools" needs gathering, weighing and writing up, and
 * what you want at the end is a page you can read.
 *
 * ONE THING CAME BACK, AND IT IS NOT THE OLD FLOW. Removing the packet vocabulary from the front of
 * this page was right. Removing every control that could REACH the checks was not, and it was not
 * noticed for months: `/api/work-packets/*` stayed live and stayed enforcing — an adverse verdict
 * on a blocking check refuses to run, and so does a blocking check nobody looked at — while nothing
 * in the interface could read a verdict, record one, or run the work afterwards. So the gate the
 * section below spends two paragraphs explaining was a gate a partner could not open, close, or
 * see the far side of. What is back is that: what the checks are holding, and a box to put
 * something under them on purpose. It sits inside the section that explains what a check IS, and
 * it is not offered as a second way to ask for something, because it is not one.
 */

/** What Ask can ask for, grouped by what comes back — so the shape of the answer is visible first. */
const EXAMPLES: ReadonlyArray<{ group: string; note: string; items: readonly string[] }> = [
  {
    group: "Find something out",
    note: "becomes work somebody carries",
    items: [
      "check whether Psyflo still lists a VP of Sales",
      "review a portfolio founder's homepage and say what to fix",
      "which accelerators in Texas back pre-seed B2B software",
    ],
  },
  {
    group: "Write it up for me",
    note: "comes back as a document you can keep",
    items: [
      "what are comparable seed valuations in devtools right now",
      "brief me on the AI infrastructure market before Thursday",
      "what should we know about Sputnik ATX before we talk to them",
    ],
  },
  {
    group: "Where do I…",
    note: "sends you to the page that already has it",
    items: [
      "what has the firm spent on AI so far",
      "where do I see what is waiting on my approval",
      "where is this week's agenda",
    ],
  },
];

interface Draft {
  title: string;
  next_action: string | null;
  prompt: string;
  owner_id: string | null;
  owner_name: string | null;
  needs_browser: boolean;
  reasoning: string;
}

interface BriefRequest {
  title: string;
  question: string;
  suggested_author: string | null;
  needs_browser: boolean;
  reasoning: string;
}

interface AskResult {
  outcome: "GO" | "WORK" | "TELL" | "BRIEF";
  says: string;
  page: string | null;
  draft: Draft | null;
  brief?: BriefRequest | null;
  note?: string;
}

interface LensDef {
  key: string;
  name: string;
  job: string;
  blocking: boolean;
}

// ── The checks, and the work sitting under them ───────────────────────────────────────────────

interface PacketRow {
  id: string;
  original_text: string;
  status: string;
  ambiguities_json: string;
  acceptance_criteria_json: string;
  lens_stack_json: string;
  work_card_id: string | null;
  created_at: string;
}

interface LensOutputRow {
  id: string;
  lens_key: string;
  verdict: string;
  critique: string;
  produced_by_type: string;
  created_at: string;
}

/** How careful the derivation should be, said as a choice a person can make. */
const CARE = [
  { key: "STANDARD", label: "Normal — say what is unclear and what done looks like" },
  { key: "DEEP", label: "Careful — and make somebody argue the other side" },
  { key: "LIGHT", label: "Light — a quick reading" },
  { key: "NONE", label: "None — take my words exactly as written" },
] as const;

/** A verdict, in the words somebody giving one would use. */
const VERDICTS = [
  { key: "PASS", label: "Nothing in the way" },
  { key: "CONCERN", label: "A concern, but not a stop" },
  { key: "ADVERSE", label: "This should not run" },
] as const;

/** Where a request stands with the checks. The stored value never reaches a reader. */
function packetStanding(status: string): string {
  switch (status) {
    case "DRAFT": return "waiting on its checks";
    case "READY": return "ready to run";
    case "BLOCKED_BY_LENS": return "stopped by a check";
    case "EXECUTING": return "running now";
    case "COMPLETE": return "it ran";
    case "FAILED": return "it ran and failed";
    case "CANCELLED": return "called off";
    default: return "no state recorded";
  }
}

/** JSON columns arrive as text. A list that will not parse is shown as empty rather than crashing. */
function list(json: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(json ?? "[]");
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * One request under the checks — its own words, what is unclear about them, and every check.
 *
 * WHY THIS EXISTS AND THE OLD PACKET FLOW STILL DOES NOT. The page above is the one way to ask for
 * something, and this is not a second one. It is the only place a partner can see what a check has
 * STOPPED, and clear it or leave it stopped. Until now `/api/work-packets/*` was live and enforcing
 * — an adverse blocking verdict refuses, and so does a blocking check nobody ran — with no control
 * anywhere in the interface for reading the verdict, recording one, or running the work afterwards.
 * A gate nobody can reach is not a gate; it is a dead end with a rule attached.
 *
 * A VERDICT IS A PERSON'S, AND IT IS WRITTEN ONCE. The check cannot be re-run to get a better
 * answer: the record is append-only, and changing your mind means a fresh request rather than an
 * edited verdict. That is the whole reason it is worth anything.
 */
function PacketPanel({ packetId, lenses, onChanged }: { packetId: string; lenses: LensDef[]; onChanged: () => void }): JSX.Element {
  const detail = useApi<{ packet: PacketRow; lens_outputs: LensOutputRow[] }>(`/api/work-packets/${packetId}`, [packetId]);
  const [running, setRunning] = useState<string | null>(null);
  const [verdict, setVerdict] = useState("PASS");
  const [critique, setCritique] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const p = detail.data?.packet ?? null;
  const outputs = detail.data?.lens_outputs ?? [];
  const stack = list(p?.lens_stack_json);
  const byKey = new Map(outputs.map((o) => [o.lens_key, o]));

  async function recordVerdict(key: string) {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-packets/${packetId}/lenses`, {
      method: "POST",
      body: { lens_key: key, verdict, critique: critique.trim() },
    });
    setBusy(false);
    if (res.status !== 201) {
      setMsg(res.data?.detail ?? res.data?.error ?? `Not recorded (HTTP ${res.status}).`);
      return;
    }
    setMsg("Recorded, in your words. It cannot be edited or run again.");
    setRunning(null);
    setCritique("");
    detail.reload();
    onChanged();
  }

  async function execute() {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-packets/${packetId}/execute`, { method: "POST", body: {} });
    setBusy(false);
    setMsg(
      res.status === 200
        ? "It ran. The card it opened is on Work, with whoever is carrying it."
        : (res.data?.detail ?? res.data?.error ?? `It did not run (HTTP ${res.status}).`),
    );
    detail.reload();
    onChanged();
  }

  return (
    <div className="card" data-testid={`packet-${packetId}`}>
      <h4>What was asked for</h4>
      <p className="closeout-quote">{p?.original_text ?? "Reading it…"}</p>
      <p className="muted small">{p ? packetStanding(p.status) : "…"}</p>

      {list(p?.ambiguities_json).length > 0 && (
        <ul className="card-list small" data-testid={`packet-unclear-${packetId}`}>
          {list(p?.ambiguities_json).map((a) => (
            <li key={a} className="muted">{a}</li>
          ))}
        </ul>
      )}
      {list(p?.acceptance_criteria_json).length > 0 && (
        <ul className="card-list small" data-testid={`packet-done-${packetId}`}>
          {list(p?.acceptance_criteria_json).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}

      <h4>The checks on this one</h4>
      <ul className="card-list small" data-testid={`packet-lenses-${packetId}`}>
        {stack.map((key) => {
          const def = lenses.find((l) => l.key === key);
          const out = byKey.get(key);
          return (
            <li key={key} data-testid={`packet-lens-${key}`}>
              <strong>{def?.name ?? "A check that is no longer configured"}</strong>{" "}
              {def?.blocking && <span className="badge badge-gate">can stop the work</span>}{" "}
              {out ? (
                <span className={out.verdict === "ADVERSE" ? "help-tag help-tag-warn" : out.verdict === "CONCERN" ? "help-tag help-tag-muted" : "help-tag help-tag-good"}>
                  {VERDICTS.find((v) => v.key === out.verdict)?.label ?? "answered"}
                </span>
              ) : (
                <span className="help-tag help-tag-warn">nobody has looked yet</span>
              )}
              {out ? (
                <div className="closeout-quote">{out.critique}</div>
              ) : running === key ? (
                <div className="form-row">
                  <label>
                    What you found{" "}
                    <input
                      data-testid={`packet-critique-${key}`}
                      value={critique}
                      onChange={(e) => setCritique(e.target.value)}
                      placeholder="internal analysis of records we already hold"
                    />
                  </label>
                  <label>
                    Verdict{" "}
                    <select data-testid={`packet-verdict-${key}`} value={verdict} onChange={(e) => setVerdict(e.target.value)}>
                      {VERDICTS.map((v) => (
                        <option key={v.key} value={v.key}>{v.label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn-strong"
                    disabled={busy || critique.trim().length < 4}
                    data-testid={`packet-lens-save-${key}`}
                    onClick={() => void recordVerdict(key)}
                  >
                    Record it
                  </button>
                  <button type="button" data-testid={`packet-lens-cancel-${key}`} onClick={() => setRunning(null)}>
                    Not now
                  </button>
                </div>
              ) : (
                <button type="button" className="link-button" data-testid={`packet-lens-open-${key}`} onClick={() => { setRunning(key); setCritique(""); setVerdict("PASS"); }}>
                  Look at it and say
                </button>
              )}
            </li>
          );
        })}
        {stack.length === 0 && (
          <li className="state-empty">No check applies to this one, so nothing is gating it.</li>
        )}
      </ul>

      <div className="form-row">
        <button type="button" className="btn-strong" disabled={busy || p?.status === "COMPLETE"} data-testid="packet-execute" onClick={() => void execute()}>
          Run it
        </button>
        <span className="muted small">
          A check that can stop the work stops it, and so does one nobody has looked at — silence is
          not a pass.
        </span>
      </div>

      {p?.work_card_id && (
        <p className="muted small" data-testid={`packet-card-${packetId}`}>
          It opened a work card. Whoever is carrying it picks it up from Work.
        </p>
      )}
      {msg && <p className="notice small" data-testid={`packet-message-${packetId}`} role="status">{msg}</p>}
    </div>
  );
}

export function IntentPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }): JSX.Element {
  const bench = useApi<{ lenses: LensDef[]; storage_rule: string }>("/api/work-packets/lens-bench");

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  /* The checked path: its own words, its own state, deliberately not shared with the box above. */
  const [packetNonce, setPacketNonce] = useState(0);
  const packets = useApi<{ packets: PacketRow[] }>("/api/work-packets", [packetNonce]);
  const [packetText, setPacketText] = useState("");
  const [care, setCare] = useState("STANDARD");
  const [packetBusy, setPacketBusy] = useState(false);
  const [packetMsg, setPacketMsg] = useState<string | null>(null);
  const [openPacketId, setOpenPacketId] = useState<string | null>(null);

  async function openPacket() {
    setPacketBusy(true);
    setPacketMsg(null);
    const res = await api<{ packet?: PacketRow; error?: string; detail?: string }>("/api/work-packets", {
      method: "POST",
      body: { text: packetText.trim(), enhancement_strength: care },
    });
    setPacketBusy(false);
    if (res.status !== 201 || !res.data?.packet) {
      setPacketMsg(res.data?.detail ?? res.data?.error ?? `Not opened (HTTP ${res.status}).`);
      return;
    }
    setPacketMsg("Under the checks. Nothing runs until every check that can stop it has been looked at.");
    setPacketText("");
    setOpenPacketId(res.data.packet.id);
    setPacketNonce((n) => n + 1);
  }
  const [draft, setDraft] = useState<Draft | null>(null);
  const [nonce, setNonce] = useState(0);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (text.trim().length < 8) return;
    setBusy(true);
    setMsg(null);
    setResult(null);
    setDraft(null);
    const res = await api<AskResult & { detail?: string; error?: string }>("/api/intent/draft", {
      method: "POST",
      body: { text: text.trim() },
    });
    setBusy(false);
    if (res.status === 200 && res.data) {
      setResult(res.data);
      setDraft(res.data.draft);
      setMsg(res.data.note || null);
    } else {
      setMsg(res.data?.detail ?? res.data?.error ?? `Could not work that out (HTTP ${res.status}).`);
    }
  }

  /** Create the card. Nothing exists until this is pressed — the draft above is a proposal. */
  async function addCard() {
    if (!draft) return;
    setBusy(true);
    const res = await api<{ id?: string; detail?: string; error?: string }>("/api/work-cards", {
      method: "POST",
      body: {
        title: draft.title,
        ...(draft.next_action ? { next_action: draft.next_action } : {}),
        prompt: draft.prompt,
        owner_type: draft.owner_id ? "AI" : "UNASSIGNED",
        ...(draft.owner_id ? { owner_id: draft.owner_id } : {}),
      },
    });
    // Permission granted while the card is written, so work that plainly needs the web is not
    // blocked on a second thing to remember.
    if (res.status === 201 && draft.needs_browser && res.data?.id) {
      await api(`/api/work-cards/${res.data.id}/browser-permission`, { method: "POST", body: { allows_browser: true } });
    }
    setBusy(false);
    if (res.status === 201) {
      setDraft(null);
      setResult(null);
      setText("");
      setMsg("Added to Work.");
    } else {
      setMsg(`Not added: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    }
  }

  /** Commission the brief. Nothing is written until this is pressed. */
  async function writeBrief() {
    if (!result?.brief) return;
    setBusy(true);
    setMsg(null);
    const res = await api<{ note?: string; detail?: string; error?: string }>("/api/intent/brief", {
      method: "POST",
      body: {
        title: result.brief.title,
        question: result.brief.question,
        ...(result.brief.suggested_author ? { author: result.brief.suggested_author } : {}),
      },
    });
    setBusy(false);
    if (res.status === 201) {
      setResult(null);
      setText("");
      setMsg(res.data?.note ?? "Written and filed.");
      setNonce((n) => n + 1);
    } else {
      setMsg(`Could not write it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    }
  }

  return (
    <section data-testid="intent-page">
      {/* ── Asking ─────────────────────────────────────────────────────────────────────────── */}
      <section className="card ask-card">
        <h3>What do you need?</h3>
        <p className="small">
          In your own words, {me.fullName.split(" ")[0]}. Ask works out which of four things it is —
          a page that already holds the answer, an answer it can give you outright, work somebody
          has to carry, or a document to be written — and shows you the plan before anything happens.
        </p>

        <form className="form-row" onSubmit={ask} data-testid="ask-form">
          <input
            className="field-wide"
            data-testid="ask-text"
            aria-label="What you need, in your own words"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. what are comparable seed valuations in devtools right now"
          />
          <button type="submit" className="btn-strong" disabled={busy || text.trim().length < 8} data-testid="ask-submit">
            {busy ? "Working it out…" : "Ask"}
          </button>
        </form>

        {/* Shown until the first ask. A blank box is a hard question for anyone who does not
            already know what the system can do — which is exactly who this is for. */}
        {!result && (
          <div className="ask-examples-grid" data-testid="ask-examples">
            {EXAMPLES.map((g) => (
              <div key={g.group}>
                <p className="muted small">
                  <strong>{g.group}</strong> — {g.note}
                </p>
                <ul className="card-list small">
                  {g.items.map((ex) => (
                    <li key={ex}>
                      <button type="button" className="link-button" onClick={() => setText(ex)}>
                        {ex}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {msg && <p className="notice small" data-testid="ask-message">{msg}</p>}

        {/* ── GO: the answer already exists ─────────────────────────────────────────────── */}
        {result?.outcome === "GO" && result.page && (
          <div className="ask-answer" data-testid="ask-go">
            <p>{result.says}</p>
            <div className="form-row">
              <button type="button" className="btn-strong" onClick={() => onNavigate(result.page!)}>
                Take me there
              </button>
              <span className="muted small">No work needed — this already exists.</span>
            </div>
          </div>
        )}

        {/* ── TELL: answerable outright ─────────────────────────────────────────────────── */}
        {result?.outcome === "TELL" && (
          <div className="ask-answer" data-testid="ask-tell">
            <p>{result.says}</p>
          </div>
        )}

        {/* ── WORK: somebody has to carry it ────────────────────────────────────────────── */}
        {result?.outcome === "WORK" && draft && (
          <div className="ask-answer" data-testid="ask-draft">
            <p>{result.says}</p>
            <div className="card">
              <h4>{draft.title}</h4>
              {draft.next_action && (
                <p className="small">
                  <span className="lbl">Next</span> {draft.next_action}
                </p>
              )}
              <p className="muted small">
                {draft.owner_name ? `${draft.owner_name} would carry it` : "Nobody assigned yet"}
                {draft.needs_browser ? " · it may need to read pages on the web" : ""}
              </p>
              {draft.reasoning && <p className="muted small">{draft.reasoning}</p>}

              <label className="ask-prompt">
                <span className="lbl">What they will be told to do</span>
                <textarea
                  rows={8}
                  aria-label="The instruction the employee will work from"
                  data-testid="ask-draft-prompt"
                  value={draft.prompt}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                />
              </label>
              <p className="muted small">
                Written for you because these employees are language models — a vague instruction is
                the difference between an answer and a paragraph of hedging. Change anything.
              </p>
            </div>

            <div className="form-row">
              <button type="button" className="btn-strong" disabled={busy} onClick={() => void addCard()} data-testid="ask-draft-add">
                {busy ? "…" : "Add to Work"}
              </button>
              <button type="button" onClick={() => { setDraft(null); setResult(null); }}>Not that</button>
              <span className="muted small">Nothing exists until you add it.</span>
            </div>
          </div>
        )}

        {/* ── BRIEF: you want a document ────────────────────────────────────────────────── */}
        {result?.outcome === "BRIEF" && result.brief && (
          <div className="ask-answer" data-testid="ask-brief">
            <p>{result.says}</p>
            <div className="card">
              <h4>{result.brief.title}</h4>
              <p className="small">
                <span className="lbl">Answers</span> {result.brief.question}
              </p>
              <p className="muted small">
                {result.brief.suggested_author ? `${result.brief.suggested_author} would write it` : "Whoever owns research would write it"}
                {result.brief.needs_browser ? " · reading live sources" : ""}
              </p>
              {result.brief.reasoning && <p className="muted small">{result.brief.reasoning}</p>}
            </div>
            <div className="form-row">
              <button type="button" className="btn-strong" disabled={busy} onClick={() => void writeBrief()} data-testid="ask-brief-write">
                {busy ? "Writing…" : "Write it"}
              </button>
              <button type="button" onClick={() => setResult(null)}>Not that</button>
              <span className="muted small">Signed, filed, and on your Home page when it is done.</span>
            </div>
          </div>
        )}
      </section>

      {/* ── What this page has produced ────────────────────────────────────────────────────
          On the page, not behind a control. A page that produces documents and then hides them
          reads as a page that does nothing. */}
      <section data-testid="ask-produced">
        <div className="home-section-head">
          <h3>What you have asked for</h3>
          <span className="muted small">every brief this page has written, newest first</span>
        </div>
        <DeliverableList
          kind="ask_brief"
          limit={10}
          onNavigate={onNavigate}
          key={nonce}
          emptyNote="Nothing yet. Ask for something above — if what you want back is a document rather than a task, it lands here, signed and filed."
        />
      </section>

      {/* ── What checks the work ───────────────────────────────────────────────────────────
          Also on the page. The lens gate is the most valuable thing the old flow had and the least
          understood — "weird and no one understands it" — because it was named rather than
          explained, in a drawer, in its own vocabulary. */}
      <section data-testid="ask-lenses">
        <div className="home-section-head">
          <h3>What checks it before it runs</h3>
          <span className="muted small">the same checks, whatever you ask for</span>
        </div>
        <p className="small">
          A <strong>check</strong> reads the work before it is allowed to happen and returns a
          verdict — does this claim have evidence behind it, does it cross a compliance line, does
          it commit the firm to something only a partner can commit to.
        </p>
        <p className="small">
          A check marked <strong>can stop the work</strong> does exactly that: an adverse verdict
          means the request does not run. Neither does it run if that check was never applied —
          silence is not a pass, because the expensive mistakes are the ones nobody looked for.
        </p>
        <ul className="card-list small" data-testid="lens-bench">
          {(bench.data?.lenses ?? []).map((l) => (
            <li key={l.key}>
              <strong>{l.name}</strong>{" "}
              {l.blocking && <span className="badge badge-gate">can stop the work</span>} — {l.job}
            </li>
          ))}
          {!bench.loading && (bench.data?.lenses ?? []).length === 0 && (
            <li className="state-empty">No checks are configured, so nothing is being gated.</li>
          )}
        </ul>
        {bench.data?.storage_rule && (
          <p className="muted small" data-testid="lens-storage-rule">{bench.data.storage_rule}</p>
        )}

        {/*
          ── AND WHAT IS ACTUALLY UNDER THEM ────────────────────────────────────────────────────
          Not a second way to ask. The box above is still the one way. This is the only place a
          partner can see what a check has STOPPED and either clear it or leave it stopped — the
          gate has been live and enforcing this whole time with nothing in the interface able to
          reach it, which made it a dead end rather than a gate.
        */}
        <h4>Put something through the checks yourself</h4>
        <p className="small">
          For work that has to be looked at before it happens rather than after. Your words are kept
          exactly as you write them and are never rewritten; what comes back beside them is what is
          unclear about them and what finishing would look like.
        </p>
        <div className="form-row">
          <label>
            What you want done{" "}
            <input
              data-testid="intent-text"
              value={packetText}
              onChange={(e) => setPacketText(e.target.value)}
              placeholder="look into the Acme secondary soon and tell me if we should take the block"
            />
          </label>
          <label>
            How closely to read it{" "}
            <select data-testid="intent-strength" value={care} onChange={(e) => setCare(e.target.value)}>
              {CARE.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-strong"
            disabled={packetBusy || packetText.trim().length < 8}
            data-testid="intent-submit"
            onClick={() => void openPacket()}
          >
            Put it under the checks
          </button>
        </div>
        {packetMsg && <p className="notice small" data-testid="intent-message" role="status">{packetMsg}</p>}

        <h4>What the checks are holding</h4>
        <ul className="card-list small" data-testid="packet-list">
          {(packets.data?.packets ?? []).map((p) => (
            <li key={p.id} data-testid={`packet-row-${p.id}`}>
              <button type="button" className="link-button" data-testid={`packet-open-${p.id}`} onClick={() => setOpenPacketId(openPacketId === p.id ? null : p.id)}>
                {p.original_text}
              </button>{" "}
              <span className="muted">{packetStanding(p.status)}</span>
              {openPacketId === p.id && (
                <PacketPanel packetId={p.id} lenses={bench.data?.lenses ?? []} onChanged={() => setPacketNonce((n) => n + 1)} />
              )}
            </li>
          ))}
          {(packets.data?.packets ?? []).length === 0 && (
            <li className="state-empty" data-testid="no-packets">
              {packets.loading
                ? "Reading what is under the checks…"
                : "Nothing is under the checks. Anything put here stays put until every check that can stop it has been looked at."}
            </li>
          )}
        </ul>
      </section>

      <HowThisWorks
        title="Ask"
        testId="ask"
        what="Describe what you need in your own words. Ask works out whether the answer already exists, whether it can just tell you, whether somebody has to carry it, or whether you want a document — and shows you the plan before anything happens."
        when="Whenever you are not sure which part of the firm owns something, or you want a written answer rather than a task."
        operatorDoes={[
          "Say what you need, in a sentence.",
          "Read what comes back and change it if the shape is wrong.",
          "Press the button. Nothing is created or written until you do.",
        ]}
        aiDoes={[
          "Decides which of the four things your request is, and says why.",
          "Writes the instruction the employee will work from, or writes the brief itself.",
        ]}
        requiresOperator={[
          "Creating the card. Writing the brief. Neither happens without you pressing it.",
        ]}
        next="A card goes to Work and whoever owns it picks it up. A brief is written, signed, filed in Documents, and appears on your Home page."
        blocked={[
          "A check that can stop the work returned an adverse verdict, or was never applied — silence is not a pass.",
          "No AI employee is switched on, so nobody can write anything.",
        ]}
      />
    </section>
  );
}
