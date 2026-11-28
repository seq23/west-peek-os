// Copied from: seq23/boss-os scripts/ops/simone/chief-signoff.mjs @ 6d62771ea6b2b60637295bd38eef335bad9f97fa
import { execFileSync } from "node:child_process";
import { verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
export const CHIEF_TRAILERS = Object.freeze({ wren: "Wren <wren@joinwestpeek.com>", walker: "Walker <walker@joinwestpeek.com>" });
const PASS_LINE = /^[\s>*-]*(?:Ship-ready|Launch-ready):\s*PASS\b.*$/gim;
const CHIEF_PASS = /\bPASS\s*(?:—|–|-{1,2}|:)\s*(?:wren|walker)\b/i;
const PROTECTED_PATHS = [
  /^(?:\.github\/|(?:docs\/)?CODEOWNERS$|migrations\/)/,
  /^scripts\/(?:chiefs\/|claimer\/|duties\/(?:partner-session|web-property-change)|vault\/|lib\/vault-env\.|validate\/)/,
  /^src\/client\/pages\/EmployeesPage\.tsx$/,
  /^src\/(?:shared\/(?:registry\/|intake\/|work\/(?:chief|localJob))|worker\/(?:ai\/|auth|accessJwt|env\.|index\.|effects\/|services\/(?:authorize|chief|partnerSession|subscriptionSeats|jobs|workSweep|mailbox|secret|sendAs|webPropertyRegistry)))/,
  /^tests\/(?:chief|partnerSession)/,
  /^(?:package(?:-lock)?\.json|wrangler\.toml)$/,
];

export const protectedChiefPath = (path) => PROTECTED_PATHS.some((rule) => rule.test(path));

export function stampedBy(message) {
  const trailers = execFileSync("git", ["interpret-trailers", "--parse"], { input: message, encoding: "utf8" });
  return Object.keys(CHIEF_TRAILERS).filter((name) => trailers.toLowerCase().split("\n").includes(`co-authored-by: ${CHIEF_TRAILERS[name].toLowerCase()}`));
}

const passLines = (text) => Array.from(String(text ?? "").matchAll(PASS_LINE), ([line]) => line.trim());
const atHead = (line, head) => Boolean(line && new RegExp(`\\bat ${head}\\b`, "i").test(line));

/** Inputs are repository metadata and trusted owner comments. The dispatcher alone holds the signing key. */
function hasApprovalRecord({ repo, number, head, passes, publicKey }) {
  if (!publicKey || passes.length !== 1) return false;
  const [{ line, comment }] = passes;
  const record = /^<!-- westpeek-approval: ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) -->$/m.exec(comment);
  if (!record || !atHead(line, head) || !/\bPASS\s*(?:—|–|-{1,2}|:)\s*Wren\b/i.test(line)) return false;
  try {
    const payload = Buffer.from(record[1], "base64url");
    if (!verify(null, payload, publicKey, Buffer.from(record[2], "base64url"))) return false;
    const signed = JSON.parse(payload.toString("utf8"));
    return signed.repo === repo && signed.number === number && signed.head === head && signed.pass === line &&
      signed.approver === "wren" && /^aie_[a-z0-9_]+$/.test(signed.agent) && signed.agent !== "aie_wren" &&
      signed.priorMergedPull > 0 && Number.isSafeInteger(signed.priorMergedPull) && signed.priorMergedPull !== number;
  } catch {
    return false;
  }
}

export function chiefSignoff({ repo, number, head, branch, isolatedFork, messages, paths, body, comments, publicKey }) {
  if (!SHA.test(head) || !messages.length || !paths.length) return "INCOMPLETE_PR_METADATA";
  const chief = branch.split("/")[0];
  const chiefBranch = branch.includes("/") && Object.hasOwn(CHIEF_TRAILERS, chief);
  const stamps = messages.map(stampedBy);
  const commissioned = chiefBranch || stamps.some((names) => names.length > 0);
  if (commissioned && (!chiefBranch || !stamps.every((names) => names.length === 1 && names[0] === chief))) {
    return "CHIEF_TRAILER_REQUIRED";
  }
  if (commissioned && !isolatedFork) return "CHIEF_FORK_REQUIRED";
  if (commissioned && paths.some(protectedChiefPath)) return "PROTECTED_PATH";

  const bodyPasses = passLines(body);
  const active = comments.reduce((kept, comment) => /^\s*VERDICT:\s*fail\b/i.test(comment) ? [] : [...kept, comment], []);
  const commentPasses = active.flatMap((comment) => passLines(comment).map((line) => ({ line, comment })));
  const chiefPasses = commentPasses.filter(({ line }) => CHIEF_PASS.test(line));
  if (commissioned) {
    return bodyPasses.length || chiefPasses.length || !atHead(commentPasses.at(-1)?.line, head)
      ? "INDEPENDENT_REVIEW_REQUIRED"
      : null;
  }
  if (bodyPasses.some((line) => CHIEF_PASS.test(line))) return "CHIEF_APPROVAL_RECORD_REQUIRED";
  if (!chiefPasses.length) return null;
  if (paths.some(protectedChiefPath)) return "PROTECTED_PATH";
  return hasApprovalRecord({ repo, number, head, passes: chiefPasses, publicKey }) ? null : "CHIEF_APPROVAL_RECORD_REQUIRED";
}

const GH_OPTIONS = { encoding: "utf8", timeout: 60_000, maxBuffer: 30 * 1024 * 1024 };
const read = (endpoint, pages = false) => JSON.parse(execFileSync("gh", ["api", endpoint,
  ...(pages ? ["--paginate", "--slurp"] : [])], GH_OPTIONS));
const NEEDS = {
  INCOMPLETE_PR_METADATA: "GitHub returned incomplete PR metadata. Rerun the check.",
  CHIEF_TRAILER_REQUIRED: "Publish through the chief dispatcher with a matching trailer on every commit.",
  CHIEF_FORK_REQUIRED: "Publish through the configured isolated fork.",
  PROTECTED_PATH: "Use an owner-authored change and independent review for protected paths.",
  INDEPENDENT_REVIEW_REQUIRED: "An independent reviewer must post a PASS for the full head SHA in an owner comment.",
  CHIEF_APPROVAL_RECORD_REQUIRED: "Use a verifiable dispatcher approval for this head or an independent review.",
};

function checkPull(repo, number) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) throw new Error("Invalid PR identity");
  const path = `repos/${repo}/pulls/${number}`;
  const pr = read(path);
  if (pr.state !== "open" || pr.base.ref !== "main") return;
  const head = pr.head.sha;
  if (!SHA.test(head)) throw new Error("Invalid head");
  let reason = "INCOMPLETE_PR_METADATA";
  try {
    const commits = read(`${path}/commits?per_page=100`, true).flat();
    const files = read(`${path}/files?per_page=100`, true).flat();
    const comments = read(`repos/${repo}/issues/${number}/comments?per_page=100`, true).flat();
    if (commits.length === pr.commits && files.length === pr.changed_files && commits.at(-1)?.sha === head) {
      reason = chiefSignoff({
        repo, number, head, branch: pr.head.ref,
        isolatedFork: Boolean(process.env.WP_CHIEF_FORK && pr.head.repo?.fork === true &&
          pr.head.repo.full_name === process.env.WP_CHIEF_FORK && pr.head.repo.full_name !== repo),
        messages: commits.map(({ commit }) => commit.message),
        paths: files.flatMap(({ filename, previous_filename }) => previous_filename ? [filename, previous_filename] : [filename]),
        body: pr.body,
        comments: comments.filter((comment) => comment.author_association === "OWNER").map(({ body }) => body),
        publicKey: process.env.WP_CHIEF_APPROVAL_PUBLIC_KEY,
      });
    }
  } finally {
    if (read(path).head.sha === head) {
      const status = { state: reason ? "failure" : "success", context: "chief-signoff", description: reason ?? "Chief sign-off metadata passed" };
      execFileSync("gh", ["api", `repos/${repo}/statuses/${head}`, "--method", "POST", "--input", "-"],
        { ...GH_OPTIONS, input: JSON.stringify(status), stdio: ["pipe", "ignore", "pipe"] });
    }
  }
  if (reason) throw new Error(reason);
  console.log("Chief sign-off metadata passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    checkPull(process.env.GITHUB_REPOSITORY, event.pull_request?.number ?? event.issue?.number);
  } catch (error) {
    console.error(NEEDS[error.message] ?? "GitHub metadata or the status endpoint was unavailable.");
    process.exitCode = 1;
  }
}
