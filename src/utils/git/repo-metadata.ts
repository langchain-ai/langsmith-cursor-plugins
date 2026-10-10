import { execSync } from "node:child_process";
import { GIT_PROVIDERS_REGEX } from "../../constants.js";
import type { GitInfo, GitRemote, RepositoryIdentity } from "../../models/git.js";

export function parseRepoName(remoteUrl: string): RepositoryIdentity | undefined {
  for (const [provider, regex] of Object.entries(GIT_PROVIDERS_REGEX)) {
    const match = remoteUrl.match(regex);
    if (match) return { provider, name: match[1] };
  }
  return undefined;
}

export function getRepoName(cwd: string): RepositoryIdentity | undefined {
  try {
    const output = execSync("git remote -v", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const remotes: GitRemote[] = [];
    for (const line of output.trim().split("\n").filter(Boolean)) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && line.includes("(fetch)")) {
        remotes.push({ name: parts[0], url: parts[1] });
      }
    }
    const origin = remotes.find((r) => r.name === "origin");
    if (origin) {
      const name = parseRepoName(origin.url + " ");
      if (name) return name;
    }
    for (const remote of remotes) {
      const name = parseRepoName(remote.url + " ");
      if (name) return name;
    }
  } catch {
    // Not a git repo or git unavailable — skip.
  }
  return undefined;
}

/** Current branch + commit sha → coding-agent-v1 git_branch / git_commit_sha. */
export function getGitInfo(cwd: string): GitInfo {
  const result: GitInfo = {};
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // "HEAD" means detached — no branch name available.
    if (branch && branch !== "HEAD") result.branch = branch;
  } catch {
    // Not a git repo / git unavailable — skip.
  }
  try {
    const commit = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commit) result.commit = commit;
  } catch {
    // Not a git repo / git unavailable — skip.
  }
  return result;
}
