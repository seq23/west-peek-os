import type { PageGuide } from "./types";

/** Capture, as deployed on 287ee44 — write it down now, sort it out later. */
export const captureGuide: PageGuide = {
  navKey: "capture",
  title: "Capture",
  purpose:
    "Somewhere to put anything that arrives before it has a home — a note, a forward, a thought between meetings. Written down first, sorted later, and held on the device if the signal drops.",
  youCan: ["Keep something quickly", "Say what it is about — a company or a person", "Send it on to a department and open a card for it"],
  sources: ["src/client/App.tsx#CapturePage", "src/client/App.tsx#ResolveCapture"],
  bands: [
    { name: "The box", testid: "capture-form", shows: "what happened, what kind of thing it is, where it came from, and who may see it." },
    { name: "Kept", testid: "capture-result", shows: "what you just kept, a form to say what it is about, and the door to send it on." },
    { name: "Recently kept", testid: "capture-recent", shows: "the last eight, and how many have not been sent anywhere yet." },
  ],
  acts: [
    { label: "Keep this", testid: "capture-submit", primary: true, does: "saves it.", then: "Offline, it is held on this device and says so; send it from the status bar when you are back." },
    { label: "Resolve", testid: "resolve-submit", does: "says whether it is about a company or a person; companies are matched against the register, people against Network OS." },
    { label: "Send it on and open a work card", testid: "route-submit", primary: true, does: "hands it to a department and opens a card so somebody owns it." },
  ],
  auto: [{ what: "Nothing routes a capture for you; it is saved either way and waits until you send it on", when: "never on its own" }],
  elsewhere: [
    { page: "intent", why: "for something you want done rather than remembered." },
    { page: "work", why: "the card a routed capture opens." },
  ],
};
