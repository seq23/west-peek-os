#!/usr/bin/env node
/**
 * an-effect-cannot-refetch-itself.mjs — `npm run validate:effect-refetch`.
 *
 * ONE ASSERTION: AN EFFECT THAT WRITES MAY NOT DEPEND ON SOMETHING A WRITE CHANGES THE IDENTITY OF.
 *
 * WHAT WENT WRONG, 22 Sep 2026. Wave F (#163, "A refresh that actually refreshes") made every
 * accepted mutation call `invalidateAll()` in `src/client/lib/api.ts`, and made every `useApi`
 * subscribe to it. That is the right design — a surface with stale data is the worse failure — and
 * it turned one pre-existing line in `App.tsx` into an unbounded loop:
 *
 *     const authed = me.status === 200 && me.data;          // ← the RESPONSE OBJECT, not a boolean
 *     useEffect(() => {
 *       if (!authed || active === "home") return;
 *       void api("/api/mp-home/visited", { method: "POST", body: { route: active } });
 *     }, [authed, active]);
 *
 * `&&` returns its right operand, so `authed` was the parsed `/api/me` body — a NEW object on every
 * refetch. The POST invalidated everything, every `useApi` refetched, `me.data` came back as a fresh
 * object, React saw a changed dependency, and the effect fired again. Forever. `useApi` sets
 * `loading: true` on each reload, so EVERY surface in the client sat on its loading text and never
 * settled: "Reading the plan…" on Fund strategy, no `employees-page`, no `on-duty-list`, no
 * `meeting-detail`. Twenty-eight Playwright journeys red on `main` across employee lounge, fund
 * strategy, notifications, duty roster and the design-state sweeps — none of which had changed —
 * and 182 `POST /api/mp-home/visited` writes for a single page view.
 *
 * Nothing caught it, because every part looked correct alone: the effect was right, the invalidation
 * channel was right, and `me.status === 200 && me.data` reads as a boolean to a person. Only the
 * COMBINATION loops, and the combination is exactly what a static scan can see.
 *
 * WHAT IS CHECKED. Across `src/client`, every `useEffect(..., [deps])` whose body calls `api(...)`
 * with a non-GET method (a write — the thing `invalidateAll()` fires on):
 *
 *   1 · NO DEPENDENCY IS A RESPONSE BODY. A dependency written as `x.data` (or `x.data.y`) is a
 *       `useApi` payload object straight from the hook: a new identity every refetch.
 *   2 · NO DEPENDENCY IS AN ALIAS FOR ONE. A dependency that is a plain identifier declared in the
 *       same file as `const <dep> = …` whose right-hand side mentions `.data` must coerce it to a
 *       primitive — `Boolean(…)`, `!!`, `!== null` / `== null`, `?.id`-style property reads,
 *       `.length`, `JSON.stringify(…)`, `String(…)`, `Number(…)`. A bare `&& x.data`, which is what
 *       shipped, is a violation and is named as one.
 *
 * A write in an effect with a STABLE dependency list is fine and common (`[home.status]` in
 * `HomePage.tsx` — a number that does not change identity when the same body is re-read). The rule
 * is about identity, not about writing from an effect.
 *
 * HARD-FAILS ON ZERO (Rule 0): if the scan finds no client files, or finds no `useEffect` that
 * writes, it exits 1 rather than reporting success for having looked at nothing. A guard that can no
 * longer reach what it governs must read as a failure.
 *
 * `--self-test` runs the REAL 22 Sep shape — `const authed = me.status === 200 && me.data;` with the
 * visit-mark effect — through the same checks and requires it caught, plus a dependency that is
 * literally `me.data`, an alias built from `.data` by a ternary, and the shipped boolean form, which
 * must PASS. It also proves the scan is not blind: an empty tree fails.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLIENT = path.join(ROOT, "src", "client");

/** Every `.ts`/`.tsx` under `src/client`, comment-stripped — a commented-out effect is prose. */
function loadClientFiles(dir = CLIENT) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...loadClientFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    out.push({ rel: path.relative(ROOT, full), source: stripCommentsFor(full, readFileSync(full, "utf8")) });
  }
  return out;
}

/** Walk from `open` (index of `(`) to its matching `)`, respecting nesting. Returns the end index. */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every `useEffect(...)` call in a source, as `{ body, deps, line }`. `body` is everything before
 * the final dependency array, `deps` the raw text inside the trailing `[...]`. An effect written
 * without a dependency array runs on every render and is reported separately if it writes.
 */
function effects(source) {
  const found = [];
  const re = /\buseEffect\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(source, open);
    if (close === -1) continue;
    const inner = source.slice(open + 1, close);
    const line = source.slice(0, m.index).split("\n").length;
    const depsOpen = inner.lastIndexOf("[");
    const depsClose = inner.lastIndexOf("]");
    const hasDeps = depsOpen !== -1 && depsClose > depsOpen && inner.slice(depsClose + 1).trim() === "";
    found.push({
      line,
      body: hasDeps ? inner.slice(0, depsOpen) : inner,
      deps: hasDeps ? inner.slice(depsOpen + 1, depsClose) : null,
    });
    re.lastIndex = close;
  }
  return found;
}

/** Does this effect body issue a write? `api(` with a method other than GET. */
function writesFromBody(body) {
  const calls = body.match(/\bapi\s*(?:<[^>]*>)?\s*\([\s\S]*?method\s*:\s*"([A-Z]+)"/g) ?? [];
  const methods = [];
  for (const call of calls) {
    const method = /method\s*:\s*"([A-Z]+)"/.exec(call)?.[1];
    if (method && method !== "GET") methods.push(method);
  }
  return methods;
}

/** Split a dependency array's text into top-level entries. */
function depEntries(deps) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of deps) {
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

/** The `const <name> = …;` initialiser for `name` in this source, or null. */
function initialiserFor(source, name) {
  const re = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*([\\s\\S]*?);`, "m");
  return re.exec(source)?.[1]?.trim() ?? null;
}

/** Coercions that turn a response body into something with stable identity. */
const COERCED = [
  /\bBoolean\s*\(/,
  /!!/,
  /[!=]==?\s*null/,
  /null\s*[!=]==?/,
  /\.length\b/,
  /\bJSON\.stringify\s*\(/,
  /\bString\s*\(/,
  /\bNumber\s*\(/,
  /\.data\s*\?\.[A-Za-z_$]/,
  /\.data\s*[!]?\.[A-Za-z_$]/,
];

export function check(files) {
  const violations = [];
  let examinedFiles = 0;
  let examinedEffects = 0;

  for (const { rel, source } of files) {
    examinedFiles += 1;
    for (const effect of effects(source)) {
      const methods = writesFromBody(effect.body);
      if (methods.length === 0) continue;
      examinedEffects += 1;

      if (effect.deps === null) {
        violations.push(
          `${rel}:${effect.line} — a useEffect that writes (${methods.join(", ")}) has NO dependency array, so it re-runs on every render and every write invalidates every useApi.`,
        );
        continue;
      }

      for (const dep of depEntries(effect.deps)) {
        // 1 · A response body used directly.
        if (/^[A-Za-z_$][\w$]*\.data$/.test(dep) || /^[A-Za-z_$][\w$]*\.data\.[\w$.]+$/.test(dep)) {
          violations.push(
            `${rel}:${effect.line} — dependency \`${dep}\` is a useApi response body: a new object identity on every refetch, so the effect's own write (${methods.join(", ")}) re-triggers it through invalidateAll(). Depend on a primitive read off it instead.`,
          );
          continue;
        }
        // 2 · An alias for one.
        if (!/^[A-Za-z_$][\w$]*$/.test(dep)) continue;
        const init = initialiserFor(source, dep);
        if (!init || !/\.data\b/.test(init)) continue;
        if (COERCED.some((re) => re.test(init))) continue;
        violations.push(
          `${rel}:${effect.line} — dependency \`${dep}\` is declared as \`${init.replace(/\s+/g, " ")}\`, which evaluates to a useApi response body rather than a primitive. The effect's own write (${methods.join(", ")}) makes every useApi refetch, the body comes back as a new object, and the effect fires again — an unbounded write loop. Coerce it (\`Boolean(...)\`, \`!== null\`, or read one field off it).`,
        );
      }
    }
  }

  return { violations, examinedFiles, examinedEffects };
}

function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
    if (!ok) failed += 1;
  };

  const visitEffect = `
  useEffect(() => {
    if (!authed || active === "home") return;
    void api("/api/mp-home/visited", { method: "POST", body: { route: active } });
  }, [authed, active]);`;

  // THE DEFECT THAT ACTUALLY HAPPENED, 22 Sep 2026 — `&&` returning the response body.
  const real = [{ rel: "src/client/App.tsx", source: `const authed = me.status === 200 && me.data;${visitEffect}` }];
  say(
    check(real).violations.some((x) => /`authed` is declared as .*me\.data.*unbounded write loop/s.test(x)),
    "the real 22 Sep shape (`me.status === 200 && me.data` as a dependency) is caught — the defect this file exists for",
  );

  // THE SHIPPED FIX MUST PASS.
  const fixed = [{ rel: "src/client/App.tsx", source: `const authed = me.status === 200 && me.data !== null;${visitEffect}` }];
  say(check(fixed).violations.length === 0, "the shipped boolean form passes");
  say(check(fixed).examinedEffects === 1, "the fixed form is still EXAMINED, not skipped");

  const boolWrapped = [{ rel: "src/client/App.tsx", source: `const authed = me.status === 200 && Boolean(me.data);${visitEffect}` }];
  say(check(boolWrapped).violations.length === 0, "`Boolean(me.data)` passes");

  // A RESPONSE BODY USED DIRECTLY AS A DEPENDENCY.
  const direct = [{
    rel: "src/client/pages/X.tsx",
    source: `useEffect(() => { void api("/api/x", { method: "POST" }); }, [me.data]);`,
  }];
  say(check(direct).violations.some((x) => /`me\.data` is a useApi response body/.test(x)), "a bare `me.data` dependency is caught");

  // AN ALIAS BUILT BY A TERNARY — same identity churn, different spelling.
  const ternary = [{
    rel: "src/client/pages/Y.tsx",
    source: `const who = me.status === 200 ? me.data : null;\nuseEffect(() => { void api("/api/y", { method: "PATCH" }); }, [who]);`,
  }];
  say(check(ternary).violations.some((x) => /`who` is declared as/.test(x)), "an alias built by a ternary is caught");

  // NO DEPENDENCY ARRAY AT ALL.
  const noDeps = [{ rel: "src/client/pages/Z.tsx", source: `useEffect(() => { void api("/api/z", { method: "POST" }); });` }];
  say(check(noDeps).violations.some((x) => /NO dependency array/.test(x)), "a writing effect with no dependency array is caught");

  // A STABLE PRIMITIVE DEPENDENCY IS FINE — this rule is about identity, not about writing.
  const stable = [{
    rel: "src/client/pages/HomePage.tsx",
    source: `useEffect(() => { if (home.status === 200) void api("/api/mp-home/seen", { method: "POST" }); }, [home.status]);`,
  }];
  say(check(stable).violations.length === 0, "a write keyed on `home.status` (a number) passes — HomePage's real shape");

  // A READ-ONLY EFFECT IS NOT THIS SCAN'S BUSINESS.
  const readOnly = [{ rel: "src/client/pages/W.tsx", source: `useEffect(() => { void api("/api/w"); }, [me.data]);` }];
  say(check(readOnly).examinedEffects === 0 && check(readOnly).violations.length === 0, "a GET-only effect is not flagged");

  // PROSE IS NOT CODE.
  const commented = [{
    rel: "src/client/App.tsx",
    source: stripCommentsFor("a.tsx", `// const authed = me.status === 200 && me.data;\nconst authed = me.status === 200 && me.data !== null;${visitEffect}`),
  }];
  say(check(commented).violations.length === 0, "a commented-out copy of the old line does not false-block");

  // RULE 0 — a scan that examines nothing must fail, not pass.
  say(check([]).examinedFiles === 0, "an empty tree examines nothing (the caller turns this into exit 1)");

  if (failed > 0) {
    console.error(`SELF-TEST FAILED: ${failed} case(s)`);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED: every planted defect was caught and the shipped tree passes");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const files = loadClientFiles();
  const { violations, examinedFiles, examinedEffects } = check(files);
  if (examinedFiles === 0 || examinedEffects === 0) {
    console.error(
      `EFFECT-REFETCH SCAN FAILED — it examined nothing (${examinedFiles} client file(s), ${examinedEffects} writing effect(s)). A scan that can no longer reach what it governs must look like a failure.`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(`EFFECT-REFETCH SCAN FAILED — ${violations.length} violation(s):`);
    for (const x of violations) console.error(`  · ${x}`);
    process.exit(1);
  }
  console.log(
    `EFFECT-REFETCH SCAN PASSED: ${examinedEffects} effect(s) that write, across ${examinedFiles} client file(s) — ` +
      "none depends on a useApi response body, so no write can re-trigger itself through invalidateAll().",
  );
}
