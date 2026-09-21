import { useState } from "react";
import { api, useApi } from "../lib/api";
import { readableDate } from "../lib/dates";

/**
 * A WEB PROPERTY CHANGE ON THE WORK PAGE (20 Sep 2026, Plan A).
 *
 * Two things a partner needs to see on Porter's card without opening a run log:
 *
 *   1. WHERE IT IS. The phase (plan → build → land), the Drive folder it works from, the plan as a
 *      Document (opened under Documents), what Porter decided without asking and what he asked,
 *      the answers, the PR and what `gh pr checks` said, the merge and the live proof. Every row is
 *      a fact from `web_property_change`, never a sentence the model wrote about itself.
 *   2. THE STANDING RULES OF THE KIND, as rows (`work_kind_rule`): land on green (her decision of
 *      20 Sep, ON), the model per phase, the one-live-run cap, the no-iteration rule. A Managing
 *      Partner flips the editable ones here; the others say so and are changed in a commit.
 */

interface ChangeRow {
  work_card_id: string;
  target_repo: string;
  property_host: string | null;
  drive_folder_id: string | null;
  drive_folder_url: string | null;
  phase: "PLAN" | "BUILD" | "LAND" | "DONE";
  plan_document_id: string | null;
  plan_filed_at: string | null;
  decided: string[];
  asks: string[];
  answers: string[];
  plan_approved_at: string | null;
  plan_approved_by: string | null;
  pr_url: string | null;
  pr_number: number | null;
  check_state: "PENDING" | "GREEN" | "RED" | null;
  check_url: string | null;
  check_green_at: string | null;
  build_proof: string | null;
  merge_sha: string | null;
  landed_at: string | null;
  live_proof: string | null;
  current_run: { id: string; status: string; claimed_by: string | null; claimed_at: string | null; progressed_at: string | null; progress_note: string | null } | null;
  /** 0220: readiness, the preview, and the named bypass. */
  publish_ready: number;
  placeholders: string[];
  preview_only: number;
  needs_preview: boolean;
  preview_url: string | null;
  preview_emailed_at: string | null;
  land_approved_at: string | null;
  forced_by_name: string | null;
  forced_at: string | null;
  forced_placeholders: string[];
  /** 0221: the request is the specification; the files are its assets; what the partner has been told. */
  request_text: string | null;
  pre_approved_phrase: string | null;
  attachments: Array<{ id: string; filename: string; media_type: string; bytes: number }>;
  notices: Array<{ kind: string; cause: string; sent: number; sent_at: string }>;
}

const PHASES: Array<{ key: ChangeRow["phase"]; label: string }> = [
  { key: "PLAN", label: "Plan" },
  { key: "BUILD", label: "Build" },
  { key: "LAND", label: "Land" },
  { key: "DONE", label: "Done" },
];

function phaseIndex(p: ChangeRow["phase"]): number {
  return PHASES.findIndex((x) => x.key === p);
}

export function WebPropertyChangePanel({ cardId, onNavigate }: { cardId: string; onNavigate: (k: string) => void }): JSX.Element {
  const { data, loading, status } = useApi<ChangeRow>(`/api/work-cards/${cardId}/web-property-change`);
  if (loading && !data) return <p className="small" data-testid={`wpc-loading-${cardId}`}>Reading where this change is…</p>;
  if (!data) return <p className="small" data-testid={`wpc-missing-${cardId}`}>{status === 404 ? "This card is marked as a web property change but carries no folder or repo yet — the next run asks for them." : "Could not read where this change is."}</p>;
  const r = data;
  const at = phaseIndex(r.phase);
  const run = r.current_run;
  const runLine = run
    ? run.status === "QUEUED"
      ? `${r.phase} is queued for the Mac — waiting for it to claim the job`
      : run.status === "CLAIMED"
        ? `${r.phase} is running on ${run.claimed_by ?? "the Mac"}${run.progress_note ? ` — ${run.progress_note}` : ""}${run.progressed_at ? ` (heard ${readableDate(run.progressed_at)})` : ""}`
        : `${r.phase}: last run ${run.status.toLowerCase()}`
    : r.phase === "DONE"
      ? "Landed and proven live."
      : "Nothing is on the Mac right now; the next sweep decides the next step.";

  return (
    <div className="card-block" data-testid={`work-card-wpc-${cardId}`}>
      <p className="lbl">Web property change · {r.property_host ?? r.target_repo}</p>
      <ol className="wpc-phases" aria-label="Phases" data-testid={`wpc-phases-${cardId}`}>
        {PHASES.map((p, i) => (
          <li key={p.key} data-state={i < at ? "done" : i === at ? "now" : "next"} aria-current={i === at ? "step" : undefined}>
            {p.label}
          </li>
        ))}
      </ol>
      <p className="small" role="status" data-testid={`wpc-run-${cardId}`}>{runLine}</p>
      {r.plan_filed_at && (
        <p className="wpc-readiness" data-testid={`wpc-readiness-${cardId}`}>
          <span className={r.publish_ready === 1 ? "badge badge-ok" : "badge badge-gate"}>{r.publish_ready === 1 ? "publish-ready" : `not publish-ready · ${r.placeholders.length} placeholder${r.placeholders.length === 1 ? "" : "s"}`}</span>
          {r.preview_only === 1 && <span className="badge">preview first, by request</span>}
          {r.needs_preview && !r.forced_by_name && <span className="badge">{r.land_approved_at ? "landing approved after the preview" : "lands on a second approval"}</span>}
          {r.forced_by_name && (
            <span className="badge badge-bad" data-testid={`wpc-forced-${cardId}`} title={r.forced_at ? readableDate(r.forced_at) : undefined}>
              forced to production by {r.forced_by_name}
            </span>
          )}
        </p>
      )}
      <dl className="wpc-facts">
        {r.request_text && (
          <div>
            <dt>The request</dt>
            <dd><pre className="wpc-proof" data-testid={`wpc-request-${cardId}`}>{r.request_text}</pre>{r.pre_approved_phrase && <span className="badge">pre-approved: "{r.pre_approved_phrase}"</span>}</dd>
          </div>
        )}
        {r.attachments.length > 0 && (
          <div>
            <dt>Attached</dt>
            <dd>
              <ul className="wpc-list" data-testid={`wpc-attachments-${cardId}`}>
                {r.attachments.map((a) => (
                  <li key={a.id}>
                    <a href={`/api/work-cards/${cardId}/attachments/${a.id}`} target="_blank" rel="noopener noreferrer">{a.filename}</a> <span className="small">({a.media_type}, {Math.round(a.bytes / 1024)} KB)</span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        <div>
          <dt>Package</dt>
          <dd>
            {r.drive_folder_url ? (
              <a href={r.drive_folder_url} target="_blank" rel="noopener noreferrer">Drive folder {r.drive_folder_id}</a>
            ) : (
              "no Drive folder on the card"
            )}
          </dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>
            {r.plan_document_id ? (
              <button
                type="button"
                className="link-button"
                data-testid={`wpc-plan-${cardId}`}
                onClick={() => {
                  try {
                    window.sessionStorage.setItem("wpos.documents.focus", r.plan_document_id!);
                  } catch {
                    /* fine */
                  }
                  onNavigate("documents");
                }}
              >
                Open the plan (filed {r.plan_filed_at ? readableDate(r.plan_filed_at) : ""})
              </button>
            ) : (
              "not written yet"
            )}
            {r.plan_approved_at && <span className="small"> · approved {readableDate(r.plan_approved_at)}</span>}
          </dd>
        </div>
        {r.placeholders.length > 0 && (
          <div>
            <dt>Ships as placeholders</dt>
            <dd>
              <ul className="wpc-list" data-testid={`wpc-placeholders-${cardId}`}>{(r.forced_placeholders.length ? r.forced_placeholders : r.placeholders).map((p, i) => <li key={i}>{p}</li>)}</ul>
            </dd>
          </div>
        )}
        {r.preview_url && (
          <div>
            <dt>Preview</dt>
            <dd><a href={r.preview_url} target="_blank" rel="noopener noreferrer" data-testid={`wpc-preview-${cardId}`}>{r.preview_url}</a></dd>
          </div>
        )}
        {r.decided.length > 0 && (
          <div>
            <dt>Decided without asking</dt>
            <dd>
              <ul className="wpc-list" data-testid={`wpc-decided-${cardId}`}>{r.decided.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </dd>
          </div>
        )}
        {r.asks.length > 0 && (
          <div>
            <dt>Asked</dt>
            <dd>
              <ol className="wpc-list" data-testid={`wpc-asks-${cardId}`}>{r.asks.map((a, i) => <li key={i}>{a}</li>)}</ol>
            </dd>
          </div>
        )}
        {r.answers.length > 0 && (
          <div>
            <dt>Answered</dt>
            <dd>
              <ul className="wpc-list" data-testid={`wpc-answers-${cardId}`}>{r.answers.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </dd>
          </div>
        )}
        <div>
          <dt>Pull request</dt>
          <dd data-testid={`wpc-pr-${cardId}`}>
            {r.pr_url ? (
              <>
                <a href={r.pr_url} target="_blank" rel="noopener noreferrer">#{r.pr_number ?? "?"}</a>
                {" · checks "}
                <span className={r.check_state === "GREEN" ? "badge badge-ok" : r.check_state === "RED" ? "badge badge-bad" : "badge badge-gate"}>{r.check_state ?? "not run"}</span>
                {r.check_url && (
                  <>
                    {" "}
                    <a href={r.check_url} target="_blank" rel="noopener noreferrer" className="small">what CI said</a>
                  </>
                )}
              </>
            ) : (
              "not opened yet"
            )}
          </dd>
        </div>
        {r.build_proof && (
          <div>
            <dt>Build proof</dt>
            <dd><pre className="wpc-proof" data-testid={`wpc-build-proof-${cardId}`}>{r.build_proof}</pre></dd>
          </div>
        )}
        <div>
          <dt>Landed</dt>
          <dd data-testid={`wpc-landed-${cardId}`}>{r.merge_sha ? `${r.merge_sha.slice(0, 10)} · ${r.landed_at ? readableDate(r.landed_at) : ""}` : "not yet"}</dd>
        </div>
        {r.notices.length > 0 && (
          <div>
            <dt>Told the partner</dt>
            <dd data-testid={`wpc-notices-${cardId}`}>{r.notices.map((n) => `${n.kind}${n.sent ? "" : " (not sent)"} · ${readableDate(n.sent_at)}`).join(" · ")}</dd>
          </div>
        )}
        {r.live_proof && (
          <div>
            <dt>Live proof</dt>
            <dd><pre className="wpc-proof" data-testid={`wpc-live-proof-${cardId}`}>{r.live_proof}</pre></dd>
          </div>
        )}
      </dl>
    </div>
  );
}

interface KindRule {
  kind: string;
  rule_key: string;
  label: string;
  value: string;
  editable: number;
  note: string;
  set_by: string | null;
  set_at: string;
}

/** The standing rules of a card kind, as rows. `canEdit` is "is a Managing Partner". */
export function WorkKindRules({ kind, canEdit }: { kind: string; canEdit: boolean }): JSX.Element {
  const { data, loading, reload } = useApi<{ rules: KindRule[]; model_aliases: string[] }>(`/api/work-kinds/${kind}/rules`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function set(rule: KindRule, value: string): Promise<void> {
    setBusy(rule.rule_key);
    setError(null);
    const out = await api<{ ok?: boolean; detail?: string }>(`/api/work-kinds/${kind}/rules/${rule.rule_key}`, { method: "PATCH", body: { value } });
    setBusy(null);
    if (out.status >= 400) setError(out.data?.detail ?? `Could not change "${rule.label}" (${out.status}).`);
    reload();
  }

  if (loading && !data) return <p className="small">Reading the standing rules…</p>;
  const rules = data?.rules ?? [];
  if (rules.length === 0) return <p className="small" data-testid={`kind-rules-empty-${kind}`}>No standing rules are recorded for this kind.</p>;
  return (
    <div className="card-block" data-testid={`kind-rules-${kind}`}>
      <p className="lbl">Standing rules for this kind</p>
      <ul className="kind-rules">
        {rules.map((rule) => {
          const isSwitch = rule.rule_key === "land_on_green";
          const isModel = rule.rule_key.startsWith("model_");
          const on = ["on", "1", "true", "yes"].includes(rule.value.toLowerCase());
          return (
            <li key={rule.rule_key} data-testid={`kind-rule-${rule.rule_key}`}>
              <div className="kind-rule-head">
                <strong>{rule.label}</strong>
                {rule.editable === 1 && canEdit ? (
                  isSwitch ? (
                    <button
                      type="button"
                      className="switch"
                      role="switch"
                      aria-checked={on}
                      aria-label={rule.label}
                      aria-busy={busy === rule.rule_key}
                      disabled={busy !== null}
                      data-testid={`kind-rule-switch-${rule.rule_key}`}
                      onClick={() => void set(rule, on ? "off" : "on")}
                    >
                      <i aria-hidden="true" />
                    </button>
                  ) : isModel ? (
                    <select
                      aria-label={rule.label}
                      value={rule.value}
                      disabled={busy !== null}
                      data-testid={`kind-rule-select-${rule.rule_key}`}
                      onChange={(e) => void set(rule, e.target.value)}
                    >
                      {(data?.model_aliases ?? ["opus", "sonnet", "haiku"]).map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="badge">{rule.value}</span>
                  )
                ) : (
                  <span className={isSwitch ? (on ? "badge badge-ok" : "badge badge-gate") : "badge"} data-testid={`kind-rule-value-${rule.rule_key}`}>
                    {isSwitch ? (on ? "on" : "off") : rule.value}
                  </span>
                )}
              </div>
              <p className="small">
                {rule.note}
                {rule.editable === 0 && " Changed in a commit, not here."}
              </p>
            </li>
          );
        })}
      </ul>
      {error && <p className="field-help err" data-testid={`kind-rules-error-${kind}`}>{error}</p>}
    </div>
  );
}
