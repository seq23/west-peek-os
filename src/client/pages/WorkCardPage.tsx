import { useEffect, useState } from "react";
import { api, getDevUser, useApi, type MeResponse } from "../lib/api";
import { readableDate } from "../lib/dates";
import { LinkedText } from "../lib/linkedText";
import { liveStatus } from "@shared/work/liveStatus";
import { cardKind } from "@shared/work/cardKinds";
import { trailSentence } from "@shared/work/cardTimeline";
import { CardExpanded } from "./work/CardExpanded";
import { StatusPill } from "./work/WorkDesk";
import { usePreviewApprovals, PreviewCard } from "./PreviewApprovals";
import type { Assignable, WorkCardRow } from "./work/types";

/**
 * THE CARD GETS A PAGE OF ITS OWN (Wave A, 22 Sep 2026) — and on 23 Sep, the SAME BODY AS THE DESK.
 *
 * `#/work/<id>` is a real URL a notification, an email link or a bookmark can point at. It used to
 * build its own view of the card: "Requested by a hand-off", "step 0 of 8", a failure filed under
 * "Decided without asking", the raw kind `WEB_PROPERTY_CHANGE` in a badge, and an "Artifacts &
 * previews" box that said "Nothing built yet." on cards that never build anything. None of that
 * matched what the desk said about the same card.
 *
 * Now it renders `CardExpanded` — the exact component the desk opens under a row — with the status
 * from `liveStatus`, so the two cannot disagree; and below it the full history the desk does not
 * carry: every message in full, how the request arrived (the signature verdict and the raw message),
 * and any preview waiting on this card. A section with nothing in it is not drawn.
 */

interface RequestMessage {
  message_id: string;
  from: string;
  subject: string | null;
  received_at: string;
  text: string;
  has_raw: boolean;
  r2_key: string;
  mail_authority: { spf: string; dkim: string; dmarc: string; passed: boolean; signing_domain: string | null } | null;
}

interface MessageTrailEntry {
  at: string;
  kind: string;
  who: string;
  what: string;
  hasMessage: boolean;
}

export function WorkCardPage({
  cardId,
  me,
  onChanged,
  onNavigate,
  onBack,
}: {
  cardId: string;
  me: MeResponse;
  onChanged: () => void;
  onNavigate: (k: string) => void;
  onBack: () => void;
}): JSX.Element {
  const detail = useApi<WorkCardRow>(`/api/work-cards/${cardId}`, [cardId]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holdPromptOpen, setHoldPromptOpen] = useState(false);
  const [holdReason, setHoldReason] = useState("");

  const assignableApi = useApi<{ assignable: Assignable }>("/api/work-cards/by-owner");
  const assignable = assignableApi.data?.assignable ?? null;

  function reload(): void {
    detail.reload();
    onChanged();
  }

  if (detail.loading && !detail.data) {
    return (
      <section className="work-surface" data-testid="work-card-page-loading">
        <p className="small">Reading the card…</p>
      </section>
    );
  }
  if (!detail.data) {
    return (
      <section className="work-surface" data-testid="work-card-page-missing">
        <p className="notice small">
          {detail.status === 404 ? "That card is not here, or you may not see it." : "Could not read this card."}
        </p>
        <button type="button" onClick={onBack} data-testid="work-card-page-back-missing">
          ← Back to Work
        </button>
      </section>
    );
  }
  const card = detail.data;
  const status = liveStatus(card, me.id);
  const finished = card.state === "DONE" || card.state === "CANCELLED";
  const held = card.state === "HELD";

  async function move(id: string, state: string): Promise<void> {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${id}`, { method: "PATCH", body: { state } });
    setBusy(false);
    if (res.status !== 200) setMessage(`Could not move it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    reload();
  }

  async function submitHold(): Promise<void> {
    if (holdReason.trim().length < 2) return;
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${cardId}/hold`, { method: "POST", body: { reason: holdReason.trim() } });
    setBusy(false);
    if (res.status !== 200) {
      setMessage(`Could not hold it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    setHoldPromptOpen(false);
    setHoldReason("");
    setMessage("Held. Nothing works this card until you release it.");
    reload();
  }

  const kind = card.kind ? cardKind(card.kind) : null;

  return (
    <section data-testid="work-card-page" className="work-surface">
      <header className="work-masthead">
        <div className="work-masthead-said">
          <button type="button" className="link-button" onClick={onBack} data-testid="work-card-back">
            ← Desk
          </button>
        </div>
        <div className="wc-foot-actions">
          {!finished && !held && (
            <button
              type="button"
              data-testid="work-card-hold-inline"
              onClick={() => {
                setHoldReason("");
                setHoldPromptOpen((o) => !o);
              }}
            >
              Hold for me
            </button>
          )}
          {/* A MERGED CARD DOES NOT REOPEN (0242): the work carries on in the survivor; open that. */}
          {finished && card.merged_into_card_id && (
            <a className="btn-strong" href={`#/work/${card.merged_into_card_id}`} data-testid="work-card-open-survivor">
              Open the card it was merged into
            </a>
          )}
          {finished && !card.merged_into_card_id && (
            <button type="button" disabled={busy} data-testid="work-card-reopen" onClick={() => void move(cardId, "OPEN")}>
              Reopen
            </button>
          )}
        </div>
      </header>

      {/* HOLD FOR ME ALWAYS OPENS A REQUIRED-REASON PROMPT (Addendum 7) — never a bare toggle. */}
      {holdPromptOpen && (
        <div className="card-block-form" data-testid="work-card-hold-form">
          <p className="lbl">Why are you holding this?</p>
          <textarea
            rows={2}
            value={holdReason}
            onChange={(e) => setHoldReason(e.target.value)}
            placeholder={'e.g. "I want to be at my desk when this one runs — it is a big job."'}
            aria-label="Why you are holding this card"
            data-testid="work-card-hold-reason"
          />
          <p className="field-help">The owner relays this to anyone who asks about the card. No nag while it is held.</p>
          <div className="notification-actions">
            <button type="button" className="btn-strong" disabled={busy || holdReason.trim().length < 2} data-testid="work-card-hold-submit" onClick={() => void submitHold()}>
              Hold it
            </button>
            <button type="button" data-testid="work-card-hold-cancel" onClick={() => setHoldPromptOpen(false)}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className="notice small" data-testid="work-card-page-message">
          {message}
        </p>
      )}

      <div className="wc-page-head">
        <h1 className="wc-page-title" data-testid="work-card-title">
          {card.plain_title ?? card.title}
        </h1>
        <p className="wc-status" data-testid="work-card-progress">
          <StatusPill status={status} testid="work-card-state-badge" />
          <span className="wc-line">{status.line}</span>
          <span className="wc-quiet" data-testid="work-card-owner-row">
            {card.owner_type === "UNASSIGNED" ? "Nobody has it" : `${card.owner_name ?? "Someone"} has it`}
          </span>
        </p>
      </div>

      <div className="wc-card wc-card-page is-open">
        <div className="wc-body" data-testid={`work-card-expanded-${card.id}`}>
          <CardExpanded
            card={card}
            me={me}
            status={status}
            assignable={assignable}
            busy={busy}
            setBusy={setBusy}
            setMessage={setMessage}
            reload={reload}
            onNavigate={onNavigate}
            onMove={(id, state) => void move(id, state)}
            mode="page"
          />
        </div>
      </div>

      <section className="wc-history" data-testid="work-card-history">
        <h2 className="wc-history-title">The full history</h2>
        <MessageTrail cardId={cardId} ownerName={card.owner_type === "UNASSIGNED" ? null : (card.owner_name ?? null)} myEmail={me.email} />
        <RequestOrigin cardId={cardId} />
        <CardPreviews cardId={cardId} />
      </section>

      {/* STANDING RULES POINTER — never inline (Addendum 1), named in words rather than by its code. */}
      {card.kind && (
        <p className="wc-quiet" data-testid="work-card-kind-rules-pointer">
          Rules for every “{kind?.label ?? card.kind}” card are policy, not this card's own setting.{" "}
          <a href={`#/work-kind-rules/${card.kind}`} data-testid="work-card-kind-rules-link">
            See the rules →
          </a>
        </p>
      )}
    </section>
  );
}

function RequestOrigin({ cardId }: { cardId: string }): JSX.Element | null {
  const { data, status, loading } = useApi<RequestMessage>(`/api/work-cards/${cardId}/request-message`);
  const [showRaw, setShowRaw] = useState(false);
  if (loading && !data) return null;
  // Not every card is born from an email — a 404 here is the honest common case, not a failure.
  if (!data) return status === 404 ? null : <p className="notice small">Could not read the original message.</p>;
  const auth = data.mail_authority;
  return (
    <section>
      <h3 className="wc-label">How it arrived</h3>
      <div className="card-block" data-testid="work-card-request-origin">
        <p className="small">
          <strong>{data.from}</strong>
          {auth && (
            <span className={auth.dkim === "pass" ? "badge badge-ok" : "badge badge-gate"} data-testid="work-card-dkim-verdict">
              {" "}
              DKIM {auth.dkim}
            </span>
          )}
          <span className="muted small"> · {readableDate(data.received_at)}</span>
        </p>
        {data.subject && <p className="small">{data.subject}</p>}
        {data.has_raw && (
          <details className="block-raw" data-testid="work-card-raw-wrap" onToggle={(e) => setShowRaw((e.target as HTMLDetailsElement).open)}>
            <summary className="muted small">Show me the original message, raw</summary>
            {showRaw && <RawMessage cardId={cardId} />}
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * The raw route serves `text/plain`, never JSON — `useApi`/`api()` always call `res.json()`, which
 * would throw on this body and read back as "could not read it" even when the read is authorized
 * and the object exists. So this fetches for itself, the same identity header `api()` sends.
 */
function RawMessage({ cardId }: { cardId: string }): JSX.Element {
  const [state, setState] = useState<{ status: number | null; text: string | null; loading: boolean }>({
    status: null,
    text: null,
    loading: true,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const headers: Record<string, string> = {};
      const devUser = getDevUser();
      if (devUser) headers["x-wpos-dev-user"] = devUser;
      try {
        const res = await fetch(`/api/work-cards/${cardId}/raw`, { headers });
        const text = res.ok ? await res.text() : null;
        if (!cancelled) setState({ status: res.status, text, loading: false });
      } catch {
        if (!cancelled) setState({ status: 0, text: null, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);
  if (state.loading) return <p className="small">Reading…</p>;
  if (state.status === 403) return <p className="notice small">The raw message — headers, routing and signatures — is a Managing Partner's to read.</p>;
  if (!state.text) return <p className="small">Could not read it.</p>;
  return <pre className="wpc-proof">{state.text}</pre>;
}

function MessageTrail({ cardId, ownerName, myEmail }: { cardId: string; ownerName: string | null; myEmail: string }): JSX.Element | null {
  const { data, loading } = useApi<{ trail: MessageTrailEntry[] }>(`/api/work-cards/${cardId}/message-trail`);
  const trail = data?.trail ?? [];
  if (loading && !data) return null;
  if (trail.length === 0) return null;
  return (
    <section>
      <h3 className="wc-label">Every message, in full</h3>
      <ul className="card-list" data-testid="work-card-message-trail">
        {trail.map((e, i) => (
          <li key={i} data-testid={`work-card-message-${i}`}>
            <span className="muted small">{readableDate(e.at)}</span> — {trailSentence(e, ownerName, [myEmail])}
            {e.kind !== "RECEIVED_EMAIL" && readableWhat(e.what) && (
              <div className="muted small">
                <LinkedText text={e.what} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CardPreviews({ cardId }: { cardId: string }): JSX.Element | null {
  const { previews, reload } = usePreviewApprovals();
  const mine = previews.filter((p) => p.work_card_id === cardId);
  if (mine.length === 0) return null;
  return (
    <ul className="card-list preview-list" data-testid="work-card-page-previews">
      {mine.map((p) => (
        <PreviewCard key={p.id} preview={p} onDone={reload} />
      ))}
    </ul>
  );
}


/** A notice's cause, when it is words rather than an internal key ("received", "unclaimed:ccr_…"). */
function readableWhat(what: string): boolean {
  const w = what.trim();
  return w.length >= 12 && /\s/.test(w) && !/^[a-z_]+:[\w-]+/i.test(w);
}
