/**
 * A RUNBOOK FOR A REPO THAT HAS NONE, READ FROM THE REPO ITSELF (0253; owner, 6 Oct 2026: "any new
 * repo we request is allowed"). Until today a repo without `RUNBOOK.md` was a BLOCK ("write one,
 * land it, reply go"). Now the duty generates one from what the repo declares — its package.json
 * scripts and its wrangler config — and commits it on the job's branch, so the PR carries it and
 * the next job reads it like any other.
 *
 * NOTHING IS GUESSED. The deploy route is the one the config declares (`wrangler.toml` name, routes,
 * `pages_build_output_dir`, `[env.production]`; a `deploy*` script in package.json); a repo that
 * declares none gets "not declared" written down, never an invented command. `validate:open-repo-door`
 * runs this generator on fixtures and holds the Deploy section to the config it was given.
 *
 * Pure: every function takes text in and gives text out, so the self-test needs no repo.
 */

/** Scripts a job may run on the model's request — by name, from the RUNBOOK's own list. */
const RUNNABLE = /^(load|import|export|promote|migrate|seed|sync|smoke|check|test|validate|build|lint|typecheck|booth-log|make-|generate|report)/;
/** Scripts that deploy or run forever: never on the "may run" list; the deploy is `~/bin/land`'s. */
const NEVER_RUN = /^(deploy|dev|start|serve|preview|watch|publish|release)/;

/** A light TOML read: top-level `key = "value"` lines and `[section]` / `[[table]]` headers. */
export function readWranglerToml(text) {
  const out = { name: null, main: null, pages_build_output_dir: null, routes: [], envs: [], compatibility_date: null, d1: [], r2: [], kv: [], vars: [] };
  let section = "";
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const head = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (head) {
      section = head[1].trim();
      const env = /^env\.([A-Za-z0-9_-]+)/.exec(section);
      if (env && !out.envs.includes(env[1])) out.envs.push(env[1]);
      if (/d1_databases$/.test(section)) out.d1.push(section);
      if (/r2_buckets$/.test(section)) out.r2.push(section);
      if (/kv_namespaces$/.test(section)) out.kv.push(section);
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (section === "") {
      if (key === "name") out.name = value;
      if (key === "main") out.main = value;
      if (key === "pages_build_output_dir") out.pages_build_output_dir = value;
      if (key === "compatibility_date") out.compatibility_date = value;
      if (key === "routes" || key === "route") out.routes.push(...(value.match(/"([^"]+)"/g) ?? [value]).map((v) => v.replace(/"/g, "")));
    } else if (/^env\.[A-Za-z0-9_-]+$/.test(section)) {
      if (key === "routes" || key === "route") out.routes.push(...(value.match(/"([^"]+)"/g) ?? [value]).map((v) => v.replace(/"/g, "")));
      if (key === "name") out.envs.push(`${section.slice(4)}:${value}`);
    } else if (/^\[?env\.[A-Za-z0-9_-]+\.vars$|\.vars$|^vars$/.test(section)) {
      out.vars.push(key);
    } else if (/routes$/.test(section) && key === "pattern") {
      out.routes.push(value);
    }
  }
  out.routes = [...new Set(out.routes)];
  return out;
}

/** A wrangler.jsonc / wrangler.json, read for the same facts. Comments and trailing commas tolerated. */
export function readWranglerJson(text) {
  let obj = {};
  try {
    obj = JSON.parse(String(text ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    obj = {};
  }
  const routes = [];
  for (const r of Array.isArray(obj.routes) ? obj.routes : obj.route ? [obj.route] : []) routes.push(typeof r === "string" ? r : r?.pattern ?? "");
  for (const env of Object.values(obj.env ?? {})) for (const r of Array.isArray(env?.routes) ? env.routes : []) routes.push(typeof r === "string" ? r : r?.pattern ?? "");
  return {
    name: obj.name ?? null,
    main: obj.main ?? null,
    pages_build_output_dir: obj.pages_build_output_dir ?? null,
    routes: [...new Set(routes.filter(Boolean))],
    envs: Object.keys(obj.env ?? {}),
    compatibility_date: obj.compatibility_date ?? null,
    d1: Array.isArray(obj.d1_databases) ? obj.d1_databases.map((d) => d.binding) : [],
    r2: Array.isArray(obj.r2_buckets) ? obj.r2_buckets.map((d) => d.binding) : [],
    kv: Array.isArray(obj.kv_namespaces) ? obj.kv_namespaces.map((d) => d.binding) : [],
    vars: Object.keys(obj.vars ?? {}),
  };
}

/** The host a Pages/Workers config serves, from its routes (never guessed; null when none is declared). */
export function hostFromRoutes(routes) {
  for (const r of routes ?? []) {
    const m = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?:\/|$|\*)/i.exec(String(r).trim());
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * THE DEPLOY ROUTE, from the repo's own declarations. Returns { kind, line } where line is what the
 * RUNBOOK's Deploy section says. `not declared` is a legitimate answer; a guess is not.
 */
export function deployRouteFrom({ pkg, wrangler }) {
  const scripts = pkg?.scripts ?? {};
  const deployScripts = Object.keys(scripts).filter((k) => /^deploy/.test(k)).sort();
  if (deployScripts.length) {
    const production = deployScripts.find((k) => /prod/.test(k)) ?? deployScripts[0];
    return { kind: "npm", script: production, line: `\`npm run ${production}\` (package.json: \`${scripts[production]}\`)${deployScripts.length > 1 ? ` — the other deploy scripts are ${deployScripts.filter((k) => k !== production).map((k) => `\`${k}\``).join(", ")}` : ""}. Run only through \`~/bin/land\`, never by hand.` };
  }
  if (wrangler?.pages_build_output_dir) {
    return { kind: "pages", line: `Cloudflare Pages project \`${wrangler.name ?? "(unnamed)"}\`, built from \`${wrangler.pages_build_output_dir}\` (wrangler config). Pages deploys on push: a merged PR to main is the production deploy; a branch gets a preview.` };
  }
  if (wrangler?.main) {
    const envs = (wrangler.envs ?? []).filter((e) => !e.includes(":"));
    return { kind: "worker", line: `Cloudflare Worker \`${wrangler.name ?? "(unnamed)"}\` (\`${wrangler.main}\`)${wrangler.routes?.length ? ` on ${wrangler.routes.join(", ")}` : ""}${envs.length ? `; environments: ${envs.join(", ")}` : ""}. Deployed by \`wrangler deploy${envs.includes("production") ? " --env production" : ""}\` from \`~/bin/land\` only — never a bare \`wrangler deploy\`.` };
  }
  return { kind: "none", line: "not declared — no deploy script in package.json and no wrangler config. Nothing deploys until the repo declares a route; a job for this repo opens a PR and stops at the merge." };
}

/** SCREAMING names the repo's source reads from its environment (`env.X`, `process.env.X`, `context.env.X`). Sorted, deduped. */
export function secretNamesInSource(texts) {
  const out = new Set();
  for (const t of texts ?? []) {
    for (const m of String(t).matchAll(/\b(?:env|process\.env|context\.env|ctx\.env|platform\.env)\.([A-Z][A-Z0-9_]{2,})\b/g)) out.add(m[1]);
    for (const m of String(t).matchAll(/\b(?:env|process\.env)\[["']([A-Z][A-Z0-9_]{2,})["']\]/g)) out.add(m[1]);
  }
  return [...out].sort();
}

/** Of the names a repo reads, the ones that look like secrets (a key, token, secret, password, DSN, URL with auth). */
export function likelySecrets(names) {
  return (names ?? []).filter((n) => /(KEY|TOKEN|SECRET|PASSWORD|PASS|DSN|WEBHOOK|SIGNING|PRIVATE|CREDENTIAL|AUTH)/.test(n) && !/^(WP_OS_ENV|NODE_ENV|CI)$/.test(n));
}

/**
 * THE RUNBOOK. Sections every reader of this family expects (what it is, standing rules, how to
 * make a change, guards), plus the two 0253 doors: `## Porter may run` (the repo's own npm scripts a
 * job may run on the model's request, against preview and production) and `## Secrets` (the NAMES
 * the repo reads, never a value). Deterministic for the same inputs.
 */
export function generateRunbook({ repo, githubRepo, pkg, wrangler, sourceNames = [], hostHint = null, today = new Date().toISOString().slice(0, 10) }) {
  const scripts = pkg?.scripts ?? {};
  const names = Object.keys(scripts).sort();
  const mayRun = names.filter((k) => RUNNABLE.test(k) && !NEVER_RUN.test(k));
  const route = deployRouteFrom({ pkg, wrangler });
  const host = hostHint ?? hostFromRoutes(wrangler?.routes ?? []);
  const secrets = likelySecrets(secretNamesInSource(sourceNames)).filter((n) => !(wrangler?.vars ?? []).includes(n));
  const plainVars = (wrangler?.vars ?? []).sort();
  const validate = names.find((k) => k === "validate") ?? names.find((k) => k === "check") ?? names.find((k) => k === "test") ?? null;
  const lines = [
    `# RUNBOOK — ${repo}${host ? ` (${host})` : ""}`,
    "",
    `Generated by Porter on ${today} from this repo's own \`package.json\`${wrangler ? " and wrangler config" : ""} because the repo had no RUNBOOK.md. Everything below is read from those files; nothing is guessed. Edit it freely — a human's words win over this file's.`,
    "",
    "## What this repo is",
    "",
    `- GitHub: \`${githubRepo ?? "(unknown)"}\`; checkout: \`~/GitHub/${repo}\`.`,
    `- Package: \`${pkg?.name ?? repo}\`${pkg?.description ? ` — ${pkg.description}` : ""}.`,
    wrangler ? `- Cloudflare: ${wrangler.pages_build_output_dir ? `a Pages project (\`${wrangler.name ?? repo}\`, output \`${wrangler.pages_build_output_dir}\`)` : wrangler.main ? `a Worker (\`${wrangler.name ?? repo}\`, entry \`${wrangler.main}\`)` : `config \`${wrangler.name ?? repo}\``}${wrangler.d1?.length ? `; D1 bindings: ${wrangler.d1.join(", ")}` : ""}${wrangler.r2?.length ? `; R2: ${wrangler.r2.join(", ")}` : ""}${wrangler.kv?.length ? `; KV: ${wrangler.kv.join(", ")}` : ""}.` : "- No wrangler config: a static or Node project.",
    host ? `- Serves: \`${host}\` (from the config's routes).` : "- Serves: no host declared in the config; the registry learns it when one is.",
    ...(plainVars.length ? [`- Plain variables in the wrangler config (not secrets): ${plainVars.map((v) => `\`${v.toLowerCase()}\` (${v})`).join(", ")}.`] : []),
    "",
    "## Standing rules",
    "",
    "- Branch from `origin/main`; one PR per job; the PR carries the proof (validators, screenshots, link checks).",
    "- Never a bare `wrangler deploy`. Production is reached only through `~/bin/land` (merge → watch main → deploy) or a script named under **Porter may run**.",
    "- Schema changes only through migrations that ship in the deploy; a `wrangler d1 execute` is run only by a script named below.",
    "- Secrets are NAMES here and VALUES in the vault; never in this file, a commit, a log or an email.",
    "",
    "## How to make a change",
    "",
    "1. Read this file, then the request.",
    `2. Make the change; run ${validate ? `\`npm run ${validate}\`` : "the repo's checks (none declared — add one)"} and whatever the change touches.`,
    "3. Commit with what changed and why; push; open the PR. Preview first; land on the partner's word.",
    "",
    "## Deploy",
    "",
    `- ${route.line}`,
    "",
    "## Porter may run",
    "",
    "Scripts a job may run on the model's request, as `npm run <name> -- <args>` in the worktree, against preview or production, each recorded on the card (script, env, exit, one line). Nothing else is run for the model.",
    "",
    ...(mayRun.length ? mayRun.map((k) => `- \`${k}\` — \`${scripts[k]}\``) : ["- (none declared — package.json has no load-/export-/promote-/migrate-/smoke- scripts)"]),
    "",
    "## Secrets",
    "",
    "Names only. The duty looks each up in the vault (exact name, then vendor prefix) before any job asks a partner; a missing one is named in the next email with the `SECRET NAME=value` line that sends it.",
    "",
    ...(secrets.length ? secrets.map((n) => `- \`${n}\``) : ["- (none read from the environment by the source)"]),
    "",
    "## Guards, and what each pins",
    "",
    validate ? `- \`npm run ${validate}\` — the repo's own check; a PR is not green without it.` : "- No validator script is declared. The first job that touches logic adds one.",
    "",
  ];
  return { text: lines.join("\n"), route, host, mayRun, secrets };
}

/** The script names under `## Porter may run` (backticked, first token of each bullet). [] when the section is absent. */
export function porterMayRun(runbookText) {
  const section = sectionOf(runbookText, /^##\s+porter may run\b/im);
  if (!section) return [];
  const out = new Set();
  for (const line of section.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*`?(?:npm run )?([A-Za-z0-9:_.-]+)`?/.exec(line);
    if (m && !NEVER_RUN.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

/** The secret NAMES under `## Secrets` (every SCREAMING token). [] when the section is absent. */
export function runbookSecretNames(runbookText) {
  const section = sectionOf(runbookText, /^##\s+secrets?\b/im);
  if (!section) return [];
  return [...new Set([...section.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)].map((m) => m[1]))].sort();
}

/** The text of one `## …` section up to the next `## `. */
function sectionOf(text, heading) {
  const t = String(text ?? "");
  const m = heading.exec(t);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = t.slice(start);
  const end = rest.search(/^##\s/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The vendor's developer page for a key, when the name says which vendor — for the "Still missing" line. Null otherwise. */
export function vendorPageFor(name) {
  const vendor = /^([A-Z][A-Z0-9]*)_/.exec(String(name))?.[1] ?? "";
  const pages = {
    GIPHY: "https://developers.giphy.com/dashboard/",
    RESEND: "https://resend.com/api-keys",
    STRIPE: "https://dashboard.stripe.com/apikeys",
    OPENAI: "https://platform.openai.com/api-keys",
    ANTHROPIC: null,
    CLOUDFLARE: "https://dash.cloudflare.com/profile/api-tokens",
    TWILIO: "https://console.twilio.com/",
    SENDGRID: "https://app.sendgrid.com/settings/api_keys",
    MAILGUN: "https://app.mailgun.com/",
    GOOGLE: "https://console.cloud.google.com/apis/credentials",
    RUNWARE: "https://my.runware.ai/",
    RUNWAY: "https://app.runwayml.com/",
    ELEVENLABS: "https://elevenlabs.io/app/settings/api-keys",
    SUPABASE: "https://supabase.com/dashboard",
    AIRTABLE: "https://airtable.com/create/tokens",
    NOTION: "https://www.notion.so/my-integrations",
    SLACK: "https://api.slack.com/apps",
    GITHUB: "https://github.com/settings/tokens",
    YOUTUBE: "https://console.cloud.google.com/apis/credentials",
    UNSPLASH: "https://unsplash.com/oauth/applications",
    PEXELS: "https://www.pexels.com/api/",
  };
  return pages[vendor] ?? null;
}

/**
 * A PARTNER'S STANDING CONSTRAINTS, out of the package's prose (0253, addendum 2). Lines that
 * forbid, restrict or reserve something — "never", "only", "must", "do not", "private",
 * "server-side", "not in the vote", "test data … preview only", "do not ask for a login" — kept
 * verbatim (trimmed, bullets stripped, ≤ 240 chars), deduped, at most 40. Read once at the first job
 * and merged into the registry row; every later job's prompt carries them so the model obeys them
 * without restating them or asking about them.
 */
export function constraintsIn(texts) {
  const out = [];
  const seen = new Set();
  const RULE = /\b(never|only|must(?: not)?|do not|don't|do NOT|should not|shouldn't|no (?:one|body)|private|server-side|server side|not (?:in|part of) the vote|preview[- ]only|test data|exclude|excluded|never ask|don't ask|keep .* out|stays? (?:out|off|private)|read-only|verbatim)\b/i;
  for (const t of texts ?? []) {
    for (const raw of String(t).split(/\r?\n/)) {
      const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
      if (line.length < 12 || line.length > 400 || !RULE.test(line)) continue;
      if (/^(```|\||<)/.test(line) || /\b(npm|wrangler|http:|https:)\b/i.test(line) && !/\b(never|only|do not|don't)\b/i.test(line)) continue;
      const key = line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line.slice(0, 240));
      if (out.length >= 40) return out;
    }
  }
  return out;
}
