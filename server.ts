// bb-plugin-github-actions — GitHub Actions runs for the repositories of your BB
// projects: live status, rerun / cancel, and a one-click agent thread that
// investigates a failed run.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createGithubClient,
  ghCliToken,
  GithubError,
  parseGithubRepo,
  repoKey,
  type RepoRef,
  type WorkflowJob,
  type WorkflowRun,
} from "./github";
import { dispatchInputSchema, parseDispatchSpec, type DispatchSpec } from "./workflows";

const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "action_required",
]);

const runSchema = z.object({
  repo: z.string(),
  id: z.number(),
  workflowId: z.number(),
  workflow: z.string(),
  title: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  state: z.enum(["active", "failed", "success", "other"]),
  branch: z.string().nullable(),
  sha: z.string(),
  event: z.string(),
  actor: z.string().nullable(),
  url: z.string(),
  runNumber: z.number(),
  attempt: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  analysisThreadId: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;

const repoStatusSchema = z.object({
  repo: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  error: z.string().nullable(),
});
export type RepoStatus = z.infer<typeof repoStatusSchema>;

const jobSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  failedSteps: z.array(z.string()),
});
export type Job = z.infer<typeof jobSchema>;

const snapshotSchema = z.object({
  repos: z.array(repoStatusSchema),
  runs: z.array(runSchema),
  fetchedAt: z.string().nullable(),
  authError: z.string().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const runRef = z.object({
  repo: z.string().min(3).max(200),
  runId: z.number().int().positive(),
});

const stepSchema = z.object({
  number: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Step = z.infer<typeof stepSchema>;

const threadSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  status: z.string(),
  updatedAt: z.number(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

const workflowSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  state: z.string(),
  url: z.string(),
  dispatchable: z.boolean(),
});
export type WorkflowSummary = z.infer<typeof workflowSchema>;
export type { DispatchInput } from "./workflows";

const repoInput = z.object({ repo: z.string().min(3).max(200) });
const gitRefSchema = z.string().min(1).max(250).regex(/^[^\s~^:?*\[\\]+$/);

const threadIds = z.array(z.string().min(1).max(100)).max(20);

export const rpcContract = defineRpcContract({
  runs_list: {
    input: z.object({ refresh: z.boolean().optional() }).nullable(),
    output: snapshotSchema,
  },
  run_jobs: { input: runRef, output: z.object({ jobs: z.array(jobSchema) }) },
  run_rerun: {
    input: runRef.extend({ failedOnly: z.boolean() }),
    output: z.object({ ok: z.literal(true) }),
  },
  run_cancel: { input: runRef, output: z.object({ ok: z.literal(true) }) },
  run_analyze: {
    input: runRef,
    output: z.object({ threadId: z.string(), created: z.boolean() }),
  },
  run_analysis_prompt: {
    input: runRef,
    output: z.object({ prompt: z.string(), projectId: z.string().nullable() }),
  },
  run_send: {
    input: runRef.extend({
      threadIds: threadIds.min(1),
      note: z.string().max(4000),
      includeLogs: z.boolean(),
    }),
    output: z.object({
      sent: z.array(z.string()),
      failed: z.array(z.object({ threadId: z.string(), error: z.string() })),
    }),
  },
  job_log: {
    input: z.object({
      repo: z.string().min(3).max(200),
      jobId: z.number().int().positive(),
    }),
    output: z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      steps: z.array(stepSchema),
      log: z.string().nullable(),
      truncated: z.boolean(),
    }),
  },
  threads_list: {
    input: z.null(),
    output: z.object({ threads: z.array(threadSummarySchema) }),
  },
  workflows_list: {
    input: repoInput,
    output: z.object({
      defaultBranch: z.string(),
      canDispatch: z.boolean(),
      workflows: z.array(workflowSchema),
    }),
  },
  workflow_form: {
    input: repoInput.extend({
      workflowId: z.number().int().positive(),
      ref: gitRefSchema,
    }),
    output: z.object({
      branches: z.array(z.string()),
      environments: z.array(z.string()),
      dispatchable: z.boolean(),
      inputs: z.array(dispatchInputSchema),
    }),
  },
  workflow_dispatch: {
    input: repoInput.extend({
      workflowId: z.number().int().positive(),
      ref: gitRefSchema,
      inputs: z.record(z.string().max(100), z.string().max(10_000)),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  subscriptions_get: {
    input: z.object({ repo: z.string().min(3).max(200) }),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
  subscriptions_set: {
    input: z.object({ repo: z.string().min(3).max(200), threadIds }),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
});

/** Realtime channel app.tsx listens on. */
const RUNS_CHANGED = "runs-changed";
const ANALYSES_KEY = "analyses";
const LOG_TAIL_LINES = 150;
const LOG_TAIL_MAX_CHARS = 8_000;
const MAX_ANALYZED_JOBS = 3;
const SUBSCRIPTIONS_KEY = "subscriptions";
/** Bytes of log the viewer receives; the tail is what matters. */
const LOG_VIEW_MAX_CHARS = 400_000;

function runState(run: WorkflowRun): Run["state"] {
  if (run.status !== null && ACTIVE_STATUSES.has(run.status)) return "active";
  if (run.conclusion === "success") return "success";
  if (run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) {
    return "failed";
  }
  return "other";
}

/**
 * The lines leading up to the last `##[error]` annotation: the log tail is
 * usually post-job cleanup, while the cause sits just before the error.
 */
function errorExcerpt(lines: string[]): string {
  let end = lines.length;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.startsWith("##[error]")) {
      end = index + 1;
      break;
    }
  }
  // Progress spinners repeat one line with a changing counter; keep the last.
  const compact: string[] = [];
  for (const line of lines.slice(0, end)) {
    const shape = line.replace(/\d+/g, "#");
    const previous = compact.at(-1);
    if (previous !== undefined && previous.replace(/\d+/g, "#") === shape) {
      compact[compact.length - 1] = line;
    } else {
      compact.push(line);
    }
  }
  return compact.slice(-LOG_TAIL_LINES).join("\n");
}

function toJob(job: WorkflowJob): Job {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    url: job.html_url,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    failedSteps: (job.steps ?? [])
      .filter((step) => step.conclusion === "failure")
      .map((step) => step.name),
  };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubToken: {
      type: "string",
      label: "GitHub token (optional; falls back to `gh auth token`)",
      secret: true,
    },
    useProjectRepos: {
      type: "boolean",
      label: "Watch the GitHub repositories of BB projects",
      default: true,
    },
    extraRepos: {
      type: "string",
      label: "Extra repositories (owner/repo, one per line)",
      experimental_multiline: true,
      default: "",
    },
    runsPerRepo: {
      type: "number",
      label: "Recent runs to load per repository",
      experimental_schema: z.number().int().min(1).max(100),
      default: 20,
    },
    pollSeconds: {
      type: "number",
      label: "GitHub polling interval, seconds",
      experimental_schema: z.number().int().min(10).max(3600),
      default: 30,
    },
    fallbackProject: {
      type: "project",
      label: "Project for investigations of repositories without a BB project",
    },
    analysisModel: {
      type: "string",
      label: "Model for failure investigations (empty: the project default)",
      default: "",
    },
  });

  async function token(): Promise<string | null> {
    const { githubToken } = await settings.get();
    if (typeof githubToken === "string" && githubToken.trim() !== "") {
      return githubToken.trim();
    }
    return ghCliToken();
  }
  const github = createGithubClient(token);

  interface WatchedRepo {
    ref: RepoRef;
    projectId: string | null;
    projectName: string | null;
  }

  async function watchedRepos(): Promise<Map<string, WatchedRepo>> {
    const { useProjectRepos, extraRepos } = await settings.get();
    const repos = new Map<string, WatchedRepo>();
    if (useProjectRepos) {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      for (const project of projects) {
        if (project.gitRemoteUrl === null) continue;
        const ref = parseGithubRepo(project.gitRemoteUrl);
        if (ref === null) continue;
        const key = repoKey(ref).toLowerCase();
        if (!repos.has(key)) {
          repos.set(key, {
            ref,
            projectId: project.id,
            projectName: project.name,
          });
        }
      }
    }
    for (const line of extraRepos.split(/[\n,]/)) {
      if (line.trim() === "") continue;
      const ref = parseGithubRepo(line);
      if (ref === null) {
        bb.log.warn(`ignoring invalid repo in settings: ${line}`);
        continue;
      }
      const key = repoKey(ref).toLowerCase();
      if (!repos.has(key)) {
        repos.set(key, { ref, projectId: null, projectName: null });
      }
    }
    return repos;
  }

  /** Untrusted repo names from the app must be one of the watched repos. */
  async function resolveRepo(repo: string): Promise<WatchedRepo> {
    const watched = (await watchedRepos()).get(repo.toLowerCase());
    if (watched === undefined) {
      throw new Error(`Repository ${repo} is not watched by the plugin`);
    }
    return watched;
  }

  async function analyses(): Promise<Record<string, string>> {
    return (await bb.storage.kv.get<Record<string, string>>(ANALYSES_KEY)) ?? {};
  }
  const analysisKey = (repo: string, runId: number, attempt: number) =>
    `${repo.toLowerCase()}#${runId}#${attempt}`;

  // ---- Snapshot cache, refreshed by the poller and on demand ----

  let snapshot: Snapshot = {
    repos: [],
    runs: [],
    fetchedAt: null,
    authError: null,
  };
  let inflight: Promise<Snapshot> | null = null;
  let lastSignature = "";

  /** Grace period after the last job ends before overriding GitHub's status. */
  const SETTLE_AFTER_MS = 60_000;

  async function settleFromJobs(
    ref: RepoRef,
    run: WorkflowRun,
  ): Promise<WorkflowRun | null> {
    const jobs = await github.listJobs(ref, run.id);
    if (jobs.length === 0 || jobs.some((job) => job.status !== "completed")) {
      return null;
    }
    const lastEnd = Math.max(
      ...jobs.map((job) => Date.parse(job.completed_at ?? "") || 0),
    );
    if (Date.now() - lastEnd < SETTLE_AFTER_MS) return null;
    const conclusions = jobs.map((job) => job.conclusion);
    const conclusion = conclusions.some(
      (value) => value !== null && FAILED_CONCLUSIONS.has(value),
    )
      ? "failure"
      : conclusions.includes("cancelled")
        ? "cancelled"
        : "success";
    return {
      ...run,
      status: "completed",
      conclusion,
      updated_at: new Date(lastEnd).toISOString(),
    };
  }

  async function fetchSnapshot(): Promise<Snapshot> {
    const repos = [...(await watchedRepos()).values()];
    const { runsPerRepo } = await settings.get();
    const analysisMap = await analyses();
    let authError: string | null = null;
    const results = await Promise.all(
      repos.map(async (watched) => {
        const key = repoKey(watched.ref);
        try {
          const runs = await github.listRuns(watched.ref, runsPerRepo);
          return { watched, runs, error: null as string | null };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (cause instanceof GithubError && cause.status === 401) {
            authError = message;
          }
          bb.log.warn(`listing runs failed for ${key}: ${message}`);
          return { watched, runs: [] as WorkflowRun[], error: message };
        }
      }),
    );
    const runs: Run[] = [];
    // GitHub sometimes leaves a run "in_progress" long after every job ended.
    // Trust the jobs once they have all been done for a while.
    await Promise.all(
      results.flatMap(({ watched, runs: repoRuns }) =>
        repoRuns
          .filter((run) => run.status === "in_progress")
          .map(async (run) => {
            const settled = await settleFromJobs(watched.ref, run).catch(() => null);
            if (settled !== null) repoRuns[repoRuns.indexOf(run)] = settled;
          }),
      ),
    );
    for (const { watched, runs: repoRuns } of results) {
      const repo = repoKey(watched.ref);
      for (const run of repoRuns) {
        const attempt = run.run_attempt ?? 1;
        runs.push({
          repo,
          id: run.id,
          workflowId: run.workflow_id,
          workflow: run.name ?? "workflow",
          title: run.display_title,
          status: run.status ?? "unknown",
          conclusion: run.conclusion,
          state: runState(run),
          branch: run.head_branch,
          sha: run.head_sha,
          event: run.event,
          actor: run.actor?.login ?? null,
          url: run.html_url,
          runNumber: run.run_number,
          attempt,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
          startedAt: run.run_started_at ?? null,
          analysisThreadId:
            analysisMap[analysisKey(repo, run.id, attempt)] ?? null,
        });
      }
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      repos: results.map(({ watched, error }) => ({
        repo: repoKey(watched.ref),
        projectId: watched.projectId,
        projectName: watched.projectName,
        error,
      })),
      runs,
      fetchedAt: new Date().toISOString(),
      authError,
    };
  }

  // Failed attempts already seen, so subscriptions only get new failures.
  // Null until the first fetch: failures that predate the load are not news.
  let seenFailures: Set<string> | null = null;

  async function notifySubscribers(next: Snapshot) {
    const failedKeys = next.runs
      .filter((run) => run.state === "failed")
      .map((run) => ({ run, key: analysisKey(run.repo, run.id, run.attempt) }));
    const previous = seenFailures;
    seenFailures = new Set([
      ...(previous ?? []),
      ...failedKeys.map(({ key }) => key),
    ]);
    if (previous === null) return;
    const fresh = failedKeys.filter(({ key }) => !previous.has(key));
    if (fresh.length === 0) return;
    const subs = await subscriptions();
    const watched = await watchedRepos();
    for (const { run } of fresh) {
      const targets = subs[run.repo.toLowerCase()] ?? [];
      const repo = watched.get(run.repo.toLowerCase());
      if (targets.length === 0 || repo === undefined) continue;
      await sendRun(repo, run.id, targets, "A new CI/CD run failed:", true).catch(
        (cause) => bb.log.warn(`auto-send failed: ${String(cause)}`),
      );
    }
  }

  function refresh(): Promise<Snapshot> {
    inflight ??= fetchSnapshot()
      .then((next) => {
        snapshot = next;
        void notifySubscribers(next);
        const signature = JSON.stringify({ ...next, fetchedAt: null });
        if (signature !== lastSignature) {
          lastSignature = signature;
          bb.realtime.publish(RUNS_CHANGED, {
            active: next.runs.filter((run) => run.state === "active").length,
          });
        }
        return next;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  // ---- Failure analysis ----

  /** Markdown summary of a run: metadata, failed jobs and their log tails. */
  async function buildRunReport(
    watched: WatchedRepo,
    runId: number,
    includeLogs: boolean,
  ) {
    const run = await github.getRun(watched.ref, runId);
    const jobs = await github.listJobs(watched.ref, runId);
    const failed = jobs.filter(
      (job) => job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion),
    );
    const sections: string[] = [];
    for (const job of failed.slice(0, MAX_ANALYZED_JOBS)) {
      const steps = toJob(job).failedSteps;
      const lines = [
        `### Job: ${job.name}`,
        `Link: ${job.html_url ?? "—"}`,
        `Failed steps: ${steps.length > 0 ? steps.join(", ") : "—"}`,
      ];
      if (includeLogs) {
        let tail: string;
        try {
          const log = await github.jobLog(watched.ref, job.id);
          tail =
            log === null
              ? "(GitHub has not published the log yet)"
              : errorExcerpt(log.split("\n"));
          if (tail.length > LOG_TAIL_MAX_CHARS) tail = tail.slice(-LOG_TAIL_MAX_CHARS);
        } catch (cause) {
          tail = `(could not download the log: ${cause instanceof Error ? cause.message : String(cause)})`;
        }
        lines.push("Log excerpt:", "```", tail, "```");
      }
      sections.push(lines.join("\n"));
    }
    if (failed.length > MAX_ANALYZED_JOBS) {
      sections.push(
        `…and ${failed.length - MAX_ANALYZED_JOBS} more failed job(s): ${failed
          .slice(MAX_ANALYZED_JOBS)
          .map((job) => job.name)
          .join(", ")}`,
      );
    }
    const state = runState(run);
    const verdict =
      state === "active"
        ? `running (${run.status})`
        : (run.conclusion ?? run.status ?? "—");
    const report = [
      `**GitHub Actions: ${run.name ?? "workflow"} #${run.run_number}** — ${verdict}`,
      "",
      `- Repository: ${repoKey(watched.ref)}`,
      `- Title: ${run.display_title}`,
      `- Branch: ${run.head_branch ?? "—"}, commit ${run.head_sha}`,
      `- Event: ${run.event}, attempt ${run.run_attempt ?? 1}`,
      `- Run: ${run.html_url}`,
      ...(sections.length > 0 ? ["", sections.join("\n\n")] : []),
    ].join("\n");
    return { report, run, failed: state === "failed" };
  }

  async function buildAnalysisPrompt(watched: WatchedRepo, runId: number) {
    const { report, run } = await buildRunReport(watched, runId, true);
    const repo = repoKey(watched.ref);
    const prompt = [
      "A GitHub Actions CI/CD run failed. Find out what happened.",
      "",
      report,
      "",
      "What to do:",
      `1. Find the root cause. If the excerpt above is not enough, run \`gh run view ${run.id} --repo ${repo} --log-failed\`.`,
      "2. Tell a real code bug apart from a flaky test or an infrastructure problem (runner, network, secrets, limits).",
      `3. If it is a code bug, find it in the repository (the run used commit ${run.head_sha.slice(0, 7)}) and propose a fix.`,
      "4. If the failure is transient, say that a rerun is enough.",
      "Do not push changes or rerun the workflow without my confirmation. Summarize the cause, the evidence from the log, and the recommended action.",
    ].join("\n");
    return { prompt, run };
  }

  async function sendRun(
    watched: WatchedRepo,
    runId: number,
    targets: readonly string[],
    note: string,
    includeLogs: boolean,
  ) {
    const { report } = await buildRunReport(watched, runId, includeLogs);
    const text = note.trim() === "" ? report : `${note.trim()}\n\n${report}`;
    const sent: string[] = [];
    const failed: { threadId: string; error: string }[] = [];
    for (const threadId of new Set(targets)) {
      try {
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [{ type: "text", text, mentions: [] }],
        });
        sent.push(threadId);
      } catch (cause) {
        failed.push({
          threadId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    bb.log.info(
      `run ${repoKey(watched.ref)}#${runId} sent to ${sent.length} thread(s), ${failed.length} failed`,
    );
    return { sent, failed };
  }

  // ---- Manual workflow runs (workflow_dispatch) ----

  const WORKFLOW_CACHE_MS = 5 * 60_000;
  const workflowCache = new Map<
    string,
    { at: number; value: { defaultBranch: string; canDispatch: boolean; workflows: WorkflowSummary[] } }
  >();
  const specCache = new Map<string, { at: number; spec: DispatchSpec }>();

  async function dispatchSpec(
    watched: WatchedRepo,
    path: string,
    gitRef: string,
  ): Promise<DispatchSpec> {
    const key = `${repoKey(watched.ref).toLowerCase()}:${gitRef}:${path}`;
    const cached = specCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < WORKFLOW_CACHE_MS) {
      return cached.spec;
    }
    const source = await github.fileContent(watched.ref, path, gitRef);
    const spec = source === null ? { dispatchable: false, inputs: [] } : parseDispatchSpec(source);
    specCache.set(key, { at: Date.now(), spec });
    return spec;
  }

  async function listWorkflows(watched: WatchedRepo, fresh = false) {
    const key = repoKey(watched.ref).toLowerCase();
    const cached = workflowCache.get(key);
    if (!fresh && cached !== undefined && Date.now() - cached.at < WORKFLOW_CACHE_MS) {
      return cached.value;
    }
    const [info, workflows] = await Promise.all([
      github.getRepo(watched.ref),
      github.listWorkflows(watched.ref),
    ]);
    const summaries = await Promise.all(
      workflows
        // Dynamic workflows (Dependabot, Pages, Copilot) have no YAML file.
        .filter((workflow) => workflow.path.startsWith(".github/workflows/"))
        .map(async (workflow) => ({
          id: workflow.id,
          name: workflow.name,
          path: workflow.path,
          state: workflow.state,
          url: workflow.html_url,
          dispatchable:
            workflow.state === "active" &&
            (await dispatchSpec(watched, workflow.path, info.default_branch)
              .then((spec) => spec.dispatchable)
              .catch(() => false)),
        })),
    );
    summaries.sort(
      (a, b) =>
        Number(b.dispatchable) - Number(a.dispatchable) || a.name.localeCompare(b.name),
    );
    const value = {
      defaultBranch: info.default_branch,
      canDispatch: info.permissions?.push ?? true,
      workflows: summaries,
    };
    workflowCache.set(key, { at: Date.now(), value });
    return value;
  }

  async function findWorkflow(watched: WatchedRepo, workflowId: number) {
    const { workflows } = await listWorkflows(watched);
    const workflow = workflows.find((item) => item.id === workflowId);
    if (workflow === undefined) {
      throw new Error(`Workflow ${workflowId} not found in ${repoKey(watched.ref)}`);
    }
    return workflow;
  }

  /** Checks values against the declared inputs, as GitHub would reject them. */
  function validateInputs(spec: DispatchSpec, values: Record<string, string>) {
    const out: Record<string, string> = {};
    for (const input of spec.inputs) {
      const value = values[input.name] ?? input.default ?? "";
      if (input.required && value === "") {
        throw new Error(`Input "${input.name}" is required`);
      }
      if (value === "") continue;
      if (input.type === "choice" && !input.options.includes(value)) {
        throw new Error(`Input "${input.name}" must be one of: ${input.options.join(", ")}`);
      }
      if (input.type === "boolean" && value !== "true" && value !== "false") {
        throw new Error(`Input "${input.name}" must be true or false`);
      }
      if (input.type === "number" && !Number.isFinite(Number(value))) {
        throw new Error(`Input "${input.name}" must be a number`);
      }
      out[input.name] = value;
    }
    const unknown = Object.keys(values).filter(
      (name) => !spec.inputs.some((input) => input.name === name),
    );
    if (unknown.length > 0) {
      throw new Error(`Unknown input(s): ${unknown.join(", ")}`);
    }
    return out;
  }

  async function dispatchWorkflow(
    watched: WatchedRepo,
    workflowId: number,
    gitRef: string,
    values: Record<string, string>,
  ) {
    const workflow = await findWorkflow(watched, workflowId);
    specCache.clear();
    const spec = await dispatchSpec(watched, workflow.path, gitRef);
    if (!spec.dispatchable) {
      throw new Error(
        `${workflow.name} has no workflow_dispatch trigger on ${gitRef}, so it cannot be run manually`,
      );
    }
    const inputs = validateInputs(spec, values);
    await github.dispatch(watched.ref, workflowId, gitRef, inputs);
    bb.log.info(`dispatched ${workflow.path} on ${repoKey(watched.ref)}@${gitRef}`);
    // GitHub needs a moment before the new run shows up in the list.
    for (const delay of [2_000, 6_000]) {
      setTimeout(() => void refresh().catch(() => {}), delay);
    }
    return workflow;
  }

  async function subscriptions(): Promise<Record<string, string[]>> {
    return (
      (await bb.storage.kv.get<Record<string, string[]>>(SUBSCRIPTIONS_KEY)) ?? {}
    );
  }

  async function projectFor(watched: WatchedRepo): Promise<string | null> {
    if (watched.projectId !== null) return watched.projectId;
    const { fallbackProject } = await settings.get();
    return typeof fallbackProject === "string" && fallbackProject !== ""
      ? fallbackProject
      : null;
  }

  bb.rpc.register(rpcContract, {
    run_send: async ({ repo, runId, threadIds: targets, note, includeLogs }) => {
      const watched = await resolveRepo(repo);
      return sendRun(watched, runId, targets, note, includeLogs);
    },
    job_log: async ({ repo, jobId }) => {
      const watched = await resolveRepo(repo);
      const job = await github.getJob(watched.ref, jobId);
      let log = await github.jobLog(watched.ref, jobId);
      const truncated = log !== null && log.length > LOG_VIEW_MAX_CHARS;
      if (log !== null && truncated) log = log.slice(-LOG_VIEW_MAX_CHARS);
      return {
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        steps: (job.steps ?? []).map((step) => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
          startedAt: step.started_at ?? null,
          completedAt: step.completed_at ?? null,
        })),
        log,
        truncated,
      };
    },
    threads_list: async () => {
      const [threads, projects] = await Promise.all([
        bb.sdk.threads.list({ archived: false, limit: 200 }),
        bb.sdk.projects.list({ includePersonal: true }),
      ]);
      const names = new Map(projects.map((project) => [project.id, project.name]));
      return {
        threads: threads
          .filter((thread) => thread.visibility !== "hidden")
          .map((thread) => ({
            id: thread.id,
            title: thread.title ?? thread.titleFallback ?? thread.id,
            projectId: thread.projectId,
            projectName: names.get(thread.projectId) ?? "",
            status: thread.status,
            updatedAt: thread.updatedAt,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      };
    },
    workflows_list: async ({ repo }) => listWorkflows(await resolveRepo(repo)),
    workflow_form: async ({ repo, workflowId, ref }) => {
      const watched = await resolveRepo(repo);
      const workflow = await findWorkflow(watched, workflowId);
      const [branches, environments, spec] = await Promise.all([
        github.listBranches(watched.ref),
        github.listEnvironments(watched.ref),
        dispatchSpec(watched, workflow.path, ref),
      ]);
      return { branches, environments, ...spec };
    },
    workflow_dispatch: async ({ repo, workflowId, ref, inputs }) => {
      await dispatchWorkflow(await resolveRepo(repo), workflowId, ref, inputs);
      return { ok: true as const };
    },
    subscriptions_get: async ({ repo }) => {
      const watched = await resolveRepo(repo);
      const key = repoKey(watched.ref).toLowerCase();
      return { threadIds: (await subscriptions())[key] ?? [] };
    },
    subscriptions_set: async ({ repo, threadIds: targets }) => {
      const watched = await resolveRepo(repo);
      const key = repoKey(watched.ref).toLowerCase();
      const next = { ...(await subscriptions()) };
      if (targets.length === 0) delete next[key];
      else next[key] = [...new Set(targets)];
      await bb.storage.kv.set(SUBSCRIPTIONS_KEY, next);
      return { threadIds: next[key] ?? [] };
    },
    runs_list: async (input) => {
      if (input?.refresh === true || snapshot.fetchedAt === null) {
        return refresh();
      }
      return snapshot;
    },
    run_jobs: async ({ repo, runId }) => {
      const watched = await resolveRepo(repo);
      const jobs = await github.listJobs(watched.ref, runId);
      return { jobs: jobs.map(toJob) };
    },
    run_rerun: async ({ repo, runId, failedOnly }) => {
      const watched = await resolveRepo(repo);
      await github.rerun(watched.ref, runId, failedOnly);
      bb.log.info(`rerun requested for ${repo}#${runId} (failedOnly=${failedOnly})`);
      void refresh().catch(() => {});
      return { ok: true as const };
    },
    run_cancel: async ({ repo, runId }) => {
      const watched = await resolveRepo(repo);
      await github.cancel(watched.ref, runId);
      void refresh().catch(() => {});
      return { ok: true as const };
    },
    run_analysis_prompt: async ({ repo, runId }) => {
      const watched = await resolveRepo(repo);
      const { prompt } = await buildAnalysisPrompt(watched, runId);
      return { prompt, projectId: await projectFor(watched) };
    },
    run_analyze: async ({ repo, runId }) => {
      const watched = await resolveRepo(repo);
      const projectId = await projectFor(watched);
      if (projectId === null) {
        throw new Error(
          `Repository ${repo} has no BB project. Set "Project for investigations" in the plugin settings.`,
        );
      }
      const { prompt, run } = await buildAnalysisPrompt(watched, runId);
      const key = analysisKey(repoKey(watched.ref), runId, run.run_attempt ?? 1);
      const existing = (await analyses())[key];
      if (existing !== undefined) {
        return { threadId: existing, created: false };
      }
      const { analysisModel } = await settings.get();
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        prompt,
        title: `CI failed: ${run.name ?? "workflow"} #${run.run_number} (${run.head_branch ?? repoKey(watched.ref)})`,
        ...(analysisModel.trim() !== "" ? { model: analysisModel.trim() } : {}),
        pluginMetadata: { repo: repoKey(watched.ref), runId, attempt: run.run_attempt ?? 1 },
      });
      await bb.storage.kv.set(ANALYSES_KEY, {
        ...(await analyses()),
        [key]: thread.id,
      });
      void refresh().catch(() => {});
      return { threadId: thread.id, created: true };
    },
  });

  // ---- CLI for agents and terminals ----

  const usage = [
    "Usage:",
    "  bb github-actions list [--active|--failed] [--json]",
    "  bb github-actions rerun <owner/repo> <run-id> [--all]",
    "  bb github-actions cancel <owner/repo> <run-id>",
    "  bb github-actions workflows <owner/repo> [--json]",
    "  bb github-actions run <owner/repo> <workflow-id|file|name> [--ref <branch>] [name=value ...]",
  ].join("\n");
  bb.cli.register({
    name: "github-actions",
    summary: "GitHub Actions runs of the watched repositories",
    commands: [
      {
        name: "list",
        summary: "List recent workflow runs",
        usage: "bb github-actions list [--active|--failed] [--json]",
      },
      {
        name: "rerun",
        summary: "Rerun failed jobs of a run (--all reruns every job)",
        usage: "bb github-actions rerun <owner/repo> <run-id> [--all]",
      },
      {
        name: "cancel",
        summary: "Cancel an active run",
        usage: "bb github-actions cancel <owner/repo> <run-id>",
      },
      {
        name: "workflows",
        summary: "List workflows and their manual-run inputs",
        usage: "bb github-actions workflows <owner/repo> [--json]",
      },
      {
        name: "run",
        summary: "Start a workflow_dispatch run with inputs",
        usage:
          "bb github-actions run <owner/repo> <workflow-id|file|name> [--ref <branch>] [name=value ...]",
      },
    ],
    async run(argv) {
      // `--ref <branch>` takes a value; pull it out before splitting flags.
      let refArg: string | undefined;
      const rest = [...argv];
      const refIndex = rest.indexOf("--ref");
      if (refIndex !== -1) {
        refArg = rest[refIndex + 1];
        rest.splice(refIndex, 2);
      }
      const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
      const [command, ...args] = rest.filter((arg) => !arg.startsWith("--"));
      switch (command) {
        case undefined:
        case "help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const current = await refresh();
          let runs = current.runs;
          if (flags.has("--active")) runs = runs.filter((r) => r.state === "active");
          if (flags.has("--failed")) runs = runs.filter((r) => r.state === "failed");
          runs = runs.slice(0, 100);
          if (flags.has("--json")) {
            return { exitCode: 0, stdout: JSON.stringify(runs) };
          }
          const lines = runs.map(
            (r) =>
              `${r.state.padEnd(7)} ${r.repo} ${r.id} ${r.workflow} #${r.runNumber} [${r.branch ?? "-"}] ${r.conclusion ?? r.status}`,
          );
          const errors = current.repos
            .filter((repo) => repo.error !== null)
            .map((repo) => `! ${repo.repo}: ${repo.error}`);
          return {
            exitCode: 0,
            stdout: [...errors, ...lines].join("\n") || "No runs.",
          };
        }
        case "workflows": {
          const [repo] = args;
          if (repo === undefined) break;
          const watched = await resolveRepo(repo);
          const { defaultBranch, workflows } = await listWorkflows(watched, true);
          const detailed = await Promise.all(
            workflows.map(async (workflow) => ({
              ...workflow,
              inputs: workflow.dispatchable
                ? (await dispatchSpec(watched, workflow.path, defaultBranch)).inputs
                : [],
            })),
          );
          if (flags.has("--json")) {
            return { exitCode: 0, stdout: JSON.stringify({ defaultBranch, workflows: detailed }) };
          }
          const lines = detailed.map((workflow) => {
            const head = `${workflow.id} ${workflow.path} "${workflow.name}" ${
              workflow.dispatchable ? "[manual]" : `[${workflow.state === "active" ? "no workflow_dispatch" : workflow.state}]`
            }`;
            const inputs = workflow.inputs.map(
              (input) =>
                `    ${input.name}: ${input.type}${input.required ? " (required)" : ""}${
                  input.default !== null ? ` = ${input.default}` : ""
                }${input.options.length > 0 ? ` [${input.options.join("|")}]` : ""}`,
            );
            return [head, ...inputs].join("\n");
          });
          return { exitCode: 0, stdout: `default branch: ${defaultBranch}\n${lines.join("\n")}` };
        }
        case "run": {
          const [repo, selector, ...pairs] = args;
          if (repo === undefined || selector === undefined) break;
          const watched = await resolveRepo(repo);
          const { defaultBranch, workflows } = await listWorkflows(watched, true);
          const needle = selector.toLowerCase();
          const workflow = workflows.find(
            (item) =>
              String(item.id) === selector ||
              item.path.toLowerCase().endsWith(`/${needle}`) ||
              item.name.toLowerCase() === needle,
          );
          if (workflow === undefined) {
            return { exitCode: 1, stderr: `No workflow "${selector}" in ${repo}. Run "bb github-actions workflows ${repo}".` };
          }
          const values: Record<string, string> = {};
          for (const pair of pairs) {
            const eq = pair.indexOf("=");
            if (eq <= 0) return { exitCode: 1, stderr: `Expected name=value, got "${pair}"` };
            values[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
          const gitRef = refArg ?? defaultBranch;
          await dispatchWorkflow(watched, workflow.id, gitRef, values);
          return { exitCode: 0, stdout: `Started ${workflow.name} on ${repo}@${gitRef}` };
        }
        case "rerun":
        case "cancel": {
          const [repo, id] = args;
          const runId = Number(id);
          if (repo === undefined || !Number.isInteger(runId) || runId <= 0) break;
          const watched = await resolveRepo(repo);
          if (command === "rerun") {
            await github.rerun(watched.ref, runId, !flags.has("--all"));
          } else {
            await github.cancel(watched.ref, runId);
          }
          void refresh().catch(() => {});
          return { exitCode: 0, stdout: `${command} requested for ${repo} run ${runId}` };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // ---- Poller ----

  bb.background.service("poll-runs", {
    async start(signal) {
      let warmed = false;
      while (!signal.aborted) {
        try {
          await refresh();
          if (!warmed) {
            warmed = true;
            // Prefetch workflow lists so the Run workflow dialog opens fast.
            void watchedRepos().then((repos) =>
              Promise.all([...repos.values()].map((repo) => listWorkflows(repo).catch(() => null))),
            );
          }
        } catch (cause) {
          bb.log.warn(`poll failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        const { pollSeconds } = await settings.get();
        // Poll faster while something is running.
        const hasActive = snapshot.runs.some((run) => run.state === "active");
        const delay = (hasActive ? Math.min(pollSeconds, 15) : pollSeconds) * 1000;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });
}
