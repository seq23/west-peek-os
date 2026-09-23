import { useState } from "react";
import { api } from "../../lib/api";
import { APPROVED_REPLY, CHANGES_REPLY_PREFIX, MATERIALS_ADDED_PHRASE, PUBLISH_REPLY } from "@shared/work/previewReplies";
import type { WorkCardRow } from "./types";

/**
 * "PREVIEW READY" — A WEBSITE JOB WAITING ON HER LOOK (owner review of #193, 23 Sep 2026).
 *
 * The expanded card used to open on the old block box: "BLOCKED — WAITING ON YOU … What would clear
 * it: PREVIEW READY. Look at it here: <six pages.dev URLs, two of them other sites', with ' and </a
 * fragments>", with Answer it / Change what you asked for / Drop it under it. Her rule that day:
 * "blocked" is only for when Porter truly cannot continue. A preview waiting for her look is not
 * that. So this panel is drawn from STRUCTURED fields — the one clean link the server derives for
 * the card's own site, and the row's list of what is still missing — never from the block's text.
 *
 * Its four buttons are her four email replies, sent through the same door an emailed reply lands on
 * (the block's ANSWER door while the card is parked on her, a note otherwise), so the runner reads
 * them with the one reply reader and nothing here parses anything.
 */
export function PreviewReadyPanel({
  card: c,
  link,
  missing,
  busy,
  setBusy,
  setMessage,
  reload,
}: {
  card: WorkCardRow;
  /** The one preview link for the card's own site, derived server-side. Null while none is built. */
  link: string | null;
  /** What the plan still lacks — optional; the preview ships with placeholders for these. */
  missing: string[];
  busy: boolean;
  setBusy: (next: boolean) => void;
  setMessage: (next: string | null) => void;
  reload: () => void;
}): JSX.Element {
  const [changing, setChanging] = useState(false);
  const [changes, setChanges] = useState("");
  const owner = c.owner_name ?? "Porter";

  /** Her reply, through the door an emailed reply lands on. */
  async function reply(words: string, said: string): Promise<void> {
    setBusy(true);
    const res =
      c.state === "BLOCKED"
        ? await api<{ ok?: boolean; said?: string; detail?: string }>(`/api/work-cards/${c.id}/unblock`, { method: "POST", body: { action: "ANSWER", text: words } })
        : await api<{ ok?: boolean; said?: string; detail?: string }>(`/api/work-cards/${c.id}/notes`, { method: "POST", body: { body: words } });
    setBusy(false);
    const ok = res.status === 200 || res.status === 201;
    setMessage(ok ? said : `Could not send that: ${res.data?.detail ?? res.data?.said ?? res.status}`);
    if (ok) {
      setChanging(false);
      setChanges("");
    }
    reload();
  }

  /** "I added missing items" has its own route: it re-maps the Drive folder and the card's files first. */
  async function materialsAdded(): Promise<void> {
    setBusy(true);
    const res = await api<{ ok?: boolean; said?: string; detail?: string }>(`/api/work-cards/${c.id}/materials-added`, { method: "POST", body: {} });
    setBusy(false);
    setMessage(res.status === 200 ? (res.data?.said ?? "Noted. A new preview follows if anything changed.") : `Could not send that: ${res.data?.detail ?? res.status}`);
    reload();
  }

  return (
    <section className="wc-preview" data-testid={`work-card-preview-ready-${c.id}`}>
      <h4 className="wc-preview-title">Preview ready</h4>
      <p className="wc-preview-link">
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" data-testid={`work-card-preview-link-${c.id}`}>
            {link}
          </a>
        ) : (
          <span className="wc-quiet">The link is on its way; it appears here as soon as the build finishes.</span>
        )}
      </p>
      {missing.length > 0 && (
        <div className="wc-subblock" data-testid={`work-card-preview-missing-${c.id}`}>
          <p className="wc-label">Still missing (optional)</p>
          <ul className="wc-missing">
            {missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="wc-foot-actions">
        <button type="button" className="btn-strong" disabled={busy} data-testid={`work-card-preview-publish-${c.id}`} onClick={() => void reply(APPROVED_REPLY, `Sent: "${APPROVED_REPLY}". ${owner} publishes this preview as it is.`)}>
          Publish it
        </button>
        <button type="button" disabled={busy} aria-expanded={changing} data-testid={`work-card-preview-changes-${c.id}`} onClick={() => setChanging((v) => !v)}>
          Ask for changes
        </button>
        <button type="button" disabled={busy} data-testid={`work-card-preview-added-publish-${c.id}`} onClick={() => void reply(PUBLISH_REPLY, `Sent: "${PUBLISH_REPLY}". ${owner} fills in what you added and publishes, without another preview.`)}>
          I added missing items → publish
        </button>
        <button type="button" disabled={busy} data-testid={`work-card-preview-added-preview-${c.id}`} onClick={() => void materialsAdded()}>
          I added missing items → new preview
        </button>
      </div>
      {changing && (
        <form
          className="wc-pair-col"
          onSubmit={(e) => {
            e.preventDefault();
            void reply(`${CHANGES_REPLY_PREFIX} ${changes.trim()}`, `Sent your changes. ${owner} makes them and sends you a new preview.`);
          }}
        >
          <label className="wc-label" htmlFor={`work-card-preview-changes-text-${c.id}`}>
            What should change
          </label>
          <textarea id={`work-card-preview-changes-text-${c.id}`} rows={3} value={changes} data-testid={`work-card-preview-changes-text-${c.id}`} onChange={(e) => setChanges(e.target.value)} placeholder="e.g. make the hero photo the group shot" />
          <div className="wc-pair-actions">
            <button type="submit" className="btn-strong" disabled={busy || changes.trim().length < 3} data-testid={`work-card-preview-changes-send-${c.id}`}>
              Send the changes
            </button>
            <span className="wc-quiet">You get a new preview with them in.</span>
          </div>
        </form>
      )}
    </section>
  );
}
