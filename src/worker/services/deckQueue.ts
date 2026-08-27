import type { Env } from "../env";
import { appendEvent } from "../events";
import { readDeck } from "./deckReader";
import { deckLinks, messageText, pdfAttachments, unreadableDeckAttachments } from "../effects/mimeAttachments";
import { dealFromMessage, intakeDealFromEmail, matchFunnelCompany } from "./dealIntake";
import { decodeMimeHeader } from "../effects/inboundEmail";
import { createWorkCardInternal } from "./workCards";
import { triggersIn } from "../../shared/intake/emailTriggers";
import { DEAL_INTAKE_EMPLOYEE, seatId } from "../../shared/intake/emailTriggers";

/** Derived through the one helper, so this file cannot invent a second convention. */
const DEAL_INTAKE_EMPLOYEE_ID = seatId(DEAL_INTAKE_EMPLOYEE);

/**
 * Reading the decks that arrived, and filling in what the company record did not know.
 *
 * Operator, 22 Aug 2026: "if we snd a deck the employee extracts all relevant info and fills in gaps
 * in the deal flow tab's company card. if its a new company they create a new one. if existing they
 * update it."
 *
 * WHY THIS RUNS ON A JOB AND NOT ON ARRIVAL. Reading a deck is a model call; the email handler has
 * 10ms of CPU. The bytes are stored when the mail lands, which is I/O and nearly free, and this
 * reads them with its own budget. Store now, read later — the same asymmetry that lets a 7MB message
 * be kept but not parsed.
 *
 * IT WRITES, AND IT MAY CORRECT WHAT IS ALREADY THERE. Operator, 22 Aug 2026, overruling an earlier
 * blanks-only rule of mine: "i think the updated deck should overwrite us....coming from the
 * company. overwriting us is fine. maybe each company card has a field for MP notes that cannot be
 * overwritten."
 *
 * She is right, and the original rule was split on the wrong axis. It asked "did a human type it",
 * when the question is WHOSE FACT IT IS. Sector, one-liner and website are things the COMPANY is the
 * authority on — our copy is a transcription of something they told us earlier, and a deck sent
 * later is a more recent statement from the same source. Keeping a stale transcription because a
 * human typed it is how a register slowly stops describing reality.
 *
 * WHAT IS NEVER TOUCHED is `mp_notes` — the firm's own judgement, guarded by a database trigger
 * rather than by this file remembering. That is the field a partner can write in knowing nothing
 * automatic will ever overwrite it.
 *
 * NOTHING IS LOST. The previous value travels on the event beside the new one, so "what did we think
 * their sector was in July" stays answerable. An overwrite that erased the prior reading would trade
 * one kind of staleness for a worse one.
 */

/**
 * How many decks one tick reads. ONE.
 *
 * NOT A GUESS — production evidence. Three `ai_run` rows there died with "abandoned: the invocation
 * ended before this call returned", including Scooter's daily brief on 21 Aug: the Worker was torn
 * down while a model call was still in flight. Stacking three of them into a single scheduled
 * invocation is precisely that failure mode, and the symptom would have been a deck marked FAILED
 * with a reason that reads like the PDF was bad.
 *
 * One per tick is four an hour. A night's arrivals are on the record before the morning brief, which
 * is the only deadline this has, and a slower queue that finishes beats a faster one that is
 * abandoned halfway.
 *
 * The AI budget is the second reason to cap it at all: `deck_reading` carries $0.50 and, unlike the
 * diagnostics sweep, is deliberately allowed to be stopped by a spend ceiling. An uncapped loop
 * could spend the day's allowance on one bad night's mail before the partners are awake.
 */
const PER_RUN = 1;

const FILLABLE = ["sector", "one_liner", "website"] as const;


/**
 * Case- and punctuation-insensitive, so "Sensori" and "Sensori, Inc." are not read as a rename.
 * Deliberately its own copy rather than an import: `dealIntake.normalise` also strips suffix words,
 * which is right for MATCHING two records and wrong here — dropping "Inc" before comparing would
 * hide a rename from "Nova" to "Nova Inc", and whether that is worth proposing is a person's call.
 */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * A deck disagreeing with the name on the record is a QUESTION, not an instruction.
 *
 * The alias is written either way, so the deck's name finds the company from now on. This card is
 * where somebody decides whether it should also be what the company is CALLED — which is an
 * identity change, and identity changes in this system go through a person.
 */
async function openRenameProposal(
  env: Env,
  input: { companyId: string; from: string; to: string; filename: string },
): Promise<void> {
  await createWorkCardInternal(
    env,
    {
      id: "system:deck_reader",
      email: "os@joinwestpeek.com",
      fullName: "Deck reader",
      status: "ACTIVE",
      roles: ["MANAGING_PARTNER"],
      authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
    },
    {
      title: `Is ${input.from} actually called ${input.to}?`,
      description: [
        `The deck "${input.filename}" calls this company ${input.to}. The register calls it ${input.from}.`,
        "",
        `${input.to} has been recorded as an alias, so mail and decks using that name will find this`,
        "company from now on. Nothing has been renamed.",
        "",
        "If the deck is right, rename the company. If the deck is using a product name, or an old one,",
        "leave it — the alias is already doing the useful half.",
      ].join("\n"),
      owner_type: "AI",
      owner_id: DEAL_INTAKE_EMPLOYEE_ID,
      priority: "NORMAL",
      firm_scope: "west-peek",
      next_action: "Decide whether the register should use the deck's name, and rename it if so.",
      prompt:
        "Do not rename anything. Say which name you think is right and why, and leave the decision to a partner.",
    },
  );
}

export async function runDeckReading(env: Env): Promise<{ read: number; failed: number; skipped: number }> {
  // No bucket means nothing can be read, and saying "no decks waiting" would be a lie about a
  // configuration problem rather than about the queue.
  if (!env.WP_OS_DOCUMENTS) return { read: 0, failed: 0, skipped: -1 };

  /*
   * ONLY DECKS THAT HAVE A COMPANY TO FILL. A deck can arrive before its company exists — the EMAIL
   * route raises a card rather than writing the pipeline — and those are stored, waiting, rather
   * than read: there is no record to correct yet. They are picked up on a later tick, once the
   * analyst has opened the company and something has set `company_id`.
   *
   * Left PENDING rather than marked FAILED, because nothing has failed. A deck waiting for its
   * company is the system working as designed, and marking it failed would put a red mark against
   * a founder who did nothing wrong.
   */
  /*
   * DECKS WITHOUT A COMPANY ARE TAKEN TOO, and this is where the trigger is finally read.
   *
   * Operator, 23 Aug 2026: "the subjects will all be different its the #hashtag trigger that
   * matters", and "the hashtag can be in the subject or the body". A message over the size cap is
   * routed from its HEADERS ALONE at arrival, because walking a seven-megabyte MIME tree does not
   * fit in a Worker's 10ms of CPU — so a tag written in the body is invisible at the door. Both of
   * Scooter's decks opened cards reading "It carries no trigger tag" for exactly that reason.
   *
   * This job has its own budget and the whole message is already stored, so the scan happens here.
   * `resolveCompany` below opens the `.eml`, reads subject AND body, and routes on what it finds.
   */
  const pending = await env.WP_OS_DB.prepare(
    `SELECT id, company_id, filename, object_key, work_card_id
       FROM pending_deck WHERE state = 'PENDING'
        ORDER BY company_id IS NULL, created_at ASC LIMIT ?1`,
  )
    .bind(PER_RUN)
    .all<{ id: string; company_id: string | null; filename: string; object_key: string; work_card_id: string | null }>();


  let read = 0;
  let failed = 0;

  /*
   * DECKS THAT CANNOT BE READ YET ARE COUNTED AND SAID, not silently skipped.
   *
   * `skipped` was hardcoded to 0 and the job reported SUCCEEDED "no decks waiting" while decks sat
   * waiting — a status line that was true of the query and false about the firm. That is the exact
   * shape this whole review keeps finding: machinery reporting success over work that is not
   * happening.
   */
  const waiting = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM pending_deck WHERE state = 'PENDING' AND company_id IS NULL",
  ).first<{ n: number }>();
  const skipped = waiting?.n ?? 0;

  for (const deck of pending.results ?? []) {
    const fail = async (detail: string) => {
      failed += 1;
      /*
       * THE REASON GOES ON THE CARD, because `pending_deck` has no reader.
       *
       * `detail` was written to the row and the row is not on any surface — no route, no page. So a
       * deck that could not be read recorded a careful explanation into a table nobody opens, while
       * the work card raised when the message arrived went on saying the deck was on its way. That
       * is the same silent failure this file's own docstring is about: "the difference between 'the
       * deck said nothing about revenue' and 'nobody read the deck'".
       *
       * The card is the thing a person actually works, so the reason lands there and the next action
       * changes to match. Best-effort: a failure to annotate must not swallow the failure itself.
       */
      if (deck.work_card_id) {
        try {
          await env.WP_OS_DB.prepare(
            `UPDATE work_card
                SET description = description || ?2,
                    next_action = ?3
              WHERE id = ?1 AND state IN ('OPEN','IN_PROGRESS','BLOCKED')`,
          )
            .bind(
              deck.work_card_id,
              `\n\n--- the deck could not be read ---\n${detail}`,
              "The deck could not be read automatically. Get it another way, or ask the sender for a PDF.",
            )
            .run();
        } catch {
          // Annotating is a courtesy; recording the failure below is the obligation.
        }
      }
      // The reason is stored, not swallowed. A deck that could not be read is a fact the partners
      // need — it is the difference between "the deck said nothing about revenue" and "nobody read
      // the deck", and those look identical on a company card unless one of them is written down.
      await env.WP_OS_DB.prepare(
        "UPDATE pending_deck SET state = 'FAILED', detail = ?2, read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
        .bind(deck.id, detail.slice(0, 500))
        .run();
    };

    const object = await env.WP_OS_DOCUMENTS.get(deck.object_key);
    if (!object) {
      await fail("The stored file could not be found, so there was nothing to read.");
      continue;
    }

    /*
     * READ BACK AS TEXT. The object IS base64 — stored exactly as MIME delivered it — so there is no
     * decode and no re-encode, which is the whole point: both directions are real CPU work and a
     * Worker has 10ms. A five-megabyte deck round-tripped through bytes would have exhausted the
     * budget and failed as though the deck were unreadable.
     */
    let dataBase64 = (await object.text()).trim();
    if (!dataBase64) {
      await fail("The stored file was empty.");
      continue;
    }

    /*
     * AN OVERSIZED MESSAGE IS EXTRACTED HERE, NOT AT ARRIVAL — which is what makes a 7MB deck
     * readable at all.
     *
     * The email handler returns before `pdfAttachments` for anything over 256KB, because walking a
     * multi-megabyte MIME tree does not fit in a Worker's 10ms of CPU. So the whole `.eml` is stored
     * and the extraction happens here, in a scheduled invocation with its own budget. Without this
     * the ceiling on a readable deck was about 190KB — base64 is 4/3 — and the operator's actual
     * 7MB deck could never have been read no matter what else worked.
     */
    // The whole message, kept before the next block replaces this variable with the attachment.
    const rawEml = deck.object_key.endsWith(".eml") ? dataBase64 : "";

    if (deck.object_key.endsWith(".eml")) {
      const { attachments, unread } = pdfAttachments(dataBase64);
      if (attachments.length === 0) {
        /*
         * SAY WHAT ARRIVED, not what was absent.
         *
         * "The message carried no PDF this can read" is true of the parser and useless to a partner:
         * it does not say whether a 9MB Keynote was sitting right there, or whether the deck was a
         * Docsend link, or whether the message really was empty. Those are three different next
         * actions — ask for a PDF, open the link, or check the sender — and one sentence covered all
         * three with the least useful of them.
         *
         * Nothing here converts or fetches anything. A `.pptx` cannot be read by the models this
         * system uses, and a linked deck is behind an email gate or needs paging through slides that
         * the browser tool cannot do. Reporting them precisely is the honest half, and it is the
         * half that lets somebody act.
         */
        const otherFiles = unreadableDeckAttachments(dataBase64);
        const { subject: emlSubject, body: emlBody } = messageText(dataBase64);
        const links = deckLinks(`${emlSubject}\n${emlBody}`);

        const reasons: string[] = [];
        if (otherFiles.length > 0) {
          reasons.push(
            `It carries ${otherFiles.join(", ")}, which this cannot open — ask the sender for a PDF.`,
          );
        }
        if (links.length > 0) {
          reasons.push(`The deck looks like a link: ${links.join(" ")} — it needs opening by hand.`);
        }
        if (unread.length > 0) reasons.push(`Attachments that could not be taken: ${unread.join("; ")}.`);
        if (reasons.length === 0) reasons.push("The message carried no attachment and no deck link this can read.");

        await fail(reasons.join(" "));
        continue;
      }
      dataBase64 = attachments[0]!.dataBase64;
    }

    /*
     * THE DECK IS READ BEFORE THE COMPANY IS DECIDED, and that ordering is the point.
     *
     * Operator, 23 Aug 2026: "shouldnt the deck itself be the deciding factor on what the name is?"
     * It should, and it was not. The subject line — a label somebody typed while forwarding — named
     * the company, and the deck then corrected sector, one-liner and website while the NAME, the one
     * field it is best placed to settle, was the only thing it could not touch. Scooter sent
     * "Sensori Deck" and the register grew a company by that name beside the Sensori it already had.
     *
     * Reading first costs a model call before we know who it is for. `#wpdeck` gates that: this is
     * deliberate mail, not drive-by. The old order saved nothing anyway — the job read every deck it
     * processed regardless.
     */
    const reading = await readDeck(
      env,
      // An Actor carries an ID everywhere else in this system; passing a display name here reached
      // `authorize()` and `ai_run.ai_employee_id` as a value nothing else would match.
      { type: "AI", aiEmployeeId: DEAL_INTAKE_EMPLOYEE_ID, roles: [], firmScopes: ["west-peek"] },
      { dataBase64, label: deck.filename, mediaType: "application/pdf" },
    );
    if (!reading.ok) {
      await fail(reading.detail);
      continue;
    }

    let companyId = deck.company_id;
    if (!companyId) {
      /*
       * DECODED, because the stored header is raw. Scooter's forward arrives as
       * `=?utf-8?Q?Fwd:_Vynlo_=E2=80=94_pre-seed?=`, and any subject with an em dash or an accent
       * arrives this way — which is most forwards from founders.
       */
      const raw = messageText(rawEml);
      const emlSubject = decodeMimeHeader(raw.subject);
      const emlBody = raw.body;
      const tags = triggersIn(`${emlSubject}\n${emlBody}`);
      const fromMessage = dealFromMessage(emlSubject, emlBody, "", tags.length > 0);

      /*
       * THE DECK'S NAME LEADS, and the subject is only what is left when the deck does not say.
       *
       * Matching on the deck's own name is also what makes the duplicate impossible without any
       * word-list heuristic: "Sensori Deck" fails to match, the deck says "Sensori", and the lookup
       * on THAT finds the company already on the board. The trimming rule this replaces was a guess
       * about what a human meant by a subject; the deck is evidence.
       */
      const named = reading.reading.company_name ?? fromMessage?.company ?? null;
      if (!named) {
        // Neither the deck nor the message named anybody. Left PENDING rather than FAILED: a partner
        // opening the company later is still a route to reading this, and nothing has gone wrong.
        continue;
      }

      const existing = await matchFunnelCompany(env, named);
      if (existing) {
        companyId = existing.id;
      } else {
        const opened = await intakeDealFromEmail(env, {
          company: named,
          sector: reading.reading.sector ?? fromMessage?.sector ?? null,
          one_liner: reading.reading.one_liner ?? fromMessage?.one_liner ?? null,
          website: reading.reading.website ?? fromMessage?.website ?? null,
          from: fromMessage?.from ?? "",
          isDeck: true,
          raw: emlBody.slice(0, 4000),
        });
        companyId = opened.company_id;
      }
      await env.WP_OS_DB.prepare("UPDATE pending_deck SET company_id = ?2 WHERE id = ?1")
        .bind(deck.id, companyId)
        .run();
    }

    // Belt and braces, and a narrowing the compiler needs: every path above either set an id or
    // moved on, so reaching here without one would be a bug rather than a state to handle.
    if (!companyId) continue;


    const company = await env.WP_OS_DB.prepare(
      "SELECT id, canonical_name, sector, one_liner, website FROM canonical_company WHERE id = ?1",
    )
      .bind(companyId)
      .first<Record<string, string | null>>();
    if (!company) {
      await fail("The company this deck belongs to is no longer on record.");
      continue;
    }

    const filled: string[] = [];
    const corrected: Array<{ field: string; from: string; to: string }> = [];
    for (const field of FILLABLE) {
      const found = reading.reading[field];
      if (!found) continue;
      const before = company[field];
      // Unchanged is neither a fill nor a correction, and reporting it as either would make the
      // event log say a deck did something when it agreed with what was already there.
      if (before === found) continue;
      await env.WP_OS_DB.prepare(`UPDATE canonical_company SET ${field} = ?2 WHERE id = ?1`)
        .bind(companyId, found)
        .run();
      if (before) corrected.push({ field, from: before, to: found });
      else filled.push(field);
    }

    /*
     * A DECK MAY NAME A COMPANY IT CREATES. IT MAY NOT RENAME ONE THAT EXISTS.
     *
     * Settled with the operator, 23 Aug 2026: "deck names new companies and proposes renames."
     *
     * The company's own facts win on DESCRIPTIVE fields — that is why sector, one-liner and website
     * are overwritten above, on her instruction that "the updated deck should overwrite us....coming
     * from the company." Identity is a different kind of fact. A rename churns the register, breaks
     * what a partner searches for, and if two companies both call themselves Nova it collides one
     * onto the other. This system already has alias, merge and receipt machinery precisely because
     * renaming is consequential.
     *
     * So a disagreement is recorded as an ALIAS and raised as a card. The alias means the deck's
     * name still FINDS the company from now on, which is the useful half; the card is where a person
     * decides whether it should also be what the company is called.
     */
    const deckName = reading.reading.company_name;
    let renameProposed: string | null = null;
    if (deckName && normaliseName(deckName) !== normaliseName(String(company.canonical_name ?? ""))) {
      const known = await env.WP_OS_DB.prepare(
        "SELECT id FROM company_alias WHERE company_id = ?1 AND lower(trim(alias)) = lower(trim(?2))",
      )
        .bind(companyId, deckName)
        .first();
      if (!known) {
        await env.WP_OS_DB.prepare("INSERT INTO company_alias (id, company_id, alias) VALUES (?1, ?2, ?3)")
          .bind(`ca_${crypto.randomUUID()}`, companyId, deckName)
          .run();
        renameProposed = deckName;
        await openRenameProposal(env, {
          companyId,
          from: String(company.canonical_name ?? ""),
          to: deckName,
          filename: deck.filename,
        });
      }
    }

    await env.WP_OS_DB.prepare(
      "UPDATE pending_deck SET state = 'READ', applied_json = ?2, read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    )
      .bind(
        deck.id,
        JSON.stringify({ filled, corrected, rename_proposed: renameProposed, claims: reading.reading.claims, missing: reading.reading.missing }),
      )
      .run();

    /*
     * WHAT THE DECK CLAIMS IS NOT WHAT THE FIRM KNOWS. The filled fields are stamped with their
     * source in this event; the claims are recorded as claims and never promoted into the record.
     * That boundary is the whole reason the CanonicalCompany design exists and it is not relaxed
     * here — only the blanks were.
     */
    await appendEvent(env, {
      eventType: "company.deck_read",
      actorType: "ai_employee",
      // The ID, not the display name. Written as a name this event read "Wyatt (AI)" on the company
      // trail while every other event read "aie_wyatt (AI)" — the same colleague, twice, and the
      // fourth place this divergence has surfaced.
      actorId: DEAL_INTAKE_EMPLOYEE_ID,
      objectType: "canonical_company",
      // The resolved id, which may have been decided in this run rather than at arrival.
      objectId: companyId,
      payload: {
        filename: deck.filename,
        filled,
        // The old value travels with the new one. An overwrite nobody can undo is not a correction.
        corrected,
        source: "deck",
        verified: false,
        claims: reading.reading.claims.slice(0, 20),
        missing: reading.reading.missing.slice(0, 20),
      },
    });
    read += 1;
  }

  return { read, failed, skipped };
}
