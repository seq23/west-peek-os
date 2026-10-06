import { useState } from "react";
import { api, useApi, type MeResponse } from "../../lib/api";
import { previewStartsTicked } from "@shared/work/previewLane";
import { PARTNERS, partnerFor } from "@shared/registry/partners";
import { handStartableKinds } from "@shared/work/cardKinds";
import { WEB_PROPERTIES } from "@shared/intake/webPropertyChange";
import type { Assignable } from "./types";
import { buildCreateWorkCardBody } from "./newWorkCardBody";

/**
 * ADD A CARD — the form and the POST behind it, moved out of `WorkCardsPage.tsx` (22 Sep 2026),
 * then finished (Wave B, same day): the dropped fields fixed, a kind selector, priority, a due
 * date, the instruction box, and start-now-vs-hold-for-me, asked once, here.
 *
 * IT IS MOUNTED WHETHER OR NOT IT IS OPEN, and returns null when it is closed. That is not a
 * stylistic choice: in the one-file page the form's state lived in the page, so cancelling and
 * reopening kept what had been typed. A component that unmounts on close would silently lose it,
 * which would be a behaviour change dressed up as a refactor. Mounted-and-null keeps that.
 *
 * ─── THE DEFECT THIS WAVE FIXES ──────────────────────────────────────────────────────────────
 * `create()` used to collect `result_recipient` and `preview_first` from the two fields she asked
 * for, say in its success message where the result would go — and never put either field in the
 * POST body. So a card written here always got the default lane whatever she typed, silently. The
 * fix is `buildCreateWorkCardBody` in `./newWorkCardBody.ts`: the mapping from this component's
 * state to the request is now its own function, so `tests/newWorkCardBody.test.ts` can assert the
 * actual request body — the lesson from PR #103, which tested everything downstream of this
 * mapping and nothing about it.
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

  // PRIORITY, DUE DATE, THE INSTRUCTION BOX (Wave B, plan §2 item 5). `priority` and `due_at` have
  // always been accepted by the server (`createWorkCardSchema`); nothing on this form ever set
  // them. `prompt` is the free-text "how to do it" box — also already accepted, never offered.
  const [priority, setPriority] = useState("NORMAL");
  const [dueAt, setDueAt] = useState("");
  const [prompt, setPrompt] = useState("");

  /*
   * THE KIND SELECTOR, DRIVEN BY THE ONE REGISTRY (Wave B, plan §2 item 2/3). `handStartableKinds()`
   * reads `@shared/work/cardKinds.ts` — the same list `validate:card-kinds` holds the worker to —
   * so this form can never offer a kind that is actually opened by a job (`duplicateOf()` would
   * silently join a hand-made one to the job's own card and this button would look broken). "" is
   * "let it decide from the words", the behaviour every card typed here has always had.
   */
  const [kind, setKind] = useState("");
  const kindOptions = handStartableKinds();
  /*
   * WEB_PROPERTY_CHANGE'S OWN QUESTION: WHICH SITE. A DROPDOWN OF `WEB_PROPERTIES` HOSTS, NEVER A
   * TYPED FIELD — the plan's own words, "a deliberate anti-footgun rule". `services/workCards.ts`
   * enforces the same rule server-side; this is the door that keeps a typo from ever reaching it.
   */
  const [propertyHost, setPropertyHost] = useState("");
  // 0253: the open registry — the seeded eight plus every repo a partner registered by email. The
  // static list is the fallback until the Worker answers, so the dropdown is never empty.
  const registry = useApi<{ properties: Array<{ host: string; repo: string }> }>("/api/web-properties");
  const properties = registry.data?.properties?.length ? registry.data.properties : WEB_PROPERTIES.map((p) => ({ host: p.host, repo: p.repo }));

  /*
   * START NOW VS. HOLD FOR ME, ASKED ONCE (Wave B, plan §2 item 7). Reuses Wave D's own hold door
   * (`POST /api/work-cards/:id/hold`) rather than inventing a second mechanism — same required
   * reason, same relay, same silence until she releases it. A card created held never touches the
   * sweep: `holdCard` clears any live claim in the same write, and there is none yet to clear.
   */
  const [holdChoice, setHoldChoice] = useState<"START" | "HOLD">("START");
  const [holdReason, setHoldReason] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (kind === "WEB_PROPERTY_CHANGE" && !propertyHost) {
      setMessage("Pick which site from the list before adding a web property change.");
      return;
    }
    if (holdChoice === "HOLD" && holdReason.trim().length < 2) {
      setMessage("Say why you are holding it — the owner relays this to anyone who asks.");
      return;
    }
    setBusy(true);
    const body = buildCreateWorkCardBody({
      title,
      nextAction,
      owner,
      modelAccess,
      audience,
      recipientAddress,
      showFirst,
      priority,
      dueAt,
      prompt,
      kind,
      propertyHost,
    });
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/work-cards", {
      method: "POST",
      body,
    });
    if (res.status !== 201) {
      setBusy(false);
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
    // HOLD FOR ME, THE SAME DOOR WAVE D BUILT (`services/workCards.ts` `holdCard`) — not a second
    // mechanism. A card that has never been picked up has no lease to clear, so this is exactly
    // the shape of pulling a live one, minus the part that does not apply yet.
    let heldNote = "";
    if (holdChoice === "HOLD" && res.data?.id) {
      const held = await api<{ error?: string; detail?: string }>(`/api/work-cards/${res.data.id}/hold`, {
        method: "POST",
        body: { reason: holdReason.trim() },
      });
      heldNote =
        held.status === 200
          ? " Held for you — nothing works it until you release it."
          : ` (Added, but could not hold it: ${held.data?.detail ?? held.status}.)`;
    }
    setBusy(false);
    setMessage(
      (owner === `HUMAN:${me.id}` ? "Added, owned by you." : "Added and handed over.") +
        (newAllowsBrowser ? " It can look things up online." : "") +
        (recipientAddress
          ? showFirst
            ? ` When it is finished you see it before it goes to ${recipientAddress}.`
            : ` When it is finished it goes straight to ${recipientAddress}.`
          : " The result lands on your Home; there is nobody to send it to.") +
        heldNote,
    );
    setNewAllowsBrowser(false);
    setTitle("");
    setNextAction("");
    setResultRecipient("");
    setPreviewTouched(false);
    setPreviewFirst(false);
    setPriority("NORMAL");
    setDueAt("");
    setPrompt("");
    setKind("");
    setPropertyHost("");
    setHoldChoice("START");
    setHoldReason("");
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

      {/* THE KIND SELECTOR, DRIVEN BY THE REGISTRY (Wave B). Blank means "let it decide from the
          words" — a hire search or a memo still becomes ARTIFACT the way it always has. */}
      <div className="form-row">
        <label style={{ flexGrow: 1 }}>
          What kind of work is this?{" "}
          <select data-testid="work-card-kind" value={kind} onChange={(e) => { setKind(e.target.value); setPropertyHost(""); }}>
            <option value="">Let it figure out the kind</option>
            {kindOptions.map((k) => (
              <option key={k.key} value={k.key}>{k.label}</option>
            ))}
          </select>
        </label>
        {kind && (
          <p className="muted small" data-testid="work-card-kind-explainer" style={{ flexBasis: "100%" }}>
            {kindOptions.find((k) => k.key === kind)?.oneLine}
          </p>
        )}
      </div>

      {/* WEB_PROPERTY_CHANGE'S OWN QUESTION: WHICH SITE. A DROPDOWN, NEVER TYPED — the anti-footgun
          rule the plan keeps by name; `services/workCards.ts` refuses anything else server-side too. */}
      {kind === "WEB_PROPERTY_CHANGE" && (
        <div className="form-row">
          <label style={{ flexGrow: 1 }}>
            Which site{" "}
            <select data-testid="work-card-property-host" value={propertyHost} onChange={(e) => setPropertyHost(e.target.value)}>
              <option value="">Choose the site</option>
              {properties.map((p) => (
                <option key={p.host} value={p.host}>{p.host}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* PRIORITY, DUE DATE, THE INSTRUCTION BOX — always accepted server-side, never offered here
          until now. */}
      <div className="form-row">
        <label>
          Priority{" "}
          <select data-testid="work-card-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </select>
        </label>
        <label>
          Due{" "}
          <input type="date" data-testid="work-card-due-at" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </label>
      </div>
      <div className="form-row">
        <label style={{ flexGrow: 1 }}>
          How to do it (optional){" "}
          <textarea
            rows={2}
            data-testid="work-card-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Any instruction for whoever carries it — tone, sources, what to avoid"
          />
        </label>
      </div>

      {/* START NOW VS. HOLD FOR ME, ASKED ONCE (Wave B, plan §2 item 7). Reuses Wave D's own hold
          door — same required reason, same relay, same silence until she releases it. */}
      <div className="form-row">
        <label>
          <input
            type="radio"
            name="new-work-card-hold-choice"
            data-testid="work-card-start-now"
            checked={holdChoice === "START"}
            onChange={() => setHoldChoice("START")}
          />{" "}
          Start now
        </label>
        <label>
          <input
            type="radio"
            name="new-work-card-hold-choice"
            data-testid="work-card-hold-for-me"
            checked={holdChoice === "HOLD"}
            onChange={() => setHoldChoice("HOLD")}
          />{" "}
          Hold for me
        </label>
      </div>
      {holdChoice === "HOLD" && (
        <div className="card-block-form" data-testid="work-card-new-hold-form">
          <p className="lbl">Why are you holding this?</p>
          <textarea
            rows={2}
            value={holdReason}
            onChange={(e) => setHoldReason(e.target.value)}
            placeholder={'e.g. "I want to be at my desk when this one runs — it is a big job."'}
            aria-label="Why you are holding this card"
            data-testid="work-card-new-hold-reason"
          />
          <p className="field-help">
            The owner relays this to anyone who asks about the card. No nag while it is held —
            nothing works it until you release it.
          </p>
        </div>
      )}
    </form>
  );
}
