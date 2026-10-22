// Thin GitHub REST client for the Actions endpoints this plugin needs.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API = "https://api.github.com";

export interface RepoRef {
  owner: string;
  repo: string;
}

export const repoKey = (ref: RepoRef) => `${ref.owner}/${ref.repo}`;

/** Parses `owner/repo`, https, ssh and git@ GitHub remotes. */
export function parseGithubRepo(value: string): RepoRef | null {
  const text = value.trim();
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text);
  if (short !== null) return { owner: short[1]!, repo: short[2]! };
  const remote =
    /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(text);
  if (remote !== null) return { owner: remote[1]!, repo: remote[2]! };
  return null;
}

// The BB server may not inherit a login shell PATH, so probe the usual spots.
const GH_CANDIDATES = [
  "gh",
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
];

/** Reads the token of the `gh` CLI login, or null when gh is unavailable. */
export async function ghCliToken(): Promise<string | null> {
  for (const bin of GH_CANDIDATES) {
    if (bin.includes("/") && !existsSync(bin)) continue;
    try {
      const { stdout } = await execFileAsync(bin, ["auth", "token"], {
        timeout: 5_000,
      });
      const token = stdout.trim();
      if (token !== "") return token;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface WorkflowRun {
  id: number;
  workflow_id: number;
  name: string | null;
  display_title: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  event: string;
  html_url: string;
  run_number: number;
  run_attempt?: number;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  actor?: { login: string } | null;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: {
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
    started_at?: string | null;
    completed_at?: string | null;
  }[];
}

export function createGithubClient(getToken: () => Promise<string | null>) {
  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const token = await getToken();
    if (token === null) {
      throw new GithubError(
        "No GitHub token: set one in the plugin settings or run `gh auth login`.",
        401,
      );
    }
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bb-plugin-github-actions",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) detail = body.message;
      } catch {
        // Keep statusText.
      }
      throw new GithubError(
        `GitHub ${response.status} for ${path}: ${detail}`,
        response.status,
      );
    }
    return response;
  }

  const base = (ref: RepoRef) =>
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/actions`;

  return {
    async listRuns(ref: RepoRef, perPage: number): Promise<WorkflowRun[]> {
      const response = await request(`${base(ref)}/runs?per_page=${perPage}`);
      const body = (await response.json()) as { workflow_runs: WorkflowRun[] };
      return body.workflow_runs;
    },
    async getRun(ref: RepoRef, runId: number): Promise<WorkflowRun> {
      const response = await request(`${base(ref)}/runs/${runId}`);
      return (await response.json()) as WorkflowRun;
    },
    async listJobs(ref: RepoRef, runId: number): Promise<WorkflowJob[]> {
      const response = await request(
        `${base(ref)}/runs/${runId}/jobs?filter=latest&per_page=100`,
      );
      const body = (await response.json()) as { jobs: WorkflowJob[] };
      return body.jobs;
    },
    async getJob(ref: RepoRef, jobId: number): Promise<WorkflowJob> {
      const response = await request(`${base(ref)}/jobs/${jobId}`);
      return (await response.json()) as WorkflowJob;
    },
    /**
     * Full job log with timestamps stripped, or null while GitHub has none to
     * serve yet (it usually publishes a job's log only once the job ends).
     */
    async jobLog(ref: RepoRef, jobId: number): Promise<string | null> {
      try {
        const response = await request(`${base(ref)}/jobs/${jobId}/logs`);
        return (await response.text())
          .split(/\r?\n/)
          .map((line) =>
            line
              .replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "")
              // ANSI colors and cursor moves that tools print into CI logs.
              // eslint-disable-next-line no-control-regex
              .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""),
          )
          .join("\n");
      } catch (cause) {
        if (cause instanceof GithubError && cause.status === 404) return null;
        throw cause;
      }
    },
    async rerun(ref: RepoRef, runId: number, failedOnly: boolean) {
      await request(
        `${base(ref)}/runs/${runId}/${failedOnly ? "rerun-failed-jobs" : "rerun"}`,
        { method: "POST" },
      );
    },
    async getRepo(ref: RepoRef): Promise<RepoInfo> {
      const response = await request(
        `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
      );
      return (await response.json()) as RepoInfo;
    },
    async listWorkflows(ref: RepoRef): Promise<Workflow[]> {
      const response = await request(`${base(ref)}/workflows?per_page=100`);
      const body = (await response.json()) as { workflows: Workflow[] };
      return body.workflows;
    },
    async listBranches(ref: RepoRef): Promise<string[]> {
      const response = await request(
        `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/branches?per_page=100`,
      );
      const body = (await response.json()) as { name: string }[];
      return body.map((branch) => branch.name);
    },
    async listEnvironments(ref: RepoRef): Promise<string[]> {
      try {
        const response = await request(
          `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/environments?per_page=100`,
        );
        const body = (await response.json()) as {
          environments?: { name: string }[];
        };
        return (body.environments ?? []).map((env) => env.name);
      } catch {
        return [];
      }
    },
    /** A text file at `gitRef`, or null when it does not exist there. */
    async fileContent(
      ref: RepoRef,
      path: string,
      gitRef: string,
    ): Promise<string | null> {
      try {
        const response = await request(
          `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/contents/${path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}?ref=${encodeURIComponent(gitRef)}`,
        );
        const body = (await response.json()) as {
          content?: string;
          encoding?: string;
        };
        if (body.content === undefined) return null;
        return Buffer.from(body.content, "base64").toString("utf8");
      } catch (cause) {
        if (cause instanceof GithubError && cause.status === 404) return null;
        throw cause;
      }
    },
    async dispatch(
      ref: RepoRef,
      workflowId: number,
      gitRef: string,
      inputs: Record<string, string>,
    ) {
      await request(`${base(ref)}/workflows/${workflowId}/dispatches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: gitRef, inputs }),
      });
    },
    async cancel(ref: RepoRef, runId: number) {
      await request(`${base(ref)}/runs/${runId}/cancel`, { method: "POST" });
    },
  };
}

export interface Workflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
}

export interface RepoInfo {
  default_branch: string;
  html_url: string;
  permissions?: { push?: boolean; admin?: boolean };
}

export type GithubClient = ReturnType<typeof createGithubClient>;
