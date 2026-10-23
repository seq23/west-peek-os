import type { PageGuide } from "./types";

/** Documents, as deployed on 287ee44 — the shelf. */
export const documentsGuide: PageGuide = {
  navKey: "documents",
  title: "Documents",
  purpose:
    "The firm's shelf, sorted for reading: what is new this week first, then every file in plain-word groups. Open one to read it here, download it, or archive it with a reason — nothing is destroyed.",
  youCan: ["See what is new this week, and search the shelf", "Open a document and read it here, or download it", "Archive it with a reason, and put it back", "See which deck version is current"],
  sources: ["src/client/pages/DocumentsPage.tsx", "src/client/components/DocumentPreview.tsx"],
  bands: [
    { name: "This week", testid: "documents-summary", shows: "how many documents arrived in the last seven days, and the newest three." },
    { name: "The shelf", testid: "document-list", shows: "every document in plain-word groups, such as Playbooks & plans or Weekly reviews & sync prep. A weekly series shows its latest; the earlier ones are one tap away." },
    { name: "The viewer", testid: "document-viewer", shows: "the document you opened, laid over the list: Markdown as a typeset page, PDFs and pictures in place, the full stored title underneath." },
    { name: "Put a document on the shelf", testid: "document-upload", shows: "a title, a type, and the file." },
    { name: "Archive", testid: "documents-archive-area", shows: "taking documents off the shelf, and what was taken off with the reason — kept, never destroyed." },
  ],
  acts: [
    { label: "Upload", testid: "doc-submit", primary: true, does: "puts the file on the shelf.", then: "A deck becomes a proposed version to decide on Fund strategy." },
    { label: "Open here", testid: "view-", does: "opens it in the viewer, over the list; ✕ Close or ← Back puts you where you were." },
    { label: "Download", testid: "download-", does: "saves it to your device, named by its title." },
    { label: "Download", testid: "document-viewer-download", does: "inside an open document: saves it to your device." },
    { label: "Yes, archive it", testid: "doc-archive-", does: "inside an open document, after you give a reason: takes it off the shelf. A current or proposed deck is retired on Fund strategy, not here." },
    { label: "Archive everything on the shelf…", testid: "doc-archive-all", does: "asks for one reason, then archives everything that is not the live deck." },
    { label: "Decide on Fund strategy", does: "goes to the deck decision for a proposed version." },
  ],
  auto: [
    { what: "Every deliverable that files a copy lands here — research packets, Ask briefs, Room packets, Wednesday packets", when: "as they are produced" },
    { what: "Preston rebuilds the deck from the records on request, and each rebuild is a version here", when: "on request", job: "deck_rebuild" },
  ],
  elsewhere: [
    { page: "fund-strategy", why: "approving or sending back a deck version." },
    { page: "home", why: "the morning brief — deliberately not filed here." },
  ],
  notActs: {},
  walkthroughs: [
    {
      scenario: "A file onto the shelf, and the deck to its decision",
      steps: [
        { do: "Under **Put a document on the shelf**, press **Upload**", then: "the file is on **The shelf**, in its group; a deck becomes a proposed version." },
        { do: "Press **Open here** or **Download**", then: "it opens in **The viewer** over the list, or saves to your device." },
        { do: "Press **Decide on Fund strategy** on a proposed deck", then: "the deck decision opens on Fund strategy.", not: "a deck is never approved here." },
        { do: "Open a document, give a reason and press **Yes, archive it**, or use **Archive everything on the shelf…**", then: "it moves to **Archive**; Put it back on the shelf restores it.", not: "nothing is ever destroyed." },
      ],
    },
  ],
};
