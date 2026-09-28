// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { APPROVED_REPLY } from "../src/shared/work/previewReplies";
import type { WorkCardRow } from "../src/client/pages/work/types";

/**
 * THE PREVIEW PANEL SAYS ITS OUTCOME NEXT TO ITS BUTTONS (28 Sep 2026).
 *
 * The incident: the SECONDARY partner pressed "Publish it" on the Work page. The server refused
 * (0241, services/blocks.ts: only the primary approves) and the panel handed the refusal to the
 * page-level notice at the top of the page, nowhere near the button. To her, nothing happened.
 *
 * Pinned here, in a real DOM (jsdom) against the real component:
 *   · what a door says back renders INSIDE the panel (`work-card-preview-message-<id>`), and still
 *     reaches the page-level notice;
 *   · the secondary sees "Only <primary> can approve this now" and ONE door, "Take it back and
 *     publish it", in place of "Publish it" — and that door takes the card back, then approves;
 *   · a refused take-back publishes nothing; the primary keeps the plain "Publish it".
 */

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: unknown }>,
  answer: ((_path: string) => ({ status: 200, data: {} })) as (path: string) => { status: number; data: unknown },
}));

vi.mock("../src/client/lib/api", () => ({
  api: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    fake.calls.push({ path, body: options.body });
    return fake.answer(path);
  }),
}));

import { PreviewReadyPanel } from "../src/client/pages/work/PreviewReadyPanel";

const CARD_ID = "wc_77f52b33";
const REFUSAL = "Only Scooter can approve this now. Reply 'take this back' to take it over.";
const card = { id: CARD_ID, title: "Community site redesign", state: "BLOCKED", owner_name: "Porter" } as unknown as WorkCardRow;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let pageNotice: string | null;

function mount(takeOverFrom: string | null): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      createElement(PreviewReadyPanel, {
        card,
        link: "https://work-wpc-77f52b33.west-peek-community.pages.dev",
        missing: [],
        busy: false,
        setBusy: () => {},
        setMessage: (next: string | null) => {
          pageNotice = next;
        },
        reload: () => {},
        takeOverFrom,
      }),
    );
  });
}

const byId = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}-${CARD_ID}"]`);

async function click(id: string): Promise<void> {
  const el = byId(id);
  if (!el) throw new Error(`no element ${id}-${CARD_ID}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.answer = () => ({ status: 200, data: {} });
  pageNotice = null;
  document.body.innerHTML = "";
});

describe("PreviewReadyPanel — the outcome is said next to the buttons", () => {
  it("the primary sees the plain Publish it and no take-over door", () => {
    mount(null);
    expect(byId("work-card-preview-publish")?.textContent).toBe("Publish it");
    expect(byId("work-card-preview-take-over")).toBeNull();
    expect(byId("work-card-preview-secondary")).toBeNull();
    expect(byId("work-card-preview-message")).toBeNull();
  });

  it("a refusal from the publish door renders inside the panel, not only at the top of the page", async () => {
    mount(null);
    fake.answer = () => ({ status: 403, data: { error: "secondary", detail: REFUSAL } });
    await click("work-card-preview-publish");
    const inline = byId("work-card-preview-message");
    expect(inline).not.toBeNull();
    expect(inline!.textContent).toContain(REFUSAL);
    // Inside the panel — a descendant of the preview section, not a sibling somewhere above it.
    expect(byId("work-card-preview-ready")!.contains(inline)).toBe(true);
    expect(pageNotice).toContain(REFUSAL);
  });

  it("the secondary sees who can approve and ONE door: take it back and publish it", () => {
    mount("Scooter");
    expect(byId("work-card-preview-secondary")?.textContent).toBe("Only Scooter can approve this now.");
    expect(byId("work-card-preview-take-over")?.textContent).toBe("Take it back and publish it");
    expect(byId("work-card-preview-publish")).toBeNull();
  });

  it("the take-over door takes the card back, then approves, and says both inside the panel", async () => {
    mount("Scooter");
    fake.answer = (path) => (path.endsWith("/take-back") ? { status: 200, data: { said: "Taken back from Scooter." } } : { status: 200, data: { ok: true } });
    await click("work-card-preview-take-over");
    expect(fake.calls.map((c) => c.path)).toEqual([`/api/work-cards/${CARD_ID}/take-back`, `/api/work-cards/${CARD_ID}/unblock`]);
    expect(fake.calls[1]!.body).toEqual({ action: "ANSWER", text: APPROVED_REPLY });
    const inline = byId("work-card-preview-message")!;
    expect(inline.textContent).toContain("Taken back");
    expect(inline.textContent).toContain(`"${APPROVED_REPLY}"`);
    expect(pageNotice).toBe(inline.textContent);
  });

  it("a refused take-back publishes nothing and says so inside the panel", async () => {
    mount("Scooter");
    fake.answer = () => ({ status: 403, data: { error: "refused", detail: "Only Sequoia can take this card back." } });
    await click("work-card-preview-take-over");
    expect(fake.calls.map((c) => c.path)).toEqual([`/api/work-cards/${CARD_ID}/take-back`]);
    expect(byId("work-card-preview-message")!.textContent).toContain("Only Sequoia can take this card back.");
    expect(byId("work-card-preview-message")!.textContent).toContain("Nothing was published");
  });
});
