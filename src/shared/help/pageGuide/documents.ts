import type { PageGuide } from "./types";

/** Documents, as deployed on 287ee44 — the shelf. */
export const documentsGuide: PageGuide = {
  navKey: "documents",
  title: "Documents",
  purpose:
    "The firm's shelf: every file it holds, grouped by type, with the deck's versions and their state alongside. Upload, view in place, download, archive with a reason — nothing is ever destroyed.",
  youCan: ["Put a document on the shelf", "View it here, or download it", "Archive it with a reason, and restore it", "See which deck version is current"],
  sources: ["src/client/App.tsx#DocumentsPage", "src/client/components/DocumentPreview.tsx"],
  bands: [
    { name: "The viewer", testid: "document-viewer", shows: "the document you opened, in place." },
    { name: "Put a document on the shelf", testid: "document-upload-form", shows: "a title, a type, and the file." },
    { name: "The shelf", testid: "document-list", shows: "every document by type; deck versions carry their number and whether they are current, waiting on your decision, sent back or superseded." },
    { name: "Archived", testid: "documents-archived", shows: "what was taken off the shelf, with the reason — kept, never destroyed." },
  ],
  acts: [
    { label: "Upload", testid: "doc-submit", primary: true, does: "puts the file on the shelf.", then: "A deck becomes a proposed version to decide on Fund strategy." },
    { label: "View here", testid: "view-", does: "opens it in the viewer at the top." },
    { label: "Download", testid: "download-", does: "saves it to your machine." },
    { label: "Archive", testid: "doc-archive-", does: "takes it off the shelf with a reason; Restore puts it back. A current or proposed deck is retired on Fund strategy, not here." },
    { label: "Archive everything here", testid: "doc-archive-all", does: "archives everything on the shelf that is not the live deck, with one reason." },
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
        { do: "Under **Put a document on the shelf**, press **Upload**", then: "the file is on **The shelf**, grouped by type; a deck becomes a proposed version." },
        { do: "Press **View here** or **Download**", then: "it opens in **The viewer** at the top, or saves to your machine." },
        { do: "Press **Decide on Fund strategy** on a proposed deck", then: "the deck decision opens on Fund strategy.", not: "a deck is never approved here." },
        { do: "Press **Archive** with a reason, or **Archive everything here**", then: "it moves to **Archived**; Restore puts it back.", not: "nothing is ever destroyed." },
      ],
    },
  ],
};
