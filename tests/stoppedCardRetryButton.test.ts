// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BlockPanel } from "../src/client/pages/work/BlockPanel";
import { blockOf } from "../src/worker/services/blocks";
import type { WorkCardRow } from "../src/client/pages/work/types";
import type { BlockActionKey } from "../src/shared/work/blocks";

/**
 * THE BUTTON THE OWNER WAS MISSING, IN A REAL DOM (1 Oct 2026).
 *
 * Parker's November Room card offered "Answer it / Change what you asked for / Drop it / Send it to an
 * engineer" — no "try it again" — because a block stores its doors when the card stops and this one stopped
 * before the door existed. The API now adds it when the stored block is read back; this renders the REAL
 * `BlockPanel` from a block read the way the API reads it, and presses the button.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OLD_ACTIONS = JSON.stringify([
  { key: "ANSWER", label: "Answer it", hint: "Type what to try instead." },
  { key: "CHANGE", label: "Change what you asked for", hint: "Rewrite the job." },
  { key: "DROP", label: "Drop it", hint: "Decide it is not worth doing." },
  { key: "ESCALATE", label: "Send it to an engineer", hint: "It goes to whoever maintains the system." },
]);

function render(row: Record<string, unknown>, onClear = vi.fn()): { host: HTMLDivElement; onClear: ReturnType<typeof vi.fn> } {
  const block = blockOf(row as never);
  const card = { id: "wc_26f988c2", title: "Parker: build the November 2026 Room packet", state: "BLOCKED", owner_id: "aie_parker", block } as unknown as WorkCardRow;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let clearing: { card: string; action: BlockActionKey } | null = null;
  const draw = (): void =>
    act(() => {
      root.render(
        createElement(BlockPanel, {
          card,
          employees: [],
          busy: false,
          clearing,
          setClearing: (next: { card: string; action: BlockActionKey } | null) => {
            clearing = next;
            draw();
          },
          clearText: "",
          setClearText: () => {},
          onClear,
        }),
      );
    });
  draw();
  return { host, onClear };
}

const staleRow = {
  state: "BLOCKED",
  block_reason: "tried_and_could_not_finish",
  block_trying: "Parker: build the November 2026 Room packet",
  block_stopped: "Parker tried three times and could not get this done.",
  block_needed: "Tell Parker what to do differently, change what you asked for, or drop it.",
  block_who: "SEQUOIA",
  block_actions_json: OLD_ACTIONS,
};

describe("the Work page offers 'try it again' on a card stopped before it existed", () => {
  it("shows the Retry button, says what it does, and pressing it sends RETRY for that card with no text box in the way", () => {
    const { host, onClear } = render(staleRow);
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="work-card-block-retry-wc_26f988c2"]');
    expect(btn, "the stopped card has a Try it again door").not.toBeNull();
    expect(btn!.textContent).toBe("Try it again now");
    expect(btn!.getAttribute("title")).toMatch(/back in the queue/);

    act(() => btn!.click());
    const go = host.querySelector<HTMLButtonElement>('[data-testid="work-card-block-do-retry-wc_26f988c2"]');
    expect(go, "a fault door needs no prose — one more press, not a form").not.toBeNull();
    expect(host.querySelector('[data-testid="work-card-block-text-wc_26f988c2"]')).toBeNull();
    act(() => go!.click());
    expect(onClear).toHaveBeenCalledWith("wc_26f988c2", "RETRY");
  });

  it("a question still offers no retry — the button would waste an attempt", () => {
    const { host } = render({ ...staleRow, block_reason: "a_question_for_you", block_actions_json: JSON.stringify([{ key: "ANSWER", label: "Answer it", hint: "x" }]) });
    expect(host.querySelector('[data-testid="work-card-block-retry-wc_26f988c2"]')).toBeNull();
  });

  it("a card the spend setting stopped names the setting in the heading, not a vendor", () => {
    const { host } = render({
      ...staleRow,
      block_reason: "a_lane_refused_the_work",
      block_stopped: "The spend setting is on Free only, and this work needs a paid model, so it was held back.",
      block_lane: "spend_lever",
      block_lane_name: "the spend setting",
      block_actions_json: JSON.stringify([{ key: "RETRY", label: "Try it again now", hint: "x" }, { key: "DROP", label: "Drop it", hint: "x" }]),
    });
    expect(host.textContent).toMatch(/Stopped — the spend setting refused it/);
    expect(host.querySelector('[data-testid="work-card-block-retry-wc_26f988c2"]')).not.toBeNull();
  });
});
