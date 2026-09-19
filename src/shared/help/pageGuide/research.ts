import type { PageGuide } from "./types";

/** Research, as deployed on 287ee44 — Wyatt's workstation, and the market map inside it. */
export const researchGuide: PageGuide = {
  navKey: "research",
  title: "Research",
  purpose:
    "Get up to speed on a market, a company or a question. Open a project with what you want to know; Wyatt names what would settle it, gathers sources, records findings, and hands back a packet. The market map lives here too.",
  youCan: ["Launch a research project", "Talk to Wyatt about it, and have him go and research it", "Read the packets already delivered", "Map who is already in a sector"],
  sources: [
    "src/client/pages/ResearchPage.tsx",
    "src/client/pages/DeliverableList.tsx",
    "src/client/pages/DeliverableDocument.tsx",
    "src/client/pages/MarketMapPage.tsx",
  ],
  bands: [
    { name: "Delivered research", testid: "research-delivered", shows: "the five most recent packets; all of them live in Documents." },
    { name: "Open a project", testid: "research-project-form", shows: "a title and the question you actually want answered." },
    { name: "What we are looking into", testid: "research-projects", shows: "every project and its status; open one to work it." },
    { name: "The project", testid: "research-thread", shows: "a 1:1 with Wyatt, then Questions, Sources, Findings, any contradictions, and Packets." },
    { name: "Who else is already doing this?", testid: "research-market-map", shows: "the market map — build one for a sector, see it as a map or a table, reopen earlier maps." },
  ],
  acts: [
    { label: "Launch research", testid: "research-submit", primary: true, does: "opens the project.", then: "It opens below with Wyatt ready to scope it." },
    { label: "Ask", testid: "research-ask-send", primary: true, does: "sends Wyatt a message about this project." },
    { label: "What do we need to find out?", testid: "research-propose-run", does: "has Wyatt propose the questions; keep it records each one." },
    { label: "Add source", testid: "research-source-submit", primary: true, does: "records a source and how reliable it is." },
    { label: "Record finding", testid: "research-finding-submit", primary: true, does: "records a finding, marked research only until it is promoted." },
    { label: "Promote into evidence", testid: "research-promote-", does: "turns a finding into a governed claim on the Record." },
    { label: "Go and research this", testid: "research-live-run", primary: true, does: "sends Wyatt out to search and ground the answers.", then: "Findings and sources come back onto the project." },
    { label: "Gather what we already have", testid: "research-packet-submit", does: "assembles a packet from what is on the project and files it in Documents." },
    { label: "Build map", testid: "mkt-build", primary: true, does: "maps a sector — incumbents, challengers, who is funded by whom, which are ours." },
    { label: "Mark as read", testid: "deliverable-ack-", does: "marks a delivered packet read; Put it away shelves it, Download and Email it to me take it with you." },
    { label: "Send it to", testid: "deliverable-feedback-send-", primary: true, does: "passes your verdict on a packet back to whoever wrote it." },
  ],
  auto: [
    { what: "Every assembled packet is filed as a deliverable and in Documents", when: "as it is produced" },
    { what: "A delivered packet unread for a week is put away by itself", when: "after seven days" },
  ],
  elsewhere: [
    { page: "documents", why: "every packet ever filed." },
    { page: "record", why: "the claims a promoted finding becomes." },
  ],
  walkthroughs: [
    {
      scenario: "Getting up to speed on a market",
      steps: [
        { do: "Under **Open a project**, say what you want to know and press **Launch research**", then: "the project opens below with Wyatt ready to scope it." },
        { do: "Press **What do we need to find out?**", then: "Wyatt proposes the questions; keep it records each one." },
        { do: "Press **Go and research this**", then: "Wyatt searches and grounds the answers; findings and sources come back onto the project." },
        { do: "Press **Add source** or **Record finding** for what you find yourself; press **Ask** to talk to Wyatt about it", then: "each is on the project; a finding is research only until it is promoted." },
        { do: "Press **Promote into evidence** on a finding worth relying on", then: "it becomes a governed claim on the Record." },
        { do: "Press **Gather what we already have**", then: "a packet is assembled and filed in Documents; under **Delivered research**, **Mark as read** and **Send it to** pass your verdict back." },
        { do: "Under **Who else is already doing this?**, press **Build map**", then: "the sector is mapped — incumbents, challengers, who is funded by whom, which are ours." },
      ],
    },
  ],
};
