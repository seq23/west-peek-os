#!/usr/bin/env node
/**
 * finished-work-reaches-a-person.mjs — `npm run validate:work-reaches-her`.
 *
 * ONE ASSERTION: NO FINISHED RESULT IS ADDRESSED TO NOBODY.
 *
 * WHAT WENT WRONG. The October event kit card had `result_recipient` and `preview_first` both NULL
 * — it predates the change that made those writable. The preview lane therefore had nothing to
 * address and correctly did nothing. Correct in mechanism, useless in outcome: the owner had been
 * told the kit would be emailed to her, and a card asking for a preview and getting none is worse
 * than no preview lane at all.
 *
 * THE RULE HAD ALREADY BEEN WRITTEN DOWN AND NOTHING READ IT. `services/workCards.ts`, above the
 * field, has said since 0183: "`result_recipient` blank means IT IS FOR HER: it lands on Home,
 * there is nothing to send and nothing to preview." Nothing implemented that sentence — blank meant
 * the result landed NOWHERE. That is this repo's named defect class: a specification no code reads
 * is a wish. This validator is the thing that now reads it.
 *
 * WHY THIS ONE EXERCISES THE FUNCTION RATHER THAN READING THE SOURCE. A validator asserting prose
 * rather than behaviour is a named defect class here too. `recipientForResult` is a pure function,
 * so this imports the REAL one and puts inputs through it. Nothing below matches a string in a file.
 *
 * WHAT IS CHECKED, over every case a card can be in
 *
 *   1 · TOTALITY. Every input returns a `firmUserId` that is a real partner out of the registry.
 *       Never null, never blank, never an address, never an id the registry does not know. This is
 *       the whole of the fix: "nobody" stops being a reachable state.
 *   2 · A BLANK RECIPIENT IS THE ASKER'S, AND HERS WHEN NOBODY ASKED. The sentence from
 *       workCards.ts, executing. Nothing is sent, because nothing was addressed.
 *   3 · SOMEBODY OUTSIDE THE FIRM PREVIEWS TO HER. `onwardSend` is set and the result is prepared
 *       for the preview partner — never for the outsider, who must not receive a Home page.
 *   4 · A PARTNER RECIPIENT DOES NOT PREVIEW. Scooter is inside the firm; his own work reaches him.
 *   5 · PROSE NEVER BECOMES AN ADDRESS. A brief whose text names an address, or asks for a
 *       preview, must not change where an unaddressed result goes. A send target derived from
 *       model-written text is the one thing the registry and `assertPreviewLane` exist to prevent.
 *       Fed as `resultRecipient` only when a person actually typed it.
 *   6 · WHITESPACE AND CASE ARE NOT A DIFFERENT PERSON. "  SCOOTER@… " resolves like "scooter@…",
 *       and a recipient of only spaces is blank, not an outsider named " ".
 *
 * HARD-FAILS ON ZERO: if the case table is empty, if the registry exposes no partners, or if the
 * module does not export the function, it exits 1. An empty loop reporting success is Rule 0.
 *
 * `--self-test` replaces the real function with the REAL pre-fix behaviour — "blank means nobody" —
 * and with three other plausible wrong implementations, and requires every one to be caught.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/*
 * THE POINT IS THAT THIS RUNS THE SHIPPED FUNCTION. A validator that reimplemented the rule would
 * agree with itself forever, and a validator asserting prose in a file is this repo's other named
 * defect class. An import that fails fails the validator; it never skips.
 */
async function loadModules() {
  /*
   * Bundled with esbuild rather than imported raw. Node's type stripping runs the TypeScript but
   * will not resolve `../registry/partners` without an extension, which is how every module in
   * `src/` is written. Bundling resolves the real import graph, so the partner registry reached
   * here is the SAME ONE the Worker reaches — which matters, because half of what is asserted below
   * is "this id is a partner the registry knows".
   */
  const esbuild = await import("esbuild");
  const built = await esbuild.build({
    stdin: {
      contents:
        'export { recipientForResult, resultTitleFor, WORK_RESULT_KIND } from "./work/finishedWork.ts";\n' +
        'export { PARTNER_FIRM_USER_IDS } from "./registry/partners.ts";\n',
      resolveDir: path.join(ROOT, "src", "shared"),
      sourcefile: "validator-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const code = built.outputFiles?.[0]?.text ?? "";
  if (code.trim() === "") throw new Error("esbuild produced an empty bundle for shared/work/finishedWork.ts");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`);
  return { finished: mod, partners: { PARTNER_FIRM_USER_IDS: mod.PARTNER_FIRM_USER_IDS } };
}

const SEQUOIA = "fu_sequoia_taylor";
const SCOOTER = "fu_scooter_taylor";

/**
 * Every shape a card's two fields can be in. Each case says what must be true of the ANSWER, never
 * what the implementation should look like.
 */
export function cases() {
  return [
    // ── the October event kit's own state, which is the whole reason this exists ──
    { name: "both fields NULL (the Kirx card)", in: { resultRecipient: null, requestedByEmail: null }, for: SEQUOIA, onward: false, named: null },
    { name: "both fields undefined", in: {}, for: SEQUOIA, onward: false, named: null },
    { name: "recipient blank string", in: { resultRecipient: "" }, for: SEQUOIA, onward: false, named: null },
    { name: "recipient is only whitespace", in: { resultRecipient: "   " }, for: SEQUOIA, onward: false, named: null },

    // ── nobody named, but somebody asked ──
    { name: "unaddressed, Scooter asked", in: { resultRecipient: null, requestedByEmail: "scooter@westpeek.ventures" }, for: SCOOTER, onward: false, named: null },
    { name: "unaddressed, she asked", in: { resultRecipient: null, requestedByEmail: "sequoia@westpeek.ventures" }, for: SEQUOIA, onward: false, named: null },
    { name: "unaddressed, an outsider's address on the request", in: { resultRecipient: null, requestedByEmail: "someone@example.com" }, for: SEQUOIA, onward: false, named: null },

    // ── a partner named: inside the firm, no preview ──
    { name: "addressed to Scooter", in: { resultRecipient: "scooter@westpeek.ventures" }, for: SCOOTER, onward: false, named: "scooter@westpeek.ventures" },
    { name: "addressed to Scooter, shouting and padded", in: { resultRecipient: "  SCOOTER@WESTPEEK.VENTURES " }, for: SCOOTER, onward: false, named: "scooter@westpeek.ventures" },
    { name: "addressed to her", in: { resultRecipient: "sequoia@westpeek.ventures" }, for: SEQUOIA, onward: false, named: "sequoia@westpeek.ventures" },

    // ── somebody outside: it is hers first ──
    { name: "addressed to the guest", in: { resultRecipient: "kirx@example.com" }, for: SEQUOIA, onward: true, named: "kirx@example.com" },
    { name: "addressed outside, Scooter asked", in: { resultRecipient: "kirx@example.com", requestedByEmail: "scooter@westpeek.ventures" }, for: SEQUOIA, onward: true, named: "kirx@example.com" },
    { name: "a lookalike domain", in: { resultRecipient: "scooter@westpeek.ventures.example.com" }, for: SEQUOIA, onward: true, named: "scooter@westpeek.ventures.example.com" },
    { name: "not an address at all", in: { resultRecipient: "Scooter" }, for: SEQUOIA, onward: true, named: "scooter" },
  ];
}

export function audit(recipientForResult, partnerIds) {
  const problems = [];
  const table = cases();

  for (const c of table) {
    let got;
    try {
      got = recipientForResult(c.in);
    } catch (err) {
      problems.push(`${c.name}: threw ${err?.message ?? err}. The function must be total.`);
      continue;
    }

    // 1 · totality
    if (!got || typeof got.firmUserId !== "string" || got.firmUserId.trim() === "") {
      problems.push(`${c.name}: returned no firmUserId. "Addressed to nobody" is the state this exists to remove.`);
      continue;
    }
    if (!partnerIds.includes(got.firmUserId)) {
      problems.push(`${c.name}: returned "${got.firmUserId}", which is not a partner in the registry. A result may only be prepared for somebody the registry knows.`);
    }
    if (got.firmUserId !== c.for) {
      problems.push(`${c.name}: prepared for ${got.firmUserId}, expected ${c.for}.`);
    }
    if (got.onwardSend !== c.onward) {
      problems.push(`${c.name}: onwardSend was ${got.onwardSend}, expected ${c.onward}.`);
    }
    if ((got.namedRecipient ?? null) !== c.named) {
      problems.push(`${c.name}: namedRecipient was ${JSON.stringify(got.namedRecipient ?? null)}, expected ${JSON.stringify(c.named)}.`);
    }
    // 3 · an outsider never receives a Home page
    if (got.onwardSend && got.firmUserId !== SEQUOIA) {
      problems.push(`${c.name}: something bound for outside the firm was prepared for ${got.firmUserId} rather than the preview partner.`);
    }
    if (typeof got.why !== "string" || got.why.trim() === "") {
      problems.push(`${c.name}: returned no reason. The line is shown to her on Home and written to the event.`);
    }
  }

  // 5 · prose may not move a result
  const proseBriefs = [
    "send it to me first for approval before Scooter",
    "email this to kirx@example.com when you are done",
    "To: scooter@westpeek.ventures — preview first please",
  ];
  for (const prose of proseBriefs) {
    const plain = recipientForResult({ resultRecipient: null, requestedByEmail: null });
    const withProse = recipientForResult({ resultRecipient: null, requestedByEmail: null, description: prose, prompt: prose, title: prose });
    if (plain.firmUserId !== withProse.firmUserId || plain.onwardSend !== withProse.onwardSend || (plain.namedRecipient ?? null) !== (withProse.namedRecipient ?? null)) {
      problems.push(
        `Prose in a brief changed where an unaddressed result goes (${JSON.stringify(prose)}). An address must come from a structured field a person set, ` +
          "never from text a model wrote.",
      );
    }
  }

  return { problems, examined: table.length + proseBriefs.length };
}

// ── THE WRONG IMPLEMENTATIONS, for --self-test ─────────────────────────────────────────────────

/** Exactly the behaviour before this fix: blank meant nobody, and the result rested on the card. */
const PRE_FIX = (input) => {
  const named = (input.resultRecipient ?? "").trim().toLowerCase();
  return named === ""
    ? { firmUserId: null, namedRecipient: null, onwardSend: false, why: "nobody was named" }
    : { firmUserId: "fu_sequoia_taylor", namedRecipient: named, onwardSend: true, why: "outside" };
};

/** Files an outsider's draft to the outsider. */
const OUTSIDER_GETS_HOME = (input) => {
  const named = (input.resultRecipient ?? "").trim().toLowerCase();
  if (named === "") return { firmUserId: "fu_sequoia_taylor", namedRecipient: null, onwardSend: false, why: "hers" };
  if (named.endsWith("@westpeek.ventures")) return { firmUserId: named.startsWith("scooter") ? SCOOTER : SEQUOIA, namedRecipient: named, onwardSend: false, why: "partner" };
  return { firmUserId: named, namedRecipient: named, onwardSend: true, why: "outside" };
};

/** Reads the brief's prose and lets it name an address. */
const PROSE_NAMES_AN_ADDRESS = (input) => {
  const fromProse = /([\w.+-]+@[\w.-]+)/.exec(`${input.description ?? ""} ${input.prompt ?? ""}`)?.[1] ?? null;
  const named = ((input.resultRecipient ?? "") || (fromProse ?? "")).trim().toLowerCase();
  if (named === "") return { firmUserId: SEQUOIA, namedRecipient: null, onwardSend: false, why: "hers" };
  if (named.endsWith("@westpeek.ventures")) return { firmUserId: named.startsWith("scooter") ? SCOOTER : SEQUOIA, namedRecipient: named, onwardSend: false, why: "partner" };
  return { firmUserId: SEQUOIA, namedRecipient: named, onwardSend: true, why: "outside" };
};

/** Sends a partner's work straight out without noticing it is already theirs. */
const EVERYTHING_PREVIEWS = (input) => {
  const named = (input.resultRecipient ?? "").trim().toLowerCase();
  return { firmUserId: SEQUOIA, namedRecipient: named || null, onwardSend: true, why: "always preview" };
};

async function selfTest(partnerIds) {
  const wrong = [
    ["the real pre-fix behaviour (blank means nobody)", PRE_FIX],
    ["an outsider given a Home page", OUTSIDER_GETS_HOME],
    ["prose allowed to name an address", PROSE_NAMES_AN_ADDRESS],
    ["a partner's own work held for preview", EVERYTHING_PREVIEWS],
  ];
  let bad = 0;
  for (const [name, fn] of wrong) {
    const { problems } = audit(fn, partnerIds);
    if (problems.length === 0) {
      bad += 1;
      console.error(`  ✗ self-test "${name}": expected a failure, got a pass.`);
    } else {
      console.log(`  ✓ self-test "${name}" — caught (${problems.length} problem(s))`);
    }
  }
  if (bad > 0) {
    console.error(`\nfinished-work-reaches-a-person: ${bad} self-test(s) failed.`);
    process.exit(1);
  }
  console.log(`finished-work-reaches-a-person --self-test: ${wrong.length} wrong implementations, all caught.`);
}

async function main() {
  const { finished, partners } = await loadModules();
  const fn = finished.recipientForResult;
  const partnerIds = partners.PARTNER_FIRM_USER_IDS ?? [];

  if (typeof fn !== "function") {
    console.error("finished-work-reaches-a-person: recipientForResult is not exported. Nothing examined.");
    process.exit(1);
  }
  if (partnerIds.length === 0) {
    console.error("finished-work-reaches-a-person: the partner registry exposed ZERO partners. Nothing to validate against.");
    process.exit(1);
  }

  if (process.argv.includes("--self-test")) return selfTest(partnerIds);

  const { problems, examined } = audit(fn, partnerIds);

  if (examined === 0) {
    console.error("finished-work-reaches-a-person: examined ZERO cases. Passing on an empty loop is Rule 0.");
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error("finished-work-reaches-a-person: a finished result can be addressed to nobody, or to the wrong person.\n");
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error("\nSee src/shared/work/finishedWork.ts.");
    process.exit(1);
  }

  console.log(`finished-work-reaches-a-person: OK — ${examined} cases, every result prepared for a real partner and no prose able to name an address.`);
}

await main();
