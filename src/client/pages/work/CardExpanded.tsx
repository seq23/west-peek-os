import { useState, type ReactNode } from "react";
import { api, useApi, type MeResponse } from "../../lib/api";
import { readableDate, shortDate } from "../../lib/dates";
import { LinkedText } from "../../lib/linkedText";
import { heldBySentence } from "@shared/work/workCards";
import { askedBy } from "@shared/work/origin";
import { cardTimeline, timelineWhen, type TrailFact } from "@shared/work/cardTimeline";
import type { LiveStatus } from "@shared/work/liveStatus";
import { partnerByEmail } from "@shared/registry/partners";
import type { BlockActionKey } from "@shared/work/blocks";
import { ArtifactShelf } from "../ArtifactShelf";
import { RequesterNotes, WebPropertyChangePanel, useSiteChange } from "../WebPropertyChangePanel";
import { BlockPanel } from "./BlockPanel";
import { LookForm, LookResults } from "./LooksPanel";
import { NoteThread, SteerBox, canSteer } from "./NotesPanel";
import { sitePreviewBadge } from "./sitePreviewBadge";
import type { Assignable, InstructionReceipt, WorkCardNote, WorkCardRow } from "./types";

/**
 * EVERYTHING ABOUT ONE CARD, IN ONE PLACE (23 Sep 2026, the work-card redesign).
 *
 * Her words: "it should be truly collapsed with only the title and in progress and the necessary
 * things showing then a big chevron or some obvious expansion button that has everything and i
 * shouldnt have to click again to see everything."
 *
 * So this is the "everything", and it is the SAME component in both places a card is read: under
 * its row on the desk (one click on "Show everything"), and on the card's own page at
 * `#/work/<id>`, where the full history follows it. The status it states comes from `liveStatus`
 * — handed in, never recomputed here — so the row, this body and the card page cannot disagree.
 *
 * Nothing inside it hides behind a second click: the note to the employee is a box, not a button
 * that opens a box; the reassign control and the stop are at the foot; the website facts are rows.
 * The one disclosure left is the plan's own text, which is a document rather than a fact.
 *
 * WHAT IS NOT HERE. The "Done" button, on work an employee is carrying: the employee finishes it,
 * and a partner marking it done under them was a way to put a lie on the record. "Stop this work"
 * (the old Drop, CANCELLED) is the honest way to end it.
 */

export interface CardExpandedProps {
  card: WorkCardRow;
  me: MeResponse;
  status: LiveStatus;
  assignable: Assignable | null;
  busy: boolean;
  setBusy: (next: boolean) => void;
  setMessage: (next: string | null) => void;
  /** Refetch whatever list or page the card came from. */
  reload: () => void;
  onNavigate: (k: string) => void;
  /** Move the card's state — the shell owns this because the record moves cards through it too. */
  onMove: (id: string, state: string) => void;
  /** Where it renders: under a desk row, or on the card's own page. */
  mode: "desk" | "page";
}

const TRIES = 3;

/** The partners cc'd on the finished email (0239), by first name — "cc Scooter". */
function ccNames(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
      .map((e) => partnerByEmail(e)?.fullName.split(" ")[0] ?? e);
  } catch {
    return [];
  }
}

/** The request as she wrote it, from the card's own `request_json`, before the site row exists. */
function askFromRequest(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const ask = (JSON.parse(json) as { ask?: unknown }).ask;
    return typeof ask === "string" && ask.trim() ? ask : null;
  } catch {
    return null;
  }
}

function recipientWords(card: WorkCardRow, me: MeResponse): string {
  const to = (card.result_recipient ?? card.requested_by_email ?? "").trim().toLowerCase();
  if (!to) return "You";
  const partner = partnerByEmail(to);
  const mePartner = partnerByEmail(me.email);
  if (to === me.email.toLowerCase() || (partner && mePartner && partner.firmUserId === mePartner.firmUserId)) return "You";
  return partner?.fullName ?? to;
}

export function CardExpanded({
  card: c,
  me,
  status,
  assignable,
  busy,
  setBusy,
  setMessage,
  reload,
  onNavigate,
  onMove,
  mode,
}: CardExpandedProps): JSX.Element {
  const isSite = c.kind === "WEB_PROPERTY_CHANGE";
  const site = useSiteChange(isSite ? c.id : null);
  const trail = useApi<{ trail: Array<TrailFact & { hasMessage: boolean }> }>(`/api/work-cards/${c.id}/message-trail`, [c.id]);
  const notesApi = useApi<{ notes: WorkCardNote[] }>(`/api/work-cards/${c.id}/notes`, [c.id]);
  const receiptsApi = useApi<{ receipts: InstructionReceipt[] }>(`/api/work-cards/${c.id}/instructions`, [c.id]);
  const requestApi = useApi<{ text: string }>(isSite ? null : `/api/work-cards/${c.id}/request-message`, [c.id]);

  const [noteText, setNoteText] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [looking, setLooking] = useState(false);
  const [lookObjective, setLookObjective] = useState("");
  const [lookUrl, setLookUrl] = useState("");
  const [showAllLooks, setShowAllLooks] = useState(false);
  const [clearing, setClearing] = useState<{ card: string; action: BlockActionKey } | null>(null);
  const [clearText, setClearText] = useState("");

  const owner = c.owner_type === "UNASSIGNED" ? null : (c.owner_name ?? null);
  const aiInFlight = c.owner_type === "AI" && ["OPEN", "IN_PROGRESS", "BLOCKED", "HELD"].includes(c.state);
  const finished = c.state === "DONE" || c.state === "CANCELLED";
  const notStarted = c.owner_type === "AI" && c.state === "OPEN" && !status.failing && (c.work_attempts ?? 0) === 0 && status.kind === "QUEUED" && !c.current_run;
  const canTogglePreview = c.owner_type === "AI" && ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(c.state);
  const previewOn = c.preview_first === 1;
  // THE SITE'S OWN PREVIEW GATE (0238) — a read-only badge in the "Before it goes live" row, read
  // from its own column; never the "Hold for you first" switch's value. See sitePreviewBadge.ts.
  const sitePreview = sitePreviewBadge(c);
  const recipient = recipientWords(c, me);
  const asked = askedBy(c, { id: me.id, email: me.email });
  const cc = ccNames(c.cc_emails);
  const recipientNode: ReactNode = (
    <span className="wc-inline-list">
      {recipient}
      {cc.map((n) => (
        <span key={n} className="wc-chip" data-testid={`work-card-cc-${c.id}`}>
          cc {n}
        </span>
      ))}
    </span>
  );

  async function sendNote(id: string): Promise<void> {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${id}/notes`, { method: "POST", body: { body: noteText } });
    setBusy(false);
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? `Could not leave that note (${res.status}).`);
      return;
    }
    // The work is NOT stopped and the list is not reloaded: steering something in motion does not
    // interrupt it. Only this card's thread changes.
    setNoteText("");
    notesApi.reload();
    setMessage(`Passed on. ${owner ?? "They"} will pick it up on the next step and say what changed.`);
  }

  async function assign(ownerType: string, ownerId: string): Promise<void> {
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${c.id}`, { method: "PATCH", body: { owner_type: ownerType, owner_id: ownerId } });
    if (res.status !== 200) setMessage(`Could not hand it over: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    setAssigning(false);
    reload();
  }

  async function doItNow(): Promise<void> {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${c.id}/work`, { method: "POST" });
    setBusy(false);
    setMessage(res.status === 200 ? (res.data?.detail ?? "Started.") : `Could not start it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    reload();
  }

  async function release(): Promise<void> {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${c.id}/release`, { method: "POST" });
    setBusy(false);
    setMessage(res.status === 200 ? "Released. It re-queues fresh, from the top." : `Could not release it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    reload();
  }

  /**
   * "SHOW ME FIRST", LABELLED BY WHAT IT DOES. The column (`work_card.preview_first`) holds the
   * finished RESULT for her before it goes to its recipient. It is not the site's own preview gate
   * (`web_property_change.preview_only`), which is the "Before it goes live" row above it.
   */
  async function togglePreviewFirst(): Promise<void> {
    const next = c.preview_first !== 1;
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${c.id}`, {
      method: "PATCH",
      body: { preview_first: next },
    });
    if (res.status !== 200) setMessage(`Could not change that: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    else setMessage(next ? "You will see this one before it goes out." : "No longer held for you first.");
    reload();
  }

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
    reload();
  }

  async function look(): Promise<void> {
    if (lookObjective.trim().length < 8) return;
    setBusy(true);
    const res = await api<{ ran?: boolean; detail?: string; error?: string }>(`/api/work-cards/${c.id}/look`, {
      method: "POST",
      body: { objective: lookObjective.trim(), ...(lookUrl.trim().length >= 8 ? { start_url: lookUrl.trim() } : {}) },
    });
    setBusy(false);
    setMessage(res.status === 201 ? (res.data?.ran ? `Looked: ${res.data.detail ?? "done"}` : (res.data?.detail ?? "Raised for approval.")) : `Could not: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    if (res.status === 201) {
      setLooking(false);
      setLookObjective("");
      setLookUrl("");
    }
    reload();
  }

  async function grantBrowser(allow: boolean): Promise<void> {
    const res = await api<{ detail?: string }>(`/api/work-cards/${c.id}/browser-permission`, { method: "POST", body: { allows_browser: allow } });
    setMessage(res.data?.detail ?? null);
    reload();
  }

  // ── What has happened ──────────────────────────────────────────────────────────────────────
  const entries = cardTimeline({
    created_at: c.created_at,
    owner_name: owner,
    asked_by: asked.who,
    trail: trail.data?.trail ?? [],
    run: c.current_run ?? null,
    work_attempts: c.work_attempts ?? null,
    last_failure: c.work_last_failure ?? null,
    last_failure_at: c.work_last_failure_at ?? null,
    blocked_at: c.state === "BLOCKED" ? (c.block?.blockedAt ?? c.blocked_at ?? null) : null,
    block_stopped: c.block?.stopped ?? null,
    my_emails: [me.email],
  });
  const timeline: ReactNode = (
    <ul className="wc-timeline" data-testid={`work-card-timeline-${c.id}`}>
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`} className={e.now ? "is-now" : undefined}>
          <time dateTime={e.at}>{timelineWhen(e.at)}</time>
          <span>{e.text}</span>
        </li>
      ))}
    </ul>
  );

  // ── The details every card shares ─────────────────────────────────────────────────────────
  const lead: ReactNode = (
    <>
      <dt>Asked by</dt>
      <dd data-testid={`work-card-asked-by-${c.id}`}>
        {asked.who}
        {asked.how ? `, ${asked.how}` : ""}
        <span className="wc-quiet"> · {shortDate(c.created_at)}</span>
      </dd>
    </>
  );
  const showMeFirst: ReactNode = canTogglePreview ? (
    <>
      <dt>Hold for you first</dt>
      <dd className="wc-switch-row">
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={previewOn}
          aria-label={`Hold the finished work for me before it goes to ${recipient === "You" ? "you" : recipient}`}
          disabled={busy}
          data-testid={`work-card-previewtoggle-${c.id}`}
          onClick={() => void togglePreviewFirst()}
        >
          <i aria-hidden="true" />
        </button>
        <span>Hold the finished work for me before it goes to {recipient === "You" ? "you" : recipient}</span>
      </dd>
    </>
  ) : null;

  // ── Your request, once ─────────────────────────────────────────────────────────────────────
  const requestText = isSite ? (site.data?.request_text ?? c.site_ask ?? askFromRequest(c.request_json)) : (requestApi.data?.text ?? null);

  const lastRun = c.last_run ?? null;
  const lane = lastRun?.model ? (lastRun.model.includes(":free") || lastRun.provider_key?.endsWith("_free") ? "a free model" : lastRun.model) : null;

  return (
    <div className="wc-expanded" data-testid={`work-card-body-${c.id}`}>
      {/* A BLOCK IS A QUESTION ADDRESSED TO HER, so it leads the expanded card — the four sentences
          and the doors, reused verbatim from `BlockPanel`. */}
      <BlockPanel
        card={c}
        employees={assignable?.employees ?? []}
        busy={busy}
        clearing={clearing}
        setClearing={setClearing}
        clearText={clearText}
        setClearText={setClearText}
        onClear={(id, action, choice) => void clearBlock(id, action, choice)}
      />

      {c.state === "HELD" && (
        <div className="wc-held" data-testid={`work-card-held-${c.id}`}>
          <p>{heldBySentence({ held_reason: c.held_reason ?? null, held_by_name: c.held_by_name ?? null }, c.held_at ? shortDate(c.held_at) : "recently")}</p>
          <button type="button" className="btn-strong" disabled={busy} data-testid={`work-card-release-${c.id}`} onClick={() => void release()}>
            Release it
          </button>
        </div>
      )}

      {isSite ? (
        <WebPropertyChangePanel
          cardId={c.id}
          onNavigate={onNavigate}
          site={site}
          owner={owner ?? "Porter"}
          recipient={recipientNode}
          timeline={timeline}
          lead={lead}
          tail={showMeFirst}
          gate={
            sitePreview ? (
              <span className={sitePreview.on ? "badge badge-ok" : "badge"} data-testid={`work-card-sitepreview-${c.id}`} data-on={sitePreview.on ? "1" : "0"} title={sitePreview.title}>
                {sitePreview.text}
              </span>
            ) : null
          }
        />
      ) : (
        <>
          <section className="wc-section">
            <h4 className="wc-label">Where it is</h4>
            <p className="wc-where-line" data-testid={`work-card-where-${c.id}`}>
              {status.line}.
              {c.next_action && !c.block ? (
                <>
                  {" "}
                  <span className="wc-quiet">Next:</span> <LinkedText text={c.next_action} />
                </>
              ) : null}
            </p>
            {/* An artifact card's deliverable IS the artifact (19 Sep 2026). */}
            {c.kind === "ARTIFACT" && (
              <div className="wc-subblock" data-testid={`work-card-artifact-${c.id}`}>
                <p className="wc-label">What it builds</p>
                <ArtifactShelf card={c.id} showObject emptyNote="Nothing has been built yet — the next run opens the build; the row fills in from there." testId={`work-card-artifact-rows-${c.id}`} />
              </div>
            )}
            {/* WHAT THE EMPLOYEE HAS FOUND SO FAR — bounded, because a card worked hard carries
                thousands of characters here and must stay the height of one that has not. */}
            {c.description && (
              <div className="wc-subblock">
                <p className="wc-label">{owner ?? "Whoever carries this"} has found so far</p>
                <div className="work-card-longtext" data-testid={`work-card-findings-${c.id}`}>
                  {c.description}
                </div>
              </div>
            )}
          </section>
          <div className="wc-columns">
            <section className="wc-section">
              <h4 className="wc-label">What has happened</h4>
              {timeline}
            </section>
            <section className="wc-section">
              <h4 className="wc-label">The details</h4>
              <dl className="wc-details" data-testid={`work-card-details-${c.id}`}>
                {lead}
                <dt>Who has it</dt>
                <dd>{owner ?? "Nobody yet"}</dd>
                {c.due_at && (
                  <>
                    <dt>Due</dt>
                    <dd>{readableDate(c.due_at)}</dd>
                  </>
                )}
                {(c.result_recipient || c.requested_by_email || cc.length > 0) && (
                  <>
                    <dt>Finished work goes to</dt>
                    <dd>{recipientNode}</dd>
                  </>
                )}
                {showMeFirst}
              </dl>
            </section>
          </div>
        </>
      )}

      {(canSteer(c) || isSite) && (
        <div className="wc-pair">
          {canSteer(c) && <SteerBox card={c} noteText={noteText} setNoteText={setNoteText} onSend={(id) => void sendNote(id)} busy={busy} />}
          {isSite && site.data && (
            <RequesterNotes
              cardId={c.id}
              notes={site.data.requester_notes}
              byName={site.data.requester_notes_by_name}
              at={site.data.requester_notes_at}
              canEdit={me.roles.includes("MANAGING_PARTNER")}
              onSaved={() => site.reload()}
            />
          )}
        </div>
      )}
      <NoteThread card={c} notes={notesApi.data?.notes ?? []} receipts={receiptsApi.data?.receipts ?? []} />

      {requestText && (
        <section className="wc-section">
          <h4 className="wc-label">Your request</h4>
          <div className="wc-request" data-testid={`work-card-request-${c.id}`}>
            <LinkedText text={requestText} />
          </div>
        </section>
      )}

      <LookResults card={c} showAll={showAllLooks} onShowAll={() => setShowAllLooks(true)} />
      {looking && (
        <LookForm
          card={c}
          busy={busy}
          objective={lookObjective}
          setObjective={setLookObjective}
          url={lookUrl}
          setUrl={setLookUrl}
          onSubmit={() => void look()}
          onGrantBrowser={(_id, allow) => void grantBrowser(allow)}
        />
      )}

      {assigning && (
        <div className="wc-assign" data-testid={`work-card-assign-form-${c.id}`}>
          <label className="wc-label" htmlFor={`work-card-assign-${c.id}`}>
            Who should carry it?
          </label>
          <select
            id={`work-card-assign-${c.id}`}
            data-testid={`work-card-assign-${c.id}`}
            value={`${c.owner_type}:${c.owner_id ?? ""}`}
            onChange={(e) => {
              const [t, ...rest] = e.target.value.split(":");
              void assign(t!, rest.join(":"));
            }}
          >
            <option value="UNASSIGNED:">Nobody</option>
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

      <div className="wc-foot">
        {/* ONE GREY LINE for everything a partner never needs to read and an engineer sometimes
            does. The labels and the lane stay on the card as the trail she asked for on 17 Sep —
            here, rather than as pills competing with the status. */}
        <p className="wc-technical" data-testid={`work-card-technical-${c.id}`}>
          Technical: card {c.id}
          {c.site_repo && c.site_repo !== "unresolved" ? ` · repo ${c.site_repo}` : ""}
          {c.owner_type === "AI" && !finished ? ` · try ${Math.min(TRIES, Math.max(1, c.work_attempts ?? 1))} of ${TRIES}` : ""}
          {" · "}
          <span data-testid={`work-card-model-access-${c.id}`}>{c.model_access === "PRIVATE_MODEL_ONLY" ? "private model only" : "public model approved"}</span>
          {" · "}
          <span data-testid={`work-card-audience-${c.id}`}>{c.audience === "EXTERNAL" ? "external" : "internal"}</span>
          {lane && (
            <>
              {" · "}
              <span data-testid={`work-card-lane-${c.id}`} title={lastRun ? `Last run ${new Date(lastRun.at).toLocaleString()}` : undefined}>
                ran on {lane}
                {typeof lastRun?.cost_usd === "number" && (lastRun.cost_usd === 0 ? ", $0" : `, $${lastRun.cost_usd.toFixed(4)}`)}
              </span>
            </>
          )}
          {mode === "desk" && (
            <>
              {" · "}
              <a href={`#/work/${c.id}`} data-testid={`work-card-open-${c.id}`}>
                Open the full card
              </a>
            </>
          )}
        </p>
        <div className="wc-foot-actions">
          {notStarted && (
            <button type="button" className="btn-strong" disabled={busy} data-testid={`work-card-doitnow-${c.id}`} title="Starts it now, ahead of the sweep's next five-minute pass" onClick={() => void doItNow()}>
              Do it now
            </button>
          )}
          {/* DONE belongs to whoever is doing the work by hand. On an employee's card in flight the
              employee finishes it; a partner's black "Done" there was a false entry on the record. */}
          {!finished && !aiInFlight && (
            <button type="button" className="btn-strong" data-testid={`work-card-done-${c.id}`} onClick={() => onMove(c.id, "DONE")}>
              Done
            </button>
          )}
          {!finished && c.owner_type !== "AI" && c.state === "OPEN" && (
            <button type="button" data-testid={`work-card-start-${c.id}`} onClick={() => onMove(c.id, "IN_PROGRESS")}>
              Start
            </button>
          )}
          {!finished && (
            <button type="button" data-testid={`work-card-look-${c.id}`} title={c.allows_browser ? "Reads the page now — this card allows it" : "Raises a look for you to approve"} onClick={() => setLooking((l) => !l)}>
              {c.allows_browser ? "Check a page" : "Check a page…"}
            </button>
          )}
          {!finished && (
            <button type="button" aria-expanded={assigning} data-testid={`work-card-reassign-${c.id}`} onClick={() => setAssigning((a) => !a)}>
              Give it to someone else
            </button>
          )}
          {/* STOP, not Drop: a decision not to do it, kept on the record rather than deleted. */}
          {!finished && (
            <button type="button" className="wc-stop" data-testid={`work-card-drop-${c.id}`} title="Deliberately not doing this. Kept on the record." onClick={() => onMove(c.id, "CANCELLED")}>
              Stop this work
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
