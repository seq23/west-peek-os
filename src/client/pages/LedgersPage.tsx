import { useState } from "react";
import { useApi } from "../lib/api";
import { actorName } from "@shared/help/actionNames";
import { HowThisWorks } from "./HowThisWorks";

/**
 * Decision Journal, Evidence Ledger and Work Queues (P35, V1 #10, #34, #35).
 *
 * Three read-only views over records that already existed and had nowhere to be seen. Grouped on
 * one page because they answer three halves of the same question — what did we decide, on what
 * evidence, and who is doing the work that came out of it.
 *
 * The Evidence Ledger's job is to make ONE distinction obvious: a claim with no source row is not
 * a weak claim, it is an unsupported assertion. So unsourced claims are flagged, not buried in a
 * confidence score.
 */

type View = "decisions" | "evidence" | "queues";

interface JournalEntry {
  kind: string; id: string; decision: string; rationale: string | null;
  decided_by: string; decided_at: string; subject: string | null;
}
interface ClaimRow {
  id: string; claim_text: string; claim_status: string; confidence: string | null;
  company_name: string | null; superseded_by: string | null; unsourced: boolean;
  sources: Array<{ source_type: string; location: string | null; source_date: string | null; method: string | null }>;
}
interface Queue {
  owner_type: string; owner_id: string | null; owner_name: string;
  cards: Array<{ id: string; title: string; state: string; due_at: string | null; next_action: string | null }>;
}

const KIND_LABEL: Record<string, string> = {
  IC: "Investment", APPROVAL: "Approval", BUILD_VS_BUY: "Build vs buy", SOURCE_CONFLICT: "Source conflict",
};

export function LedgersPage(): JSX.Element {
  const [view, setView] = useState<View>("decisions");
  const decisions = useApi<{ entries: JournalEntry[]; counts: Record<string, number>; truncated: boolean }>("/api/decisions");
  const evidence = useApi<{ claims: ClaimRow[]; truncated: boolean }>("/api/evidence-ledger");
  const queues = useApi<{ queues: Queue[]; blocked_count: number; total_open: number }>("/api/work-queues");

  const unsourced = (evidence.data?.claims ?? []).filter((c) => c.unsourced).length;

  return (
    <div className="page" data-testid="ledgers-page">
      <p className="muted">What the firm decided, what it knows, and who is doing the work.</p>

      <nav className="ic-tabs" data-testid="ledger-tabs">
        <button type="button" className={view === "decisions" ? "ic-tab ic-tab-active" : "ic-tab"} data-testid="ledger-tab-decisions" onClick={() => setView("decisions")}>
          Decision journal
        </button>
        <button type="button" className={view === "evidence" ? "ic-tab ic-tab-active" : "ic-tab"} data-testid="ledger-tab-evidence" onClick={() => setView("evidence")}>
          Evidence ledger
        </button>
        <button type="button" className={view === "queues" ? "ic-tab ic-tab-active" : "ic-tab"} data-testid="ledger-tab-queues" onClick={() => setView("queues")}>
          Work queues
        </button>
      </nav>

      {/*
        A TABBED page, so the tab nav above is what selects the section — which is why the three
        headings here used to restate their own tab's label ("Decision journal" under a tab reading
        "Decision journal"), the same wasted line the nine duplicated page titles were. They are now
        h3, outside the card in LpPage's shape, and phrased as the question a partner is actually
        asking: a label tells you what a table is called, a question tells you why you would read it.
      */}
      {view === "decisions" && (
        <>
        <h3>What have we decided, and why?</h3>
        <section className="card" data-testid="decision-journal">
          <p className="muted small">
            Every decision, from all four places the firm records them. Append-only at the database —
            nothing here can be edited after the fact.
          </p>
          {(decisions.data?.entries ?? []).length === 0 ? (
            <p className="state-empty" data-testid="decisions-empty">No decisions recorded yet.</p>
          ) : (
            <ul className="card-list small" data-testid="decisions-list">
              {decisions.data!.entries.map((e) => (
                <li key={`${e.kind}-${e.id}`} data-testid={`decision-${e.id}`}>
                  <span className="help-tag help-tag-muted">{KIND_LABEL[e.kind] ?? e.kind}</span>{" "}
                  <strong>{e.decision}</strong>
                  {e.subject && <> — {e.subject}</>}
                  <div className="muted small">
                    {/* Was the raw firm_user id, on the page that exists to be the readable
                        record of what this firm decided. */}
                    {actorName(e.decided_by)} · {new Date(e.decided_at).toLocaleString()}
                  </div>
                  {e.rationale && <div className="muted small">{e.rationale}</div>}
                </li>
              ))}
            </ul>
          )}
          {decisions.data?.truncated && (
            <p className="muted small" data-testid="decisions-truncated">
              Showing the most recent entries only — this is not the full history.
            </p>
          )}
        </section>
        </>
      )}

      {view === "evidence" && (
        <>
        <h3>What are we treating as true, and what backs it?</h3>
        <section className="card" data-testid="evidence-ledger">
          <p className="muted small">Every claim, with where it came from.</p>
          {unsourced > 0 && (
            <p className="notice" data-testid="evidence-unsourced-count">
              <strong>{unsourced}</strong> claim{unsourced === 1 ? " has" : "s have"} no source. An
              unsourced claim is an assertion, not evidence.
            </p>
          )}
          {(evidence.data?.claims ?? []).length === 0 ? (
            <p className="state-empty" data-testid="evidence-empty">No claims recorded yet.</p>
          ) : (
            <ul className="card-list small" data-testid="evidence-list">
              {evidence.data!.claims.map((c) => (
                <li key={c.id} data-testid={`claim-${c.id}`}>
                  <span className={c.unsourced ? "help-tag help-tag-warn" : "help-tag help-tag-good"}>
                    {c.unsourced ? "unsourced" : `${c.sources.length} source${c.sources.length === 1 ? "" : "s"}`}
                  </span>{" "}
                  <strong>{c.claim_text}</strong>{" "}
                  <span className="muted small">
                    {c.claim_status.toLowerCase()}
                    {c.company_name && ` · ${c.company_name}`}
                    {c.superseded_by && " · superseded"}
                  </span>
                  {c.sources.length > 0 && (
                    <ul className="card-list small">
                      {c.sources.map((s, i) => (
                        <li key={i} className="muted small">
                          {s.source_type}
                          {s.location && ` · ${s.location}`}
                          {s.source_date && ` · ${s.source_date}`}
                          {s.method && ` · ${s.method}`}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        </>
      )}

      {view === "queues" && (
        <>
        <h3>Who is carrying what right now?</h3>
        <section className="card" data-testid="work-queues">
          <p className="muted small">
            {queues.data?.total_open ?? 0} open{" "}
            {queues.data?.blocked_count ? (
              <strong data-testid="queues-blocked">· {queues.data.blocked_count} blocked</strong>
            ) : null}
          </p>
          {(queues.data?.queues ?? []).length === 0 ? (
            <p className="state-empty" data-testid="queues-empty">No open work.</p>
          ) : (
            queues.data!.queues.map((q) => (
              <div key={`${q.owner_type}:${q.owner_id}`} data-testid={`queue-${q.owner_id ?? "unassigned"}`}>
                {/* h4: a thing inside a section. Nothing on any page goes deeper than this. */}
                <h4>
                  {q.owner_name}{" "}
                  <span className="muted small">
                    {q.owner_type.toLowerCase()} · {q.cards.length} card{q.cards.length === 1 ? "" : "s"}
                  </span>
                </h4>
                <ul className="card-list small">
                  {q.cards.map((c) => (
                    <li key={c.id}>
                      <span className={c.state === "BLOCKED" ? "help-tag help-tag-warn" : "help-tag help-tag-muted"}>
                        {c.state.toLowerCase().replace("_", " ")}
                      </span>{" "}
                      {c.title}
                      {c.due_at && <span className="muted small"> · due {c.due_at}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
        </>
      )}

      <HowThisWorks
        title="Record"
        testId="ledgers"
        what="Three read-only views: every decision the firm has made, every claim and where it came from, and what work each AI employee is holding."
        when="When you need to know what was decided and why, whether something is actually evidenced, or whether work is moving."
        operatorDoes={["Read. Nothing on this page changes anything."]}
        aiDoes={["Nothing. These are queries over records other parts of the system wrote."]}
        requiresOperator={["Acting on what you find here — the pages that own each record are where changes happen."]}
        next="The decision journal reads the four decision tables directly rather than keeping its own copy, so it cannot drift from what actually happened."
        blocked={["Nothing blocks reading. Long histories are truncated, and the page says so rather than implying you are seeing everything."]}
      />
    </div>
  );
}
