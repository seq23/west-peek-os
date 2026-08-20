import { DOMAIN_IDS, type DomainId } from "./machines";

/**
 * The fifteen domains, in the words a partner would use.
 *
 * OPERATOR REPORT: "the machines tab tells me nothing... its the departments and we should make
 * sure they are linked in make sense for what we have evolved to."
 *
 * Right on both counts. The page rendered forty-five rows of `COMMAND_MP_OFFICE`,
 * `BUILDER_SYSTEMS_OS`, `RELATIONSHIP_OS` — a filter dropdown of shouted enum values, a table of
 * ids, and no statement anywhere of what a machine IS or why the firm has forty-five of them.
 *
 * A machine is a part of the firm that does a kind of work. That is a department. The domains group
 * them the way an org chart would, and naming them properly is most of what makes the page legible
 * — it is the same information, addressed to a person instead of to the schema.
 */

export interface DepartmentDef {
  id: DomainId;
  name: string;
  /** What this part of the firm is responsible for. */
  what: string;
}

export const DEPARTMENTS: readonly DepartmentDef[] = [
  { id: "COMMAND_MP_OFFICE", name: "The partners' office", what: "What each Managing Partner sees each morning, and everything that reaches them." },
  { id: "GOVERNANCE", name: "Governance", what: "What needs a human decision, what the firm has ruled, and the record that it happened." },
  { id: "OPERATIONS_OS", name: "Operations", what: "Everything that arrives, gets routed, or has to keep running — captures, meetings, continuity." },
  { id: "RELATIONSHIP_OS", name: "Relationships", what: "Who the firm knows, how well, and the warm path into anywhere it wants to go." },
  { id: "FUNDRAISING_LP_OS", name: "LPs and fundraising", what: "The people who fund the fund: pipeline, diligence, reporting, and the data room." },
  { id: "INVESTMENT_OS", name: "Investing", what: "Companies from first look to decision — screening, diligence, the committee, the arithmetic." },
  { id: "PORTFOLIO_OS", name: "Portfolio", what: "How the companies are doing, where they need help, and what to do about the winners." },
  { id: "KNOWLEDGE_OS", name: "Knowledge", what: "What the firm has learned, whether it is evidenced, and whether it can still be found." },
  { id: "EVENT_OS", name: "Events", what: "The Rooms: programming, guests, run-of-show and what they cost." },
  { id: "COMMUNITY_OS", name: "Community", what: "Who is around the firm, what they are doing, and what West Peek has actually witnessed." },
  { id: "BRAND_MARKETING_OS", name: "Brand and marketing", what: "The firm's outward voice, its sponsors, and whether anything published sounds like us." },
  { id: "FINANCE_OS", name: "Finance", what: "The fund's own numbers: capital calls, reconciliation, fees, and the operating account." },
  { id: "LEGAL_COMPLIANCE_OS", name: "Legal and compliance", what: "The line the firm does not cross, and the check on everyone else." },
  { id: "BUILDER_SYSTEMS_OS", name: "Systems", what: "The machinery underneath: integrations, model routing, diagnostics, and the repo itself." },
  { id: "OPPORTUNITY_INTELLIGENCE", name: "Opportunity radar", what: "Things worth doing that nobody asked for yet." },
];

export function departmentDef(id: string): DepartmentDef {
  return (
    DEPARTMENTS.find((d) => d.id === id) ?? {
      id: id as DomainId,
      // Falls back to a readable version of the key rather than shouting the enum at somebody.
      name: id.toLowerCase().replace(/_/g, " ").replace(/\bos\b/g, "").trim(),
      what: "",
    }
  );
}

/** Guard: every domain the machine registry uses must have a human name here. */
export const DEPARTMENTS_COVER_ALL_DOMAINS = DOMAIN_IDS.every((d) => DEPARTMENTS.some((x) => x.id === d));
