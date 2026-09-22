/**
 * pages-delivery.mjs — THE ONE ALLOW-LIST for delivery config on a Cloudflare Pages project.
 *
 * WHAT WENT WRONG, 22 Sep 2026. Scooter emailed "westpeek.ventures forms are down". Porter planned
 * the fix and declared a NAMED STOP in his plan: "a Cloudflare secret cannot be read back, so
 * Scooter or Sequoia must run `wrangler pages secret put RESEND_API_KEY`". Nobody had to. The key
 * is in this repo's own vault, the claimer already runs under `vault.mjs run --`, and the whole
 * job — the secret and the two plain variables — was done by hand in four minutes by a coordinator
 * with exactly the access Porter's own process already had. Worse, Porter's BUILD report claimed in
 * `decided_json` that it had set EMAIL_FROM and LEAD_TO itself. It had not. A model reporting work
 * it did not do is the defect this file and its validator exist to make impossible.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────────────────────────────
 *
 * THE MODEL MAY ONLY ASK, BY NAME. Its BUILD result may carry `pages_env: [{ project, name }]`.
 * That is a REQUEST and nothing else: no value, no project it invents, no variable it invents.
 *
 * THE SCRIPT DOES IT, DETERMINISTICALLY. `web-property-change.mjs` runs every allowed request
 * against this list — a plain variable through the Cloudflare API with the vault's
 * CLOUDFLARE_API_TOKEN, a secret through `wrangler pages secret put` fed on STDIN inside the
 * vault-injected environment — and records `<project> · <NAME> · set | already set | failed`.
 * A value is never an argument, never printed, never in the prompt, never in the build proof.
 *
 * THE LIST LIVES HERE AND NOWHERE ELSE. The duty script imports it; so does
 * `scripts/validate/only-the-script-sets-delivery-config.mjs`, which fails the build if the two
 * ever disagree or if a value can reach the model, the console, the proof or the report.
 *
 * WHY THESE VALUES ARE IN THE OPEN. `EMAIL_FROM` and `LEAD_TO` are the firm's own public
 * addresses, already on every form the sites serve. They are configuration, not credentials, and
 * writing them down is what makes "did Porter set it, or say he did?" answerable without asking
 * Cloudflare. The only credential here is RESEND_API_KEY, which is named and never valued.
 */

/** The West Peek Cloudflare account the three Pages projects live in. */
export const CLOUDFLARE_ACCOUNT_ID = "8d147e242033699dd37c6f5a451f48d2";

/** The ONLY Pages projects a duty run may configure. Anything else is refused by name. */
export const PAGES_PROJECTS = Object.freeze(["join-west-peek-main", "west-peek-ventures", "west-peek-productions"]);

/**
 * The ONLY plain-text variables a duty run may set, and the value each one takes. Deterministic:
 * the script does not read a value out of the model's report, so a model cannot change what is set,
 * only ask for the recorded value to be applied.
 */
export const PLAIN_VARS = Object.freeze({
  EMAIL_FROM: "West Peek <hello@joinwestpeek.com>",
  LEAD_TO: "scooter@westpeek.ventures",
});

/**
 * The ONLY secrets a duty run may set, mapped to the vault key the value comes from. The value
 * itself exists in exactly one place at runtime: the child process's stdin.
 */
export const SECRET_VARS = Object.freeze({ RESEND_API_KEY: "RESEND_API_KEY" });

/** Every variable name on the list, plain and secret. */
export const DELIVERY_VARS = Object.freeze([...Object.keys(PLAIN_VARS), ...Object.keys(SECRET_VARS)]);

/** The three outcomes a delivery-config step may record. Never a value, never a sentence. */
export const OUTCOMES = Object.freeze(["set", "already set", "failed", "refused"]);

/**
 * Is this one request on the list? Pure, total, and the only gate — the script calls nothing else.
 * `kind` is "plain" or "secret"; `value` is present ONLY for a plain variable (a secret's value
 * never leaves the vault-injected environment), `vaultKey` names where a secret's value comes from.
 */
export function classify(project, name) {
  const p = String(project ?? "").trim();
  const n = String(name ?? "").trim();
  if (!PAGES_PROJECTS.includes(p)) {
    return { ok: false, kind: null, why: `${p || "(no project)"} is not one of the projects this duty may configure` };
  }
  if (Object.prototype.hasOwnProperty.call(PLAIN_VARS, n)) {
    return { ok: true, kind: "plain", project: p, name: n, value: PLAIN_VARS[n], why: "a plain delivery variable on the list" };
  }
  if (Object.prototype.hasOwnProperty.call(SECRET_VARS, n)) {
    return { ok: true, kind: "secret", project: p, name: n, vaultKey: SECRET_VARS[n], why: "a delivery secret on the list" };
  }
  return { ok: false, kind: null, why: `${n || "(no name)"} is not one of the delivery variables this duty may set` };
}

/**
 * Read the model's `pages_env` request into what the script will do and what it refuses. A request
 * that is not a list of `{ project, name }` yields nothing allowed — never a guess.
 */
export function readRequests(pagesEnv) {
  const allowed = [];
  const refused = [];
  const seen = new Set();
  for (const raw of Array.isArray(pagesEnv) ? pagesEnv : []) {
    const project = String(raw?.project ?? "").trim();
    const name = String(raw?.name ?? "").trim();
    const key = `${project}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const verdict = classify(project, name);
    if (verdict.ok) allowed.push({ project: verdict.project, name: verdict.name, kind: verdict.kind, value: verdict.value, vaultKey: verdict.vaultKey });
    else refused.push({ project, name, why: verdict.why });
  }
  return { allowed, refused };
}

/**
 * One line of the build proof. THE ONLY WAY a delivery step is written down: the project, the
 * variable NAME, and one of `OUTCOMES`. There is no parameter here that could carry a value.
 */
export function proofLine(project, name, outcome, why) {
  const state = OUTCOMES.includes(outcome) ? outcome : "failed";
  return `pages-env: ${project} · ${name} · ${state}${why ? ` (${why})` : ""}`;
}
