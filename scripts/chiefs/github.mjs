// Copied from: seq23/boss-os scripts/ops/simone/github.mjs @ 6d62771ea6b2b60637295bd38eef335bad9f97fa
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CHIEF_TRAILERS, protectedChiefPath, stampedBy } from "./chief-signoff.mjs";

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[a-z0-9_-][a-z0-9_.-]*\/[a-z0-9_-][a-z0-9_.-]*$/i;
const SECRET_WORDS = /[\x00-\x1f\x7f]|(?:Ship-ready|Launch-ready|VERDICT)\s*:/i;
const failure = (code) => ({ ok: false, code });

async function run(token, command, args, input, cwd) {
  const child = exec(command, args, {
    cwd, encoding: "utf8", maxBuffer: 2_000_000, timeout: 18_000,
    env: {
      HOME: homedir(), PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", GH_TOKEN: token,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1",
    },
  });
  child.child.stdin.on("error", () => {});
  child.child.stdin.end(input ?? "");
  return (await child).stdout.trim();
}

/** Review-owned config and live GitHub metadata must both approve a fork before it sees a push. */
async function verifiedFork(read, project, fork) {
  const [base, target, actions] = await Promise.all([
    read(`repos/${project}`), read(`repos/${fork}`), read(`repos/${fork}/actions/permissions`),
  ]);
  return base.full_name === project && base.private === false && base.default_branch === "main" &&
    target.full_name === fork && target.fork === true && target.parent?.full_name === project &&
    actions.enabled === false;
}

/**
 * All mutations go through this broker. The dispatcher supplies a current lease, a credential
 * exclusively for the isolated fork, and a base credential scoped to opening PRs. The model
 * supplies only the title, base SHA, and patch. No checkout, task scripts, hooks, force push,
 * merge, status, review, or arbitrary GitHub API is reachable from this operation.
 */
export async function prepareChiefDraft(call, change, config, dependencies) {
  const { chief, id } = call;
  const { project, fork, forkToken, pullsToken } = config;
  const { action = "draft", base, patch, title } = change ?? {};
  if (!Object.hasOwn(CHIEF_TRAILERS, chief) || typeof id !== "string" || !id ||
    !REPO.test(project) || !REPO.test(fork) || project.toLowerCase() === fork.toLowerCase() ||
    !forkToken || !pullsToken || forkToken === pullsToken) return failure("REPO_SETTINGS");
  if ((action !== "draft" && action !== "resume") || typeof title !== "string" || !title.trim() || title.length > 150 || SECRET_WORDS.test(title) ||
    !SHA.test(base) || (action === "draft" && (typeof patch !== "string" || !patch.trim() || Buffer.byteLength(patch) > 54_000))) {
    return failure("INVALID_DRAFT");
  }
  const execute = dependencies?.run ?? run;
  const recheck = dependencies?.currentLease;
  const safeContent = dependencies?.publicContent;
  const read = async (endpoint, token = pullsToken) => JSON.parse(await execute(token, "gh", ["api", endpoint, "--method", "GET"]));
  const isolated = () => verifiedFork(
    (endpoint) => read(endpoint, endpoint.startsWith(`repos/${fork}/`) || endpoint === `repos/${fork}` ? forkToken : pullsToken),
    project, fork,
  );
  try {
    if (!await recheck?.()) return failure("STALE_CHIEF_RUN");
    if (!await safeContent?.(title, action === "draft" ? patch : "")) return failure("PRIVATE_DRAFT");
    if (!await dependencies?.reviewedBase?.(project) || !await isolated()) {
      return failure("REPO_SETTINGS");
    }
  } catch {
    return failure("REPO_SETTINGS");
  }

  const branch = `${chief}/${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
  const ref = `refs/heads/${branch}`;
  const src = `https://github.com/${project}.git`;
  const dst = `https://github.com/${fork}.git`;
  const forkOwner = fork.split("/")[0];
  const scratch = mkdtempSync(join(tmpdir(), "wpos-chief-git-"));
  const git = (args, input) => execute(forkToken, "git", [
    "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args,
  ], input, scratch);
  const tip = async () => (await git(["ls-remote", dst, ref])).split(/\s+/)[0];
  const pulls = async () => read(`repos/${project}/pulls?state=all&base=main&head=${encodeURIComponent(forkOwner + ":" + branch)}`);
  const matches = (pr, head) => pr?.draft === true && pr.state === "open" && pr.head?.sha === head &&
    pr.head?.ref === branch && pr.head?.repo?.full_name === fork && pr.base?.ref === "main" &&
    Number.isSafeInteger(pr.number) && pr.number > 0;

  try {
    await git(["init", "--bare", "--quiet"]);
    await git(["fetch", "--no-tags", src, "refs/heads/main:refs/heads/main"]);
    const main = await git(["rev-parse", "refs/heads/main"]);
    if (!SHA.test(main)) return failure("GITHUB_UNAVAILABLE");
    const published = await tip();
    let head = published || main;
    if (published) {
      await git(["fetch", "--no-tags", dst, `${ref}:${ref}`]);
      if (await git(["rev-parse", ref]) !== published) return failure("GITHUB_HEAD_CHANGED");
      const commits = (await git(["rev-list", `refs/heads/main..${published}`])).split("\n");
      if (!commits.length || commits.length > 20 || commits.some((sha) => !SHA.test(sha))) return failure("GITHUB_UNAVAILABLE");
      for (const sha of commits) {
        const names = stampedBy(await git(["show", "-s", "--format=%B", sha]));
        if (names.length !== 1 || names[0] !== chief) return failure("CHIEF_TRAILER_REQUIRED");
      }
    }
    const before = await pulls();
    if (!Array.isArray(before) || before.length > 1 || (before.length && !matches(before[0], head))) {
      return failure("GITHUB_PR_UNVERIFIED");
    }
    if (base !== head) return { ...failure("GITHUB_HEAD_CHANGED"), head };
    const trailer = CHIEF_TRAILERS[chief];
    const name = trailer.split(" ")[0];
    if (action === "draft") {
      await git(["read-tree", head]);
      try { await git(["apply", "--cached", "--whitespace=error", "-"], patch); }
      catch { return failure("GITHUB_PATCH_DOES_NOT_APPLY"); }
      const tree = await git(["write-tree"]);
      const paths = (await git(["diff", "--no-renames", "--name-only", "-z", head, tree])).split("\0").filter(Boolean);
      if (!paths.length) return failure("GITHUB_PATCH_EMPTY");
      if (paths.some(protectedChiefPath)) return failure("PROTECTED_PATH");
      head = await git(["-c", `user.name=${name}`, "-c", `user.email=${chief}@users.noreply.github.com`, "commit-tree", tree, "-p", head],
        `${title.trim()}\n\nCo-Authored-By: ${trailer}\n`);
      if (!SHA.test(head)) return failure("GITHUB_UNAVAILABLE");
    } else if (!published) {
      return failure("GITHUB_BRANCH_MISSING");
    }
    const aggregate = (await git(["diff", "--no-renames", "--name-only", "-z", main, head])).split("\0").filter(Boolean);
    if (!aggregate.length || aggregate.some(protectedChiefPath)) return failure("PROTECTED_PATH");
    if (await tip() !== published) return failure("GITHUB_HEAD_CHANGED");
    if (action === "draft") {
      if (!await isolated()) return failure("REPO_SETTINGS");
      if (!await recheck()) return failure("STALE_CHIEF_RUN");
      await git(["push", "--no-verify", dst, `${head}:${ref}`]);
    }
    if (await tip() !== head) return failure("GITHUB_HEAD_CHANGED");

    let current = await pulls();
    if (current.length === 0) {
      if (!await isolated()) return failure("REPO_SETTINGS");
      if (!await recheck()) return failure("STALE_CHIEF_RUN");
      await execute(pullsToken, "gh", ["pr", "create", "--draft", `--repo=${project}`, "--base=main", `--head=${forkOwner}:${branch}`,
        `--title=${title.trim()}`, `--body=Prepared by ${name}. An independent review is required.`]);
      current = await pulls();
    }
    if (current.length !== 1 || !matches(current[0], head)) return failure("GITHUB_PR_UNVERIFIED");
    return { ok: true, receipt: `https://github.com/${project}/pull/${current[0].number}`, head };
  } catch {
    return failure("GITHUB_UNAVAILABLE");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
