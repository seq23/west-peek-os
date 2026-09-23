import { useState, type ReactNode } from "react";
import { api, useApi } from "../lib/api";
import { readableDate, shortDate } from "../lib/dates";
import { ON_OFF_RULE_KEYS } from "../../shared/work/localJobs";
import { SITE_STAGES, siteStage } from "../../shared/work/siteChange";

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
  /** Set only for a card planned before 0231 — a filed Document this card can still open. */
  plan_document_id: string | null;
  /** 0231: the plan's own text, on the card — read here instead of navigating to Documents. */
  plan_text: string | null;
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
  /** 0224: a Managing Partner's own words for the finished email, and who last wrote them. */
  requester_notes: string | null;
  requester_notes_by_name: string | null;
  requester_notes_at: string | null;
  /** 0236: a job over several repos — one PR, check, preview and merge per repo. Empty for one repo. */
  /** The ONE preview link for the card's own site, derived server-side from structured fields. */
  preview_link?: string | null;
  parts?: Array<{ repo: string; property_host: string; pr_url: string | null; pr_number: number | null; check_state: "PENDING" | "GREEN" | "RED" | null; check_url: string | null; preview_url: string | null; merge_sha: string | null }>;
}

/**
 * THE WORK-CARD REDESIGN (23 Sep 2026). Her words: "it should be truly collapsed with only the
 * title and in progress and the necessary things showing then a big chevron … that has everything".
 *
 * This panel is the website half of that "everything": the four stages in plain English (Where it
 * is), the dated list of what has happened beside the facts (The details), and nothing else. It no
 * longer prints its own run line — "PLAN is running on …" was a second reading of what the card is
 * doing, and `liveStatus` (shared/work/liveStatus.ts) is now the only one. It renders only inside the
 * expanded card (`work/CardExpanded.tsx`), never on the collapsed row.
 */
export function useSiteChange(cardId: string | null): { data: ChangeRow | null; loading: boolean; status: number | null; reload: () => void } {
  return useApi<ChangeRow>(cardId ? `/api/work-cards/${cardId}/web-property-change` : null, [cardId]);
}

export type { ChangeRow as SiteChangeRow };

function stageWords(r: ChangeRow, i: number, at: number, owner: string, done: boolean): string {
  const host = r.property_host ?? r.target_repo;
  const state = done || i < at ? "done" : i === at ? "now" : "next";
  switch (SITE_STAGES[i]!.key) {
    case "PLAN":
      if (state === "done") return `Done. The plan was written${r.plan_filed_at ? ` ${shortDate(r.plan_filed_at)}` : ""}${r.plan_approved_at ? " and you approved it" : ""}.`;
      return `${state === "now" ? "Now. " : ""}${owner} reads ${r.drive_folder_url ? "your Drive folder" : "your request"} and writes the plan, then emails you ${owner === "Porter" ? "his" : "the"} questions.`;
    case "BUILD":
      if (state === "done") return `Done.${r.pr_number ? ` Code change #${r.pr_number}` : ""}${r.check_state === "GREEN" ? ", checks passed" : ""}.`;
      return state === "now" ? `Now. ${owner} changes only ${host} and opens a code change for the checks.` : `After you answer. Changes only ${host}.`;
    case "PREVIEW":
      if (!needsPreviewOf(r)) return r.forced_by_name ? `Skipped: ${r.forced_by_name} said "approved to production".` : "Skipped for this change.";
      if (state === "done") return `Done. You approved it${r.land_approved_at ? ` ${shortDate(r.land_approved_at)}` : ""}.`;
      return state === "now" ? `Now. The preview link is in your email; nothing goes live until you reply "approved".` : `You get a preview link. Nothing goes live until you reply "approved".`;
    case "LIVE":
    default:
      if (done) return `Live${r.landed_at ? ` since ${shortDate(r.landed_at)}` : ""}. The done email went to you.`;
      return state === "now" ? "Now. Putting it live, then a done email to you." : "Published, then a done email to you.";
  }
}

function needsPreviewOf(r: Pick<ChangeRow, "preview_only" | "publish_ready" | "forced_by_name">): boolean {
  return (r.preview_only === 1 || r.publish_ready === 0) && !r.forced_by_name;
}

/** Where it is — the four stages, each in a sentence. */
export function SiteStages({ row: r, owner }: { row: ChangeRow; owner: string }): JSX.Element {
  const stage = siteStage(r);
  return (
    <ol className="wc-stages" aria-label="Where it is" data-testid={`wpc-phases-${r.work_card_id}`}>
      {SITE_STAGES.map((p, i) => {
        const state = stage.finished || i < stage.index ? "done" : i === stage.index ? "now" : "next";
        return (
          <li key={p.key} className="wc-stage" data-state={state} aria-current={state === "now" ? "step" : undefined}>
            <span className="wc-stage-name">
              {i + 1} · {p.label}
            </span>
            <span className="wc-stage-words">{stageWords(r, i, stage.index, owner, stage.finished)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The details — every fact on the row, one line each, and only the lines that have something to
 * say beyond "not yet". `lead` carries the rows every card shares (Asked by), so the website facts
 * sit under them in one list rather than in a box of their own.
 */
export function SiteDetails({
  row: r,
  cardId,
  onNavigate,
  recipient,
  lead,
  tail,
  gate,
}: {
  row: ChangeRow;
  /** The site's preview gate as the desk draws it (work/sitePreviewBadge.ts), for "Before it goes live". */
  gate?: ReactNode;
  cardId: string;
  onNavigate: (k: string) => void;
  recipient: ReactNode;
  lead?: ReactNode;
  /** Rows every card shares that belong after the site's own (the "Hold for you first" switch). */
  tail?: ReactNode;
}): JSX.Element {
  const preview = needsPreviewOf(r);
  return (
    <dl className="wc-details" data-testid={`wpc-details-${cardId}`}>
      {lead}
      <dt>Site</dt>
      <dd>
        {r.parts?.length ? (
          <ul className="wpc-list" data-testid={`wpc-parts-${cardId}`}>
            {r.parts.map((p) => (
              <li key={p.repo}>
                {p.property_host}
                {p.pr_url && (
                  <>
                    {" · "}
                    <a href={p.pr_url} target="_blank" rel="noopener noreferrer">
                      code change #{p.pr_number ?? "?"}
                    </a>{" "}
                    <span className={p.check_state === "GREEN" ? "badge badge-ok" : p.check_state === "RED" ? "badge badge-bad" : "badge badge-gate"}>{checkWords(p.check_state)}</span>
                  </>
                )}
                {p.preview_url && (
                  <>
                    {" · "}
                    <a href={p.preview_url} target="_blank" rel="noopener noreferrer">
                      preview
                    </a>
                  </>
                )}
                {p.merge_sha && " · live"}
              </li>
            ))}
          </ul>
        ) : (
          (r.property_host ?? "Not decided yet — the next run asks which site")
        )}
      </dd>
      <dt>Materials</dt>
      <dd>
        {r.drive_folder_url || r.attachments.length > 0 ? (
          <span className="wc-inline-list">
            {r.drive_folder_url && (
              <a href={r.drive_folder_url} target="_blank" rel="noopener noreferrer" data-testid={`wpc-folder-${cardId}`}>
                Drive folder
              </a>
            )}
            {r.attachments.map((a) => (
              <a key={a.id} href={`/api/work-cards/${cardId}/attachments/${a.id}`} target="_blank" rel="noopener noreferrer">
                {a.filename}
              </a>
            ))}
          </span>
        ) : (
          <span className="wc-quiet">None sent with the request</span>
        )}
      </dd>
      <dt>Plan</dt>
      <dd>
        {/* 0231, Addendum 4.3: the plan is on the card, never filed into Documents. A card planned
            before 0231 still carries a filed Document, kept openable rather than rewriting old data. */}
        {r.plan_text ? (
          <details data-testid={`wpc-plan-${cardId}`}>
            <summary className="link-button">Read the plan{r.plan_approved_at ? " (you approved it)" : ""}</summary>
            <pre className="wpc-proof" data-testid={`wpc-plan-text-${cardId}`}>{r.plan_text}</pre>
          </details>
        ) : r.plan_document_id ? (
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
            Open the plan
          </button>
        ) : (
          <span className="wc-quiet">Not written yet</span>
        )}
      </dd>
      <dt>Code change</dt>
      <dd data-testid={`wpc-pr-${cardId}`}>
        {r.parts?.length ? (
          <span className="wc-quiet">One per site, listed above</span>
        ) : r.pr_url ? (
          <>
            <a href={r.pr_url} target="_blank" rel="noopener noreferrer">
              #{r.pr_number ?? "?"}
            </a>{" "}
            <span className={r.check_state === "GREEN" ? "badge badge-ok" : r.check_state === "RED" ? "badge badge-bad" : "badge badge-gate"}>{checkWords(r.check_state)}</span>
            {r.check_url && (
              <>
                {" "}
                <a href={r.check_url} target="_blank" rel="noopener noreferrer">
                  what the checks said
                </a>
              </>
            )}
          </>
        ) : (
          <span className="wc-quiet">Not opened yet</span>
        )}
      </dd>
      <dt>Preview link</dt>
      <dd>
        {r.preview_url && !r.parts?.length ? (
          <a href={r.preview_url} target="_blank" rel="noopener noreferrer" data-testid={`wpc-preview-${cardId}`}>
            {r.preview_url}
          </a>
        ) : (
          <span className="wc-quiet">{r.parts?.length ? "One per site, listed above" : "Comes at step 3"}</span>
        )}
      </dd>
      <dt>Before it goes live</dt>
      <dd data-testid={`wpc-gate-${cardId}`}>
        {r.forced_by_name ? (
          <span className="badge badge-bad" data-testid={`wpc-forced-${cardId}`} title={r.forced_at ? readableDate(r.forced_at) : undefined}>
            Straight to live: {r.forced_by_name} said "approved to production"
          </span>
        ) : gate ? (
          gate
        ) : preview ? (
          <span className="badge badge-ok" data-testid={`wpc-preview-first-${cardId}`}>
            Preview first · always on
          </span>
        ) : (
          <span className="badge">Off · goes live when the checks pass</span>
        )}
      </dd>
      <dt>Finished email goes to</dt>
      <dd data-testid={`wpc-recipient-${cardId}`}>{recipient}</dd>
      {tail}
      {r.placeholders.length > 0 && (
        <>
          <dt>Still missing</dt>
          <dd>
            <ul className="wpc-list" data-testid={`wpc-placeholders-${cardId}`}>
              {(r.forced_placeholders.length ? r.forced_placeholders : r.placeholders).map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {r.decided.length > 0 && (
        <>
          <dt>Decided without asking</dt>
          <dd>
            <ul className="wpc-list" data-testid={`wpc-decided-${cardId}`}>
              {r.decided.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {r.asks.length > 0 && (
        <>
          <dt>Asked you</dt>
          <dd>
            <ol className="wpc-list" data-testid={`wpc-asks-${cardId}`}>
              {r.asks.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ol>
          </dd>
        </>
      )}
      {r.answers.length > 0 && (
        <>
          <dt>You answered</dt>
          <dd>
            <ul className="wpc-list" data-testid={`wpc-answers-${cardId}`}>
              {r.answers.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {r.build_proof && (
        <>
          <dt>Build proof</dt>
          <dd>
            <pre className="wpc-proof" data-testid={`wpc-build-proof-${cardId}`}>{r.build_proof}</pre>
          </dd>
        </>
      )}
      {r.merge_sha && (
        <>
          <dt>Went live</dt>
          <dd data-testid={`wpc-landed-${cardId}`}>{r.landed_at ? readableDate(r.landed_at) : "yes"}</dd>
        </>
      )}
      {r.live_proof && (
        <>
          <dt>Live proof</dt>
          <dd>
            <pre className="wpc-proof" data-testid={`wpc-live-proof-${cardId}`}>{r.live_proof}</pre>
          </dd>
        </>
      )}
    </dl>
  );
}

function checkWords(state: "PENDING" | "GREEN" | "RED" | null): string {
  return state === "GREEN" ? "checks passed" : state === "RED" ? "checks failed" : state === "PENDING" ? "checks running" : "checks not run";
}

/**
 * THE WEBSITE HALF OF THE EXPANDED CARD: where it is, then what has happened beside the details.
 * `timeline` and `lead` come from the card (`work/CardExpanded.tsx`), which every kind shares; the
 * row can be handed in so the card fetches it once for this panel and the note beside it.
 */
export function WebPropertyChangePanel({
  cardId,
  onNavigate,
  site,
  owner = "Porter",
  recipient = "You",
  timeline,
  lead,
  tail,
  gate,
}: {
  cardId: string;
  gate?: ReactNode;
  onNavigate: (k: string) => void;
  tail?: ReactNode;
  canEdit?: boolean;
  /** The row, already fetched by the card (`useSiteChange`), so it is read once for this panel and the note beside it. */
  site?: { data: ChangeRow | null; loading: boolean; status: number | null };
  owner?: string;
  recipient?: ReactNode;
  timeline?: ReactNode;
  lead?: ReactNode;
}): JSX.Element {
  const own = useSiteChange(site ? null : cardId);
  const { data, loading, status } = site ?? own;
  if (loading && !data) return <p className="small" data-testid={`wpc-loading-${cardId}`}>Reading where this change is…</p>;
  if (!data) {
    return (
      <div className="wc-where" data-testid={`work-card-wpc-${cardId}`}>
        <p className="small" data-testid={`wpc-missing-${cardId}`}>
          {status === 404
            ? "Nothing has started on this site change yet. Its first run reads the request and asks for the folder or the site if either is missing."
            : "Could not read where this change is."}
        </p>
        <div className="wc-columns">
          <section className="wc-section">
            <h4 className="wc-label">What has happened</h4>
            {timeline}
          </section>
          <section className="wc-section">
            <h4 className="wc-label">The details</h4>
            <dl className="wc-details">{lead}{tail}</dl>
          </section>
        </div>
      </div>
    );
  }
  return (
    <div className="wc-where" data-testid={`work-card-wpc-${cardId}`}>
      <section className="wc-section">
        <h4 className="wc-label">Where it is</h4>
        <SiteStages row={data} owner={owner} />
      </section>
      <div className="wc-columns">
        <section className="wc-section">
          <h4 className="wc-label">What has happened</h4>
          {timeline}
        </section>
        <section className="wc-section">
          <h4 className="wc-label">The details</h4>
          <SiteDetails row={data} cardId={cardId} onNavigate={onNavigate} recipient={recipient} lead={lead} tail={tail} gate={gate} />
        </section>
      </div>
    </div>
  );
}

/**
 * HER WORDS ON THE FINISHED EMAIL (0224, 22 Sep 2026).
 *
 * Reading Porter's finished email before it goes out is worth little if the only two answers are
 * "send it" and "send it back". What she actually wanted on Scooter's forms card was to send
 * Porter's report WITH a line of her own in it, and doing that took editing a rendered email body
 * in the database by hand. So the card carries the line, and the DONE reply carries a section in
 * her name — and only the DONE reply: a question Porter is asking is his question, not hers.
 *
 * A MANAGING PARTNER'S ONLY. The API refuses anyone else; without the role the words still SHOW,
 * because who spoke for the firm on a piece of work is a fact about it, not a control.
 */
export function RequesterNotes({
  cardId,
  notes,
  byName,
  at,
  canEdit,
  onSaved,
}: {
  cardId: string;
  notes: string | null;
  byName: string | null;
  at: string | null;
  canEdit: boolean;
  onSaved: () => void;
}): JSX.Element | null {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? notes ?? "";

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    const out = await api<{ detail?: string }>(`/api/work-cards/${cardId}`, { method: "PATCH", body: { requester_notes: value.trim() || null } });
    setBusy(false);
    if (out.status >= 400) {
      setError(out.data?.detail ?? `Could not save your words (${out.status}).`);
      return;
    }
    setDraft(null);
    onSaved();
  }

  if (!canEdit && !notes) return null;
  /* RELABELLED, NOT REBUILT (23 Sep 2026, the work-card redesign). "Your words on the finished
     email" sat beside "Tell Porter something" and read as a second way to instruct him. It is not:
     it is printed in the done email under her name. The label says which of the two boxes is which. */
  return (
    <div className="wc-pair-col" data-testid={`wpc-requester-notes-${cardId}`}>
      <label className="wc-label" htmlFor={`wpc-requester-notes-text-${cardId}`}>
        A note in the finished email
      </label>
      {canEdit ? (
        <>
          <textarea
            id={`wpc-requester-notes-text-${cardId}`}
            rows={3}
            value={value}
            disabled={busy}
            data-testid={`wpc-requester-notes-text-${cardId}`}
            placeholder="Printed in the done email under your name. Not an instruction to Porter."
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="wc-pair-actions">
            <button type="button" disabled={busy} data-testid={`wpc-requester-notes-save-${cardId}`} onClick={() => void save()}>
              {busy ? "Saving…" : "Save note"}
            </button>
            <span className="wc-quiet" data-testid={`wpc-requester-notes-by-${cardId}`}>
              {byName && at ? `${byName} wrote this ${readableDate(at)}.` : "Goes out with the finished work and nothing else."}
            </span>
          </div>
        </>
      ) : (
        <>
          <p data-testid={`wpc-requester-notes-read-${cardId}`}>{notes}</p>
          <p className="wc-quiet" data-testid={`wpc-requester-notes-by-${cardId}`}>
            {byName && at ? `${byName} wrote this ${readableDate(at)}. It goes out with the finished work and nothing else.` : "Goes out with the finished work and nothing else."}
          </p>
        </>
      )}
      {error && <p className="field-help err" data-testid={`wpc-requester-notes-error-${cardId}`}>{error}</p>}
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
          /*
           * A SWITCH IS WHATEVER THE SHARED LIST SAYS IT IS (22 Sep 2026). This line used to name
           * `land_on_green` and only `land_on_green`, and the Worker's PATCH route had its own copy
           * of the same name. Migration 0223's "Show me the finished email before it goes" is
           * editable and would have rendered here as a read-only badge — a rule a partner can read
           * and cannot change. `validate:kind-rule-switches` holds the two sides to this one list.
           */
          const isSwitch = ON_OFF_RULE_KEYS.includes(rule.rule_key);
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
