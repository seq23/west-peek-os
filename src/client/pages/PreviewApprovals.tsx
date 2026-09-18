import { useState } from "react";
import { api, useApi } from "../lib/api";
import { PREVIEW_ACTION_DEFS, type PreviewAction } from "@shared/work/previewLane";

/**
 * THE THREE DOORS, ON HER HOME (18 Sep 2026).
 *
 * `/api/preview-approvals` and `/api/preview-approvals/:id/decide` were built on 17 Sep and NO
 * CLIENT FILE CALLED EITHER. There was no UI, so the only way to answer a preview was the link in
 * the email — and the whole lane has never run once in production. This is the missing surface.
 *
 * ─── IT SHOWS ONLY WHAT IS YOURS ───────────────────────────────────────────────────────────────
 *
 * The endpoint filters on `owner_firm_user_id` now, so this component cannot show one partner the
 * other's unsent drafts even by mistake. It carries no owner filter of its own, deliberately: a
 * second filter in the browser would be a second place for the rule to live, and the browser is
 * the half an attacker controls.
 *
 * ─── AND IT SHOWS WHAT USED TO DISAPPEAR ───────────────────────────────────────────────────────
 *
 * A LAPSED preview (nobody answered inside 72 hours) and a SEND_FAILED one (she said yes and the
 * transport refused) both arrive here and both say what happened. Before this, the first vanished
 * off Home with nobody told and the second read as "sent" with nothing delivered.
 */

interface Preview {
  id: string;
  employee: string;
  what: string;
  subject: string;
  body_text: string;
  recipient: string;
  proposed_recipient: string;
  recipient_set_by: "EMPLOYEE" | "PARTNER";
  lane_reason: "DEFAULT_OUTSIDE_FIRM" | "ASKED_FOR";
  state: "PENDING" | "SEND_FAILED";
  expires_at: string;
  send_detail: string | null;
  nag_count: number;
  intended_for: string;
  lapsed: boolean;
  lapsed_note: string | null;
}

interface PreviewListResponse {
  owner: string;
  previews: Preview[];
}

/**
 * The fetch, lifted out of the component that draws it.
 *
 * HOME HAS TO KNOW THE COUNT BEFORE IT DECIDES WHETHER TO DRAW THE BAND AT ALL — "Waiting on you"
 * does not render when it is empty, and a preview waiting inside a band that never rendered is
 * exactly the disappearance this whole change exists to end. One fetch, read in two places, beats
 * two fetches that can disagree about how many there are.
 */
export function usePreviewApprovals(): { previews: Preview[]; reload: () => void; loading: boolean } {
  const list = useApi<PreviewListResponse>("/api/preview-approvals");
  return { previews: list.data?.previews ?? [], reload: list.reload, loading: list.loading };
}

export function PreviewApprovals({
  previews,
  onDecided,
}: {
  previews: Preview[];
  onDecided: () => void;
}): JSX.Element | null {
  if (previews.length === 0) return null;
  return (
    <ul className="card-list preview-list" data-testid="home-previews">
      {previews.map((p) => (
        <PreviewCard key={p.id} preview={p} onDone={onDecided} />
      ))}
    </ul>
  );
}

/**
 * One preview, with the draft under it and the three answers beside it.
 *
 * THE RECIPIENT IS EDITABLE BEFORE SENDING. Operator: "we should be able to put a recipient to
 * send it to right?" The employee proposes; she can change it, and the row records which of the
 * two the address on it came from so "send it" is never ambiguous.
 *
 * A NOTE IS REQUIRED TO SEND IT BACK and the button says so before it is pressed rather than after
 * — the server refuses a noteless RETURN with `note_required`, and a button that fails on click is
 * a worse version of a button that explains itself.
 */
function PreviewCard({ preview, onDone }: { preview: Preview; onDone: () => void }): JSX.Element {
  const [recipient, setRecipient] = useState(preview.recipient);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<PreviewAction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function decide(action: PreviewAction): Promise<void> {
    setBusy(action);
    setFailure(null);
    const res = await api<{ detail?: string; error?: string }>(
      `/api/preview-approvals/${preview.id}/decide`,
      { method: "POST", body: { action, note: note.trim() || undefined, recipient: recipient.trim() || undefined } },
    );
    setBusy(null);
    if (res.status < 200 || res.status >= 300) {
      setFailure(res.data?.detail ?? res.data?.error ?? `That did not go through (${res.status}).`);
      return;
    }
    onDone();
  }

  const failed = preview.state === "SEND_FAILED";
  return (
    <li className="preview-card" data-testid={`preview-${preview.id}`} data-lapsed={preview.lapsed ? "yes" : "no"}>
      <div className="preview-head">
        <strong>{preview.employee}</strong>
        <span className="preview-what">{preview.what}</span>
        {preview.lane_reason === "ASKED_FOR" && (
          <span className="preview-flag">you asked to see this one</span>
        )}
      </div>

      {failed && (
        <p className="preview-alarm" data-testid={`preview-failed-${preview.id}`}>
          <strong>You approved this and it did not go out.</strong>{" "}
          {preview.send_detail ?? "The transport refused it."} Nothing reached them — send it again,
          or dismiss it.
        </p>
      )}
      {preview.lapsed && !failed && (
        <p className="preview-alarm" data-testid={`preview-lapsed-${preview.id}`}>
          {preview.lapsed_note}
        </p>
      )}

      <p className="preview-intended">{preview.intended_for}</p>

      <label className="preview-field">
        Send it to{" "}
        <input
          type="email"
          value={recipient}
          data-testid={`preview-recipient-${preview.id}`}
          onChange={(e) => setRecipient(e.target.value)}
        />
      </label>
      {recipient.trim().toLowerCase() !== preview.proposed_recipient && (
        <p className="muted small">
          {preview.employee} addressed this to {preview.proposed_recipient}. You are changing it.
        </p>
      )}

      <label className="preview-field">
        If you are sending it back, say why{" "}
        <textarea
          rows={2}
          value={note}
          data-testid={`preview-note-${preview.id}`}
          placeholder={`What should ${preview.employee} change?`}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      <div className="preview-doors">
        <button
          type="button"
          className="btn-strong"
          data-testid={`preview-send-${preview.id}`}
          disabled={busy !== null || preview.lapsed}
          title={preview.lapsed ? "This lapsed; send it back for a fresh one." : undefined}
          onClick={() => void decide("SEND")}
        >
          {busy === "SEND" ? "…" : "Send it"}
        </button>
        <button
          type="button"
          data-testid={`preview-return-${preview.id}`}
          disabled={busy !== null || note.trim() === ""}
          title={note.trim() === "" ? "Say why first — a rejection with no reason is a shrug." : undefined}
          onClick={() => void decide("RETURN")}
        >
          {busy === "RETURN" ? "…" : "Send it back"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          data-testid={`preview-dismiss-${preview.id}`}
          disabled={busy !== null}
          onClick={() => void decide("DISMISS")}
        >
          {busy === "DISMISS" ? "…" : "Dismiss"}
        </button>
      </div>

      {/* What each answer actually does, in the words the server and the email both use. One
          list, exported from the lane, so the page cannot describe a door differently. */}
      <ul className="preview-effects">
        {PREVIEW_ACTION_DEFS.map((a) => (
          <li key={a.key}>
            <strong>{a.label}</strong> — {a.effect}
          </li>
        ))}
      </ul>

      {failure && (
        <p className="preview-alarm" data-testid={`preview-error-${preview.id}`}>
          {failure}
        </p>
      )}

      <button
        type="button"
        className="btn-ghost preview-toggle"
        data-testid={`preview-draft-toggle-${preview.id}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide the draft" : "Read the draft, exactly as it would go out"}
      </button>
      {open && (
        <div className="preview-draft" data-testid={`preview-draft-${preview.id}`}>
          <p className="preview-subject">
            <strong>Subject:</strong> {preview.subject}
          </p>
          <pre>{preview.body_text}</pre>
        </div>
      )}
    </li>
  );
}
