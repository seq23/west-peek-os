import { useState } from "react";
import { api, type MeResponse } from "../../lib/api";
import { previewStartsTicked } from "@shared/work/previewLane";
import { PARTNERS, partnerFor } from "@shared/registry/partners";
import type { Assignable } from "./types";

/**
 * ADD A CARD — the form and the POST behind it, moved out of `WorkCardsPage.tsx` VERBATIM
 * (22 Sep 2026). Same fields, same testids, same copy, same request body.
 *
 * IT IS MOUNTED WHETHER OR NOT IT IS OPEN, and returns null when it is closed. That is not a
 * stylistic choice: in the one-file page the form's state lived in the page, so cancelling and
 * reopening kept what had been typed. A component that unmounts on close would silently lose it,
 * which would be a behaviour change dressed up as a refactor. Mounted-and-null keeps the old
 * behaviour exactly.
 *
 * ─── A KNOWN DEFECT, LEFT AS IT WAS ──────────────────────────────────────────────────────────
 * `create()` collects `result_recipient` and `preview_first` from the two fields the owner asked
 * for, says in its success message where the result will go — and does NOT put either field in the
 * POST body. So a card written here gets the default lane whatever she typed. This split is a
 * no-behaviour-change move and does not fix it; the fix, with the test that pins it, belongs to
 * the agent that owns the create door.
 */
export function NewWorkCard({
  me,
  open,
  assignable,
  busy,
  setBusy,
  setMessage,
  onCreated,
  onClose,
}: {
  me: MeResponse;
  open: boolean;
  assignable: Assignable | null;
  busy: boolean;
  setBusy: (next: boolean) => void;
  setMessage: (next: string | null) => void;
  /** The board re-reads itself and the shell is told, exactly as before. */
  onCreated: () => void;
  onClose: () => void;
}): JSX.Element | null {
  /*
   * THE TWO LABELS THE OWNER ASKED FOR, set as she writes the card rather than remembered
   * afterwards — "WE NEED TO CLASSIFY ON EACH WORK CARD GOING FORWARD ... SO THERE IS NO CONFUSION."
   *
   * THE DEFAULTS ARE THE DESIGN. "MOST WORK IS INTERNAL AND NOT-CONFIDENTIAL SO CAN USE FREE
   * TRAINING MODELS WITH REASONING AND CLOSE TO $0." If the normal case needed a deliberate choice
   * it would not get one, the free lanes would stay unused, and the bill would not move — which is
   * the state this whole change exists to leave behind. So the form opens on the normal case and
   * only the exception costs a click.
   *
   * AND THEY ARE TWO CONTROLS, NOT ONE. Naming them separately is the point: an LP memo for Sequoia
   * is Internal AND Private model only; an event kit for a guest is External AND Public model
   * approved. A single control could not express either.
   */
  const [modelAccess, setModelAccess] = useState<"PUBLIC_MODEL_APPROVED" | "PRIVATE_MODEL_ONLY">("PUBLIC_MODEL_APPROVED");
  const [audience, setAudience] = useState<"INTERNAL" | "EXTERNAL">("INTERNAL");
  const [title, setTitle] = useState("");
  // Decided while writing the card, not afterwards. Whether work may involve looking things up is
  // part of describing the work.
  const [newAllowsBrowser, setNewAllowsBrowser] = useState(false);
  const [nextAction, setNextAction] = useState("");
  // Defaults to you. Assigning to your partner or to an employee is the same act either way.
  const [owner, setOwner] = useState(`HUMAN:${me.id}`);
  /*
   * HER TWO FIELDS, ON EVERY CARD (18 Sep 2026).
   *
   *     Who is this for?     [ Scooter          ]
   *     Show me first?       [✓]
   *
   * Migration 0183 added both columns and NOTHING EVER WROTE EITHER — which is why the whole
   * preview lane, boundary guard and approval token included, has never run once in production.
   * This form is the thing that was missing.
   *
   * THE CHECKBOX IS ALWAYS PRESENT AND ALWAYS HERS. The recipient sets only where it STARTS —
   * somebody outside the two partners starts it ticked, either partner starts it unticked. An
   * earlier design derived preview-first FROM the recipient and her objection was exact: it made
   * her real case, "something for Scooter that I want to see first", look impossible.
   *
   * `previewTouched` is what keeps that promise honest. Until she touches the box it follows the
   * address she is typing; the moment she sets it herself it stays where she put it, and typing a
   * different address never moves it back.
   */
  const [resultRecipient, setResultRecipient] = useState("");
  const [previewTouched, setPreviewTouched] = useState(false);
  const [previewFirst, setPreviewFirst] = useState(false);
  /*
   * RESOLVED THROUGH THE REGISTRY, NEVER TYPED. "Scooter" is what she writes; the address is
   * `shared/registry/partners.ts`'s to supply. `validate:partners` fails the build on a partner
   * address typed anywhere else, and this field would otherwise be the fifth copy of that fact.
   */
  const recipientAddress = (partnerFor(resultRecipient.trim())?.email ?? resultRecipient.trim()).toLowerCase();
  const previewBoxStartsTicked = previewStartsTicked(recipientAddress);
  const showFirst = previewTouched ? previewFirst : previewBoxStartsTicked;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/work-cards", {
      method: "POST",
      body: {
        title: title.trim(),
        ...(nextAction.trim() ? { next_action: nextAction.trim() } : {}),
        owner_type: owner.split(":")[0],
        owner_id: owner.split(":").slice(1).join(":"),
        model_access: modelAccess,
        audience,
      },
    });
    setBusy(false);
    if (res.status !== 201) {
      setMessage(`Not created: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    // The grant is part of describing the work, so it is applied as the card is created rather
    // than left as a second thing to remember afterwards.
    if (newAllowsBrowser && res.data?.id) {
      await api(`/api/work-cards/${res.data.id}/browser-permission`, {
        method: "POST",
        body: { allows_browser: true },
      });
    }
    setMessage(
      (owner === `HUMAN:${me.id}` ? "Added, owned by you." : "Added and handed over.") +
        (newAllowsBrowser ? " It can look things up online." : "") +
        (recipientAddress
          ? showFirst
            ? ` When it is finished you see it before it goes to ${recipientAddress}.`
            : ` When it is finished it goes straight to ${recipientAddress}.`
          : " The result lands on your Home; there is nobody to send it to."),
    );
    setNewAllowsBrowser(false);
    setTitle("");
    setNextAction("");
    setResultRecipient("");
    setPreviewTouched(false);
    setPreviewFirst(false);
    onClose();
    onCreated();
  }

  if (!open) return null;

  return (
    <form className="card" data-testid="work-card-form" onSubmit={create}>
      <div className="form-row">
        <label style={{ flexGrow: 1 }}>
          What needs doing?{" "}
          <input data-testid="work-card-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Get Sensori's SPV terms from the paperwork" />
        </label>
      </div>
      <div className="form-row">
        <label style={{ flexGrow: 1 }}>
          What happens next?{" "}
          <input data-testid="work-card-next" value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Ask Shanna for the closing docs" />
        </label>
        <label>
          Who carries it{" "}
          <select data-testid="work-card-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value={`HUMAN:${me.id}`}>Me</option>
            {(assignable?.partners ?? [])
              .filter((p) => p.id !== me.id)
              .map((p) => (
                <option key={p.id} value={`HUMAN:${p.id}`}>{p.full_name}</option>
              ))}
            {(assignable?.employees ?? []).map((e) => (
              <option key={e.id} value={`AI:${e.id}`}>{e.name} — {e.role}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-strong" disabled={busy} data-testid="work-card-submit">
          {busy ? "…" : "Add"}
        </button>
      </div>
      {/* ── HER TWO FIELDS ──────────────────────────────────────────────────────────────
          "Who is this for?" and "Show me first?", in that order, because the first sets where
          the second starts. Both are on EVERY card: a checkbox that appears only sometimes is
          a rule wearing a checkbox, and she was emphatic that this is a checkbox. */}
      <div className="form-row preview-lane-fields">
        <label style={{ flexGrow: 1 }}>
          Who is this for?{" "}
          <input
            data-testid="work-card-result-recipient"
            value={resultRecipient}
            onChange={(e) => setResultRecipient(e.target.value)}
            list="work-card-recipients"
            placeholder="Scooter, or an email address — leave blank if it is for you"
          />
          <datalist id="work-card-recipients">
            {/* The two partners by name, from the registry. Never a typed address. */}
            {PARTNERS.map((p) => (
              <option key={p.firmUserId} value={p.firstName}>{p.fullName}</option>
            ))}
          </datalist>
        </label>
        <label className="preview-lane-tick" data-testid="work-card-preview-first-label">
          <input
            type="checkbox"
            data-testid="work-card-preview-first"
            checked={showFirst}
            onChange={(e) => {
              setPreviewTouched(true);
              setPreviewFirst(e.target.checked);
            }}
          />{" "}
          Show me first?
        </label>
      </div>
      <p className="muted small" data-testid="work-card-preview-explainer">
        {resultRecipient.trim() === "" ? (
          <>
            <strong>Blank means it is for you.</strong> The result lands on your Home — there is
            nothing to send and nothing to preview.
          </>
        ) : showFirst ? (
          <>
            <strong>You see it before it goes.</strong> When it is finished it waits on your Home
            and in your inbox, with <strong>Send it</strong>, <strong>Send it back</strong> and{" "}
            <strong>Dismiss</strong>. Send it puts the employee's own words on the wire, from
            their address — never a forward with your name on it.
          </>
        ) : (
          <>
            <strong>It goes straight out</strong> to {recipientAddress} when it is finished.
            {previewTouched ? "" : " Anyone outside the two of you starts ticked; you can change it either way, on any card."}
          </>
        )}
      </p>
      <label className="muted small">
        <input
          type="checkbox"
          data-testid="work-card-new-browser"
          checked={newAllowsBrowser}
          onChange={(e) => setNewAllowsBrowser(e.target.checked)}
        />{" "}
        <span>
          <strong>This work may involve looking things up online.</strong> Whoever carries it can
          read public pages for this card without asking each time — read-only, recorded, and
          only for this card.
        </span>
      </label>
      {/* TWO SEPARATE CONTROLS, SIDE BY SIDE, each saying what it actually decides. The words
          on them are the words that get stored — "Public model approved", not a column called
          `confidential` displayed under a friendlier name, because that is how the next reader
          reintroduces the confusion this rename exists to remove. */}
      <div className="form-row">
        <label>
          Which models may see it{" "}
          <select
            data-testid="work-card-model-access"
            value={modelAccess}
            onChange={(e) => setModelAccess(e.target.value as typeof modelAccess)}
          >
            <option value="PUBLIC_MODEL_APPROVED">Public model approved</option>
            <option value="PRIVATE_MODEL_ONLY">Private model only</option>
          </select>
        </label>
        <label>
          Who it goes to{" "}
          <select
            data-testid="work-card-audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value as typeof audience)}
          >
            <option value="INTERNAL">Internal — Sequoia or Scooter</option>
            <option value="EXTERNAL">External — anyone else</option>
          </select>
        </label>
      </div>
      <p className="muted small">
        <strong>Public model approved</strong> is the normal case and costs close to nothing — hiring
        searches, event kits, room and workshop packets, social posts, Productions work.{" "}
        <strong>Private model only</strong> is for LP names, deal terms, fund figures and diligence
        material, and keeps the work on a model whose terms forbid training on it.{" "}
        <strong>Internal or External</strong> is a label on the work, not a control: what actually
        decides whether something waits for a yes is <strong>Show me first?</strong> above, read
        together with who it is for. Neither of these two answers implies the other, and neither
        implies that one.
      </p>
      <p className="muted small">
        A card without a next action is a wish. Naming the next step is what makes it work
        somebody can pick up.
      </p>
    </form>
  );
}
