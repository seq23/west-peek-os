import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { readableDate } from "../lib/dates";
import { WorkKindRules } from "./WebPropertyChangePanel";

/**
 * STANDING RULES, MOVED OFF THE CARD (Addendum 1/7, Wave A, 22 Sep 2026).
 *
 * `WebPropertyChangePanel.tsx` used to render "show me the finished email first" / "land on
 * green" inline on the individual card, with no indication they are global policy for every card
 * of that kind rather than this one card's own setting — confirmed against the real reviewed
 * mockup PDF. `WorkKindRules` (the rule list itself) is unchanged and reused here verbatim; only
 * where it renders moved. The card's own page ends with a small pointer here instead.
 *
 * ─── AND THE FIRM-WIDE DIAL LEADS THE PAGE (Addendum 8, 22 Sep 2026) ─────────────────────────
 *
 * Her correction: "show me the finished email before it goes" is not a Porter thing. It is a
 * trust dial across every AI employee while she is still tailing their work — "maybe we change
 * this to be a setting I can apply to all work cards, or turn off when I feel confident." That
 * dial is firm-wide, not per-kind, so it leads this page above the per-kind list, which stays as
 * the override for a future case where one kind needs its own answer.
 */
export function WorkKindRulesPage({ kind, me, onBack }: { kind: string; me: MeResponse; onBack: () => void }): JSX.Element {
  const canEdit = me.roles.includes("MANAGING_PARTNER");
  return (
    <section data-testid="work-kind-rules-page" className="work-surface">
      <header className="work-masthead">
        <div className="work-masthead-said">
          <p className="work-eyebrow">Standing rules</p>
          <h2>Every {kind} card</h2>
          <p className="muted small">
            Policy for every card of this kind, not one card's own setting. A card's own page shows
            the card; this is where the rule for the whole kind lives.
          </p>
        </div>
        <button type="button" onClick={onBack} data-testid="work-kind-rules-back">
          ← Back to Work
        </button>
      </header>

      <EmailPreviewDial canEdit={canEdit} />

      <div className="work-band-head">
        <h3>Overrides for {kind} alone</h3>
        <p className="work-band-note">
          A kind with no override here follows the firm-wide dial above. Setting one of these makes
          this kind decide for itself, in either direction.
        </p>
      </div>
      <WorkKindRules kind={kind} canEdit={canEdit} />
    </section>
  );
}

interface EmailPreviewPreferenceResponse {
  preview_all_partner_emails: boolean;
  set_by: string | null;
  set_at: string | null;
}

/**
 * THE MASTER SWITCH, ABOVE THE PER-KIND LIST — never the other way round. It covers every
 * employee's partner-facing email, not just Porter's, and says so in its own label so opening this
 * page from ANY kind's card reads the same true sentence.
 */
function EmailPreviewDial({ canEdit }: { canEdit: boolean }): JSX.Element {
  const { data, loading, reload } = useApi<EmailPreviewPreferenceResponse>("/api/email-preview-preference");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    const out = await api<{ detail?: string }>("/api/email-preview-preference", {
      method: "PATCH",
      body: { preview_all_partner_emails: next },
    });
    setBusy(false);
    if (out.status >= 400) {
      setError(out.data?.detail ?? `Could not change it (${out.status}).`);
      return;
    }
    reload();
  }

  if (loading && !data) return <p className="small">Reading the dial…</p>;
  const on = data?.preview_all_partner_emails ?? true;
  return (
    <div className="card-block" data-testid="email-preview-dial">
      <p className="lbl">Preview every partner-facing email before it sends</p>
      <div className="kind-rule-head">
        <strong>Every AI employee, every kind — not just Porter's</strong>
        {canEdit ? (
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={on}
            aria-label="Preview every partner-facing email before it sends"
            aria-busy={busy}
            disabled={busy}
            data-testid="email-preview-dial-switch"
            onClick={() => void set(!on)}
          >
            <i aria-hidden="true" />
          </button>
        ) : (
          <span className={on ? "badge badge-ok" : "badge badge-gate"} data-testid="email-preview-dial-value">
            {on ? "on" : "off"}
          </span>
        )}
      </div>
      <p className="small">
        While this is on, a finished-work email to a partner waits on Home for a look before it
        sends, for every kind that has not set its own answer below. Her own words: "I am still
        early days with these agents and I want to tail them" — flip it off later, in one place,
        for everything, once you no longer need to.
      </p>
      <p className="field-help" data-testid="email-preview-dial-set-by">
        {data?.set_by && data?.set_at ? `Last changed ${readableDate(data.set_at)}.` : "Never changed — on by default."}
      </p>
      {error && <p className="field-help err" data-testid="email-preview-dial-error">{error}</p>}
    </div>
  );
}
