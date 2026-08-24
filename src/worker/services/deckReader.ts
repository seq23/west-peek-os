import type { Env } from "../env";
import { json } from "../router";
import type { RouteContext } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
import { runAi } from "../ai/runAi";

/**
 * Reading a deck, and filling in only what is missing.
 *
 * Operator, 21 Aug 2026: `#wpdeck` is "for the analyst to add deal flow to the top of the funnel for
 * a new company or fill in blanks for a company already added with info missing" — and, on the
 * manual path, "is there a way to add the deck directly from the add a company button flow?"
 *
 * Both roads end here. The deck is stored and attached first; this is the step that reads it.
 *
 * IT PROPOSES, IT DOES NOT WRITE. What comes back is an answer a person accepts — and the reason is
 * not caution about AI, it is that a deck is a company's own account of itself. A founder's number
 * is a claim, and a claim written straight into the firm's record becomes indistinguishable from
 * something the firm checked. The whole CanonicalCompany design exists to keep those apart.
 *
 * ONLY THE BLANKS. Fields a person already filled are returned as `kept` and never overwritten: the
 * deck is newer, not more authoritative, and a later PDF silently replacing something a partner
 * typed is the worst possible version of "helpful".
 *
 * `application/pdf` ONLY for now. That is what decks arrive as, and the boundary refuses anything
 * else loudly rather than handing a model a file it cannot open and believing the answer.
 */

export interface DeckReading {
  /**
   * THE COMPANY'S OWN NAME FOR ITSELF, and the reason this field exists.
   *
   * Until 23 Aug 2026 the deck settled sector, one-liner, website and stage — everything EXCEPT the
   * name. So a company was named from the EMAIL SUBJECT, which is the weakest evidence in the whole
   * message: a label somebody typed while forwarding. Scooter sent "Sensori Deck" and the register
   * grew a company called Sensori Deck alongside the Sensori it already had.
   *
   * Operator, 23 Aug: "shouldnt the deck itself be the deciding factor on what the name is?" It
   * should. A deck is a company's own account of itself, and the cover page is the one place the
   * name is stated by the only party entitled to state it.
   */
  company_name: string | null;
  sector: string | null;
  one_liner: string | null;
  website: string | null;
  stage: string | null;
  raising: string | null;
  /** What the deck asserts that the firm has not checked. Kept as claims, never as facts. */
  claims: string[];
  /** What the deck does not say. Often the more useful half. */
  missing: string[];
}

const PROMPT = [
  "You are reading a startup's pitch deck for an early-stage venture fund.",
  "Return ONLY a JSON object with these keys and no prose around it:",
  '{"company_name":string|null,"sector":string|null,"one_liner":string|null,"website":string|null,',
  '"stage":string|null,"raising":string|null,"claims":string[],"missing":string[]}',
  "",
  "company_name: the company's own name for itself, as the deck writes it. The name of the company,",
  "  not the name of a product, and not the title of the deck. Drop Inc/Ltd/LLC and any tagline.",
  "  Null if the deck never states it plainly.",
  "one_liner: what the company does, in one sentence, in plain words. Not the tagline.",
  "stage: pre-seed, seed, Series A and so on, only if the deck says so.",
  "raising: the amount and instrument if stated, verbatim.",
  "claims: the specific factual assertions the deck makes about traction, revenue, customers or",
  "  team — the things a fund would have to verify. Quote the number.",
  "missing: what an investor would expect a deck at this stage to contain and this one does not.",
  "",
  "Use null where the deck does not say. Do not infer, do not fill a gap with something plausible,",
  "and never carry a claim into one_liner or sector as though it were established.",
].join("\n");

export async function readDeck(
  env: Env,
  actor: Parameters<typeof runAi>[1]["actor"],
  input: { dataBase64: string; label: string; mediaType: string },
): Promise<{ ok: true; reading: DeckReading } | { ok: false; detail: string }> {
  if (input.mediaType !== "application/pdf") {
    return { ok: false, detail: `Only PDF decks can be read at the moment; this one is ${input.mediaType}.` };
  }

  const { run } = await runAi(env, {
    purpose: `Read the pitch deck: ${input.label}`,
    actor,
    inputs: [PROMPT],
    documents: [{ mediaType: input.mediaType, dataBase64: input.dataBase64, label: input.label }],
    // A deck a founder sent the firm is internal. It is not PUBLIC, and anything above INTERNAL is
    // refused by the boundary rather than sent — see the label gate in runAi.
    sensitivity: "INTERNAL" as never,
    budgetContext: { expectedOutputTokens: 900 },
    /*
     * PINNED, for the same reason University is. Without a taskClass, selection falls to the
     * cheapest priced capable model — and the cheapest models cannot read a PDF at all, so an
     * unpinned deck run would be refused by the document gate every time rather than answered
     * badly. Pinning it to the research lane sends it somewhere that can actually open the file.
     */
    routing: { category: "RESEARCH", taskClass: "deck_reading" },
  });

  if (run.status !== "COMPLETED" || !run.output_text) {
    return { ok: false, detail: run.failure_reason ?? `The run did not complete (${run.status}).` };
  }

  // Models wrap JSON in prose or a fence however firmly they are asked not to. Reading the first
  // object out of the text is more robust than refusing an answer that is present but decorated.
  const match = /\{[\s\S]*\}/.exec(run.output_text);
  if (!match) return { ok: false, detail: "The model answered, but not with anything readable as a deck summary." };

  try {
    const raw = JSON.parse(match[0]) as Partial<DeckReading>;
    return {
      ok: true,
      reading: {
        company_name: typeof raw.company_name === "string" && raw.company_name.trim() ? raw.company_name.trim().slice(0, 120) : null,
        sector: raw.sector ?? null,
        one_liner: raw.one_liner ?? null,
        website: raw.website ?? null,
        stage: raw.stage ?? null,
        raising: raw.raising ?? null,
        claims: Array.isArray(raw.claims) ? raw.claims.slice(0, 20).map(String) : [],
        missing: Array.isArray(raw.missing) ? raw.missing.slice(0, 20).map(String) : [],
      },
    };
  } catch {
    return { ok: false, detail: "The model's answer was not valid JSON." };
  }
}

/**
 * Read the deck attached to a company and offer what it found for the empty fields.
 *
 * Returns `fills` (blanks the deck can answer) and `kept` (fields a person already filled, which
 * the deck disagrees with or repeats and which are not touched either way).
 */
export async function handleReadCompanyDeck(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const companyId = ctx.params.id!;

  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "canonical_company", objectId: companyId });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const company = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, canonical_name, sector, one_liner, website FROM canonical_company WHERE id = ?1",
  )
    .bind(companyId)
    .first<{ id: string; canonical_name: string; sector: string | null; one_liner: string | null; website: string | null }>();
  if (!company) return json({ error: "not_found" }, { status: 404 });

  const deck = await ctx.env.WP_OS_DB.prepare(
    `SELECT d.id, d.title, v.r2_key, v.content_type
       FROM document_link l
       JOIN document d ON d.id = l.document_id
       JOIN document_version v ON v.id = d.current_version_id
      WHERE l.object_type = 'canonical_company' AND l.object_id = ?1 AND l.role = 'DECK'
      ORDER BY l.created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string; title: string; r2_key: string; content_type: string }>();

  if (!deck) {
    return json({ error: "no_deck", detail: `No deck is attached to ${company.canonical_name}.` }, { status: 404 });
  }
  if (typeof ctx.env.WP_OS_DOCUMENTS === "undefined") {
    return json({ error: "storage_unavailable", detail: "Document storage is not configured." }, { status: 503 });
  }

  const object = await ctx.env.WP_OS_DOCUMENTS.get(deck.r2_key);
  if (!object) return json({ error: "bytes_missing", detail: "The deck's file could not be read back." }, { status: 502 });

  const bytes = new Uint8Array(await object.arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);

  const read = await readDeck(ctx.env, actor, {
    dataBase64: btoa(binary),
    label: deck.title,
    mediaType: deck.content_type,
  });
  if (!read.ok) return json({ error: "read_failed", detail: read.detail }, { status: 502 });

  // Only the blanks. A field a person filled is reported as kept and left alone.
  const fills: Record<string, string> = {};
  const kept: string[] = [];
  for (const field of ["sector", "one_liner", "website"] as const) {
    const found = read.reading[field];
    if (!found) continue;
    if (company[field]) kept.push(field);
    else fills[field] = found;
  }

  await appendEvent(ctx.env, {
    eventType: "company.deck_read",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "canonical_company",
    objectId: companyId,
    payload: { document_id: deck.id, fills: Object.keys(fills), kept },
  });

  return json({
    company: company.canonical_name,
    document_id: deck.id,
    reading: read.reading,
    fills,
    kept,
    // Said out loud rather than implied by the shape of the response.
    note: "Nothing has been written. A deck is the company's own account of itself; accept what you believe.",
  });
}
