import { useEffect, useState } from "react";
import { api, getDevUser, useApi, type MeResponse } from "../lib/api";
import { readableDate, shortDate } from "../lib/dates";
import { stateMeaning, heldBySentence } from "@shared/work/workCards";
import { originOf, type Origin } from "@shared/work/origin";
import { MAX_STEPS_PER_CARD } from "@shared/work/employeeLoop";
import { LinkedText } from "../lib/linkedText";
import type { BlockActionKey } from "@shared/work/blocks";
import { ArtifactShelf } from "./ArtifactShelf";
import { WebPropertyChangePanel } from "./WebPropertyChangePanel";
import { OwnerChip } from "./work/WorkDesk";
import { BlockPanel } from "./work/BlockPanel";
import { NotesPanel } from "./work/NotesPanel";
import { usePreviewApprovals, PreviewCard } from "./PreviewApprovals";
import type { Assignable, InstructionReceipt, WorkCardNote } from "./work/types";

/**
 * THE CARD GETS A PAGE OF ITS OWN (Wave A, 22 Sep 2026).
 *
 * `#/work/<id>` — a real URL a notification, an email link or a bookmark can point at, which did
 * not exist before this. Built to the approved mockup's section order: masthead → origin/owner
 * header → block callout when applicable → progress → message trail → decisions without asking →
 * artifacts & previews → comments → collapsed build detail → standing-rules pointer.
 *
 * EVERY DATA-FETCHING SECTION STANDS ON ITS OWN `useApi` CALL, matching this repo's existing shape
 * (`WorkDesk.tsx`, `WebPropertyChangePanel.tsx`) rather than one aggregate endpoint: each already
 * has its own single-source-of-truth route (`:id`, `:id/request-message`, `:id/message-trail`,
 * `:id/notes`, `:id/instructions`, `/api/artifacts?card=`, `/api/preview-approvals`), and combining
 * them into a second endpoint would be a second place those facts could disagree with the routes
 * that already serve them elsewhere (the desk, Home).
 */

interface CardDetail {
  id: string;
  title: string;
  description: string | null;
  state: string;
  priority: string;
  kind: string | null;
  owner_type: string;
  owner_id: string | null;
  owner_name: string | null;
  owner_role: string | null;
  next_action: string | null;
  due_at: string | null;
  created_at: string;
  created_by: string;
  requested_by_email: string | null;
  capture_id: string | null;
  meeting_id: string | null;
  assigned_from_card_id: string | null;
  model_access: string;
  audience: string;
  work_attempts: number | null;
  work_steps: number | null;
  lease_until: string | null;
  held_reason: string | null;
  held_by: string | null;
  held_by_name: string | null;
  held_at: string | null;
  block: {
    reason: string;
    trying: string;
    stopped: string;
    needed: string;
    who: "SEQUOIA" | "SCOOTER" | "ENGINEER";
    actions: Array<{ key: string; label: string; hint: string; choices?: Array<{ key: string; label: string }> }>;
    blockedAt: string | null;
    lane: string | null;
    laneName: string | null;
    raw: string | null;
  } | null;
}

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
  const detail = useApi<CardDetail>(`/api/work-cards/${cardId}`, [cardId]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [holdPromptOpen, setHoldPromptOpen] = useState(false);
  const [holdReason, setHoldReason] = useState("");
  const [reassigning, setReassigning] = useState(false);

  const assignableApi = useApi<{ assignable: Assignable }>("/api/work-cards/by-owner");
  const assignable = assignableApi.data?.assignable ?? null;

  // The block's own four sentences and doors — one instance, state lifted here exactly as
  // `WorkDesk.tsx` lifts it, so `BlockPanel` is reused verbatim rather than re-implemented.
  const [clearing, setClearing] = useState<{ card: string; action: BlockActionKey } | null>(null);
  const [clearText, setClearText] = useState("");

  async function clearBlock(id: string, action: BlockActionKey, choice?: string): Promise<void> {
    setBusy(true);
    const res = await api<{ ok?: boolean; said?: string }>(`/api/work-cards/${id}/unblock`, {
      method: "POST",
      body: { action, ...(clearText.trim() ? { text: clearText.trim() } : {}), ...(choice ? { choice } : {}) },
    });
    setBusy(false);
    setMessage(res.data?.said ?? "Could not do that.");
    if (res.data?.ok) {
      setClearing(null);
      setClearText("");
    }
    void reload();
  }

  async function reload(): Promise<void> {
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
  const meaning = stateMeaning(card.state);

  const asOf = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  const leaseActive = Boolean(card.lease_until) && Date.parse(card.lease_until!) > Date.now();
  const notStarted = card.state === "OPEN" && !leaseActive && (card.work_attempts ?? 0) === 0;
  const held = card.state === "HELD";
  const finished = card.state === "DONE" || card.state === "CANCELLED";

  async function move(state: string): Promise<void> {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${cardId}`, { method: "PATCH", body: { state } });
    setBusy(false);
    if (res.status !== 200) setMessage(`Could not move it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    setOverflowOpen(false);
    void reload();
  }

  async function doItNow(): Promise<void> {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${cardId}/work`, { method: "POST" });
    setBusy(false);
    if (res.status !== 200) setMessage(`Could not start it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    else setMessage("Started.");
    void reload();
  }

  async function submitHold(): Promise<void> {
    if (holdReason.trim().length < 2) return;
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${cardId}/hold`, {
      method: "POST",
      body: { reason: holdReason.trim() },
    });
    setBusy(false);
    if (res.status !== 200) {
      setMessage(`Could not hold it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    setHoldPromptOpen(false);
    setOverflowOpen(false);
    setHoldReason("");
    setMessage("Held. Nothing works this card until you release it.");
    void reload();
  }

  async function release(): Promise<void> {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${cardId}/release`, { method: "POST" });
    setBusy(false);
    if (res.status !== 200) setMessage(`Could not release it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    else setMessage("Released. It re-queues fresh, from the top.");
    void reload();
  }

  async function reassign(ownerType: string, ownerId: string): Promise<void> {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${cardId}`, {
      method: "PATCH",
      body: { owner_type: ownerType, owner_id: ownerId },
    });
    setBusy(false);
    if (res.status !== 200) setMessage(`Could not reassign it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    setReassigning(false);
    setOverflowOpen(false);
    void reload();
  }

  const origin: Origin = originOf(
    {
      created_by: card.created_by,
      requested_by_email: card.requested_by_email,
      capture_id: card.capture_id,
      meeting_id: card.meeting_id,
      assigned_from_card_id: card.assigned_from_card_id,
      created_at: card.created_at,
    },
    me.id,
  );

  return (
    <section data-testid="work-card-page" className="work-surface">
      {/* MASTHEAD — self-identifies (Addendum 6), then a state-dependent slot (Addendum 7): never a
          bare button pair, never competing with the block callout's own doors. */}
      <header className="work-masthead">
        <div className="work-masthead-said" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <button type="button" className="link-button" onClick={onBack} data-testid="work-card-back">
            ← Desk
          </button>
          <span className="badge" data-testid="work-card-self-label">
            WORK CARD
          </span>
          <span className="muted small" data-testid="work-card-as-of">
            as of {asOf} today
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {notStarted && (
            <>
              <button type="button" className="btn-strong" disabled={busy} data-testid="work-card-do-it-now" onClick={() => void doItNow()}>
                Do it now
              </button>
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
            </>
          )}
          {held && (
            <button type="button" className="btn-strong" disabled={busy} data-testid="work-card-release" onClick={() => void release()}>
              Release
            </button>
          )}
          {finished && (
            <button type="button" disabled={busy} data-testid="work-card-reopen" onClick={() => void move("OPEN")}>
              Reopen
            </button>
          )}
          {!notStarted && !held && !finished && (
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className="btn-strong"
                aria-haspopup="true"
                aria-expanded={overflowOpen}
                data-testid="work-card-overflow-toggle"
                onClick={() => setOverflowOpen((o) => !o)}
              >
                •••
              </button>
              {overflowOpen && (
                <div className="card" data-testid="work-card-overflow-menu" style={{ position: "absolute", right: 0, zIndex: 5, minWidth: "12rem" }}>
                  <button
                    type="button"
                    data-testid="work-card-overflow-hold"
                    onClick={() => {
                      setHoldReason("");
                      setHoldPromptOpen(true);
                    }}
                  >
                    Hold for me
                  </button>
                  <button type="button" data-testid="work-card-overflow-reassign" onClick={() => setReassigning((r) => !r)}>
                    Reassign
                  </button>
                  <button type="button" data-testid="work-card-overflow-cancel" onClick={() => void move("CANCELLED")}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* HOLD FOR ME ALWAYS OPENS A REQUIRED-REASON PROMPT (Addendum 7) — never a bare toggle,
          wherever it is triggered from. */}
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
            <button
              type="button"
              className="btn-strong"
              disabled={busy || holdReason.trim().length < 2}
              data-testid="work-card-hold-submit"
              onClick={() => void submitHold()}
            >
              Hold it
            </button>
            <button type="button" data-testid="work-card-hold-cancel" onClick={() => setHoldPromptOpen(false)}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {reassigning && (
        <div className="card-block-form" data-testid="work-card-reassign-form">
          <p className="lbl">Hand this to somebody else</p>
          <select
            aria-label="Reassign"
            data-testid="work-card-reassign-select"
            defaultValue=""
            onChange={(e) => {
              const [t, ...rest] = e.target.value.split(":");
              if (t) void reassign(t, rest.join(":"));
            }}
          >
            <option value="" disabled>
              Who should carry it?
            </option>
            {(assignable?.partners ?? []).map((p) => (
              <option key={p.id} value={`HUMAN:${p.id}`}>
                {p.full_name}
              </option>
            ))}
            {(assignable?.employees ?? []).map((emp) => (
              <option key={emp.id} value={`AI:${emp.id}`}>
                {emp.name} — {emp.role}
              </option>
            ))}
          </select>
        </div>
      )}

      {message && (
        <p className="notice small" data-testid="work-card-page-message">
          {message}
        </p>
      )}

      {/* ORIGIN, TITLE AND STATE — status pills never stand alone (Addendum 1: "origin isn't named
          at a glance"). */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span className={card.state === "BLOCKED" ? "badge badge-bad" : card.state === "HELD" ? "badge badge-quiet" : "badge"} data-testid="work-card-state-badge">
            {meaning?.label ?? card.state}
          </span>
          {card.kind && (
            <span className="badge" data-testid="work-card-kind-badge">
              {card.kind}
            </span>
          )}
          <span className="muted small" data-testid="work-card-id">
            {card.id}
          </span>
        </div>
        <h1 style={{ fontSize: "var(--text-2xl)", margin: 0 }}>{card.title}</h1>

        {/* TWO ROWS, ALWAYS BOTH (Addendum 6): who asked is never enough on its own. */}
        <p className="muted small" data-testid="work-card-requested-by">
          Requested by <strong>{originLabel(origin)}</strong>
          {origin.kind === "EMAIL" && <> · {origin.who}</>}
          {" · "}
          {origin.kind === "YOU" ? "you opened it" : `opened ${readableDate(origin.at)}`}
        </p>
        <p className="muted small" data-testid="work-card-owner-row">
          Working it: <OwnerChip name={card.owner_type === "UNASSIGNED" ? null : card.owner_name} />
          {card.owner_role ? ` · ${card.owner_role}` : ""}
          {" · "}
          <button type="button" className="link-button" data-testid="work-card-reassign-link" onClick={() => setReassigning((r) => !r)}>
            Reassign
          </button>
        </p>
      </div>

      {/* HELD, SILENT BUT NEVER INVISIBLE. */}
      {held && (
        <p className="notice small" data-testid="work-card-held-banner">
          {heldBySentence({ held_reason: card.held_reason, held_by_name: card.held_by_name }, card.held_at ? shortDate(card.held_at) : "recently")}
        </p>
      )}

      {/* BLOCK — the decision that stops everything else, before anything else is read. One
          instance, state lifted to this component, exactly the shape `WorkDesk.tsx` already uses
          — `BlockPanel` is reused verbatim, never re-implemented. */}
      {card.block && (
        <BlockPanel
          card={{ ...emptyRowFor(card), block: card.block } as never}
          employees={assignable?.employees ?? []}
          busy={busy}
          clearing={clearing}
          setClearing={setClearing}
          clearText={clearText}
          setClearText={setClearText}
          onClear={(id, action, choice) => void clearBlock(id, action, choice)}
        />
      )}

      {/* PROGRESS — from columns that already exist and were server-side only. */}
      <section>
        <h2 className="lbl">Progress</h2>
        <p className="small" data-testid="work-card-progress">
          {card.owner_type === "AI" ? (
            <>
              step {card.work_steps ?? 0} of {MAX_STEPS_PER_CARD} · attempt {Math.max(1, card.work_attempts ?? 1)} of 3
              {leaseActive && card.lease_until ? ` · claimed until ${new Date(card.lease_until).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
            </>
          ) : (
            "Owned by a partner — the sweep does not work this one."
          )}
        </p>
      </section>

      {/* MESSAGE TRAIL (Addendum 2) — every inbound message and every notice, chronological. */}
      <MessageTrail cardId={cardId} />

      {/* WHO ASKED AND HOW — the decoded body, DKIM verdict, raw behind a lid. */}
      <RequestOrigin cardId={cardId} />

      {/* DECIDED WITHOUT ASKING — the bullet lines an employee already writes into `description`. */}
      <DecidedWithoutAsking description={card.description} />

      {/* ARTIFACTS & PREVIEWS */}
      <section>
        <h2 className="lbl">Artifacts &amp; previews</h2>
        <ArtifactShelf card={cardId} showObject={false} emptyNote="Nothing built yet." testId="work-card-page-artifacts" />
        <CardPreviews cardId={cardId} />
      </section>

      {/* COMMENTS — always visible, never gated on owner-type or state (was gated at BlockPanel-
          adjacent SteerButton logic on the desk). */}
      <CardComments cardId={cardId} cardTitle={card.title} ownerName={card.owner_name} onSent={() => void reload()} />

      {/* COLLAPSED BUILD DETAIL — the kind-specific telemetry, never the first thing she reads. */}
      {card.kind === "WEB_PROPERTY_CHANGE" && (
        <details className="card" data-testid="work-card-build-detail">
          <summary>Build &amp; CI detail</summary>
          <WebPropertyChangePanel cardId={cardId} onNavigate={onNavigate} canEdit={me.roles.includes("MANAGING_PARTNER")} />
        </details>
      )}

      {/* STANDING RULES POINTER — never inline (Addendum 1). */}
      {card.kind && (
        <div className="card" data-testid="work-card-kind-rules-pointer" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="small">Standing rules for every {card.kind} card — policy, not this card's own setting.</span>
          <a href={`#/work-kind-rules/${card.kind}`} data-testid="work-card-kind-rules-link">
            Edit {card.kind} rules →
          </a>
        </div>
      )}
    </section>
  );
}

function originLabel(origin: Origin): string {
  switch (origin.kind) {
    case "YOU":
      return "you";
    case "PARTNER":
      return origin.who;
    case "EMAIL":
      return origin.who;
    case "MEETING":
      return "a meeting commitment";
    case "CAPTURE":
      return "something captured";
    case "ANOTHER_CARD":
      return "a hand-off";
    default:
      return origin.who || "the system";
  }
}

/** `BlockPanel` reads a `WorkCardRow`; the detail response only needs to carry the fields it uses. */
function emptyRowFor(card: { id: string; title: string; owner_id: string | null }): { id: string; title: string; owner_id: string | null } {
  return { id: card.id, title: card.title, owner_id: card.owner_id };
}

function DecidedWithoutAsking({ description }: { description: string | null }): JSX.Element | null {
  const lines = (description ?? "").split("\n").filter((l) => l.startsWith("• "));
  if (lines.length === 0) return null;
  return (
    <section>
      <h2 className="lbl">Decided without asking</h2>
      <ul className="wpc-list" data-testid="work-card-decided">
        {lines.map((l, i) => (
          <li key={i}>
            <LinkedText text={l.slice(2)} />
          </li>
        ))}
      </ul>
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
      <h2 className="lbl">Who asked and how</h2>
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
        <div className="work-card-longtext" data-testid="work-card-request-text">
          <LinkedText text={data.text} />
        </div>
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

function MessageTrail({ cardId }: { cardId: string }): JSX.Element | null {
  const { data, loading } = useApi<{ trail: MessageTrailEntry[] }>(`/api/work-cards/${cardId}/message-trail`);
  const trail = data?.trail ?? [];
  if (loading && !data) return null;
  if (trail.length === 0) return null;
  return (
    <section>
      <h2 className="lbl">Message trail</h2>
      <ul className="card-list" data-testid="work-card-message-trail">
        {trail.map((e, i) => (
          <li key={i} data-testid={`work-card-message-${i}`}>
            <span className="muted small">{readableDate(e.at)}</span> — <strong>{e.who}</strong>{" "}
            <LinkedText text={e.what} />
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

/**
 * COMMENTS, ALWAYS VISIBLE (Wave A). The desk's `SteerButton` gates the box on
 * `owner_type === "AI" && state in (OPEN, IN_PROGRESS, BLOCKED)`; the card's own page shows the
 * thread and an unanswered indicator regardless — a comment on a partner-owned or finished card is
 * still read here even though the server correctly refuses posting a NEW one to finished work
 * (`not_in_flight`, `services/workCards.ts`).
 */
function CardComments({
  cardId,
  cardTitle,
  ownerName,
  onSent,
}: {
  cardId: string;
  cardTitle: string;
  ownerName: string | null;
  onSent: () => void;
}): JSX.Element {
  const notesApi = useApi<{ notes: WorkCardNote[] }>(`/api/work-cards/${cardId}/notes`);
  const receiptsApi = useApi<{ receipts: InstructionReceipt[] }>(`/api/work-cards/${cardId}/instructions`);
  const [noteText, setNoteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const notes = notesApi.data?.notes ?? [];
  const unanswered = notes.filter((n) => !n.acknowledged_at).length;

  async function send(): Promise<void> {
    setError(null);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${cardId}/notes`, { method: "POST", body: { body: noteText } });
    if (res.status !== 201) {
      setError(res.data?.detail ?? `Could not leave that note (${res.status}).`);
      return;
    }
    setNoteText("");
    notesApi.reload();
    onSent();
  }

  const fakeCard = { id: cardId, title: cardTitle, owner_name: ownerName } as never;

  return (
    <section>
      <h2 className="lbl">
        Comments {unanswered > 0 && <span className="badge badge-gate" data-testid="work-card-comments-unanswered">{unanswered} unanswered</span>}
      </h2>
      <NotesPanel
        card={fakeCard}
        notes={notes}
        receipts={receiptsApi.data?.receipts ?? []}
        noteText={noteText}
        setNoteText={setNoteText}
        onSend={() => void send()}
      />
      {error && (
        <p className="notice small" data-testid="work-card-comment-error">
          {error}
        </p>
      )}
    </section>
  );
}
