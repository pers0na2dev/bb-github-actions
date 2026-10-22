// bb-plugin-github-actions — the GitHub Actions page in the BB sidebar and the
// matching tab in a thread's side panel.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  DispatchInput,
  Job,
  Run,
  Snapshot,
  Step,
  ThreadSummary,
  WorkflowSummary,
  rpcContract,
} from "./server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Filter = "active" | "failed" | "all";

const FAILED = ["failure", "timed_out", "startup_failure", "action_required"];
const LOG_POLL_MS = 3000;
const LAST_TARGETS_KEY = "bb-plugin-github-actions:last-targets";
const DEFAULT_FAILURE_NOTE =
  "This CI/CD run failed. Please find the cause and how to fix it.";

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

// ---------------------------------------------------------------------------
// Formatting

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatAgo(iso: string, now: number): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  in_progress: "In progress",
  waiting: "Waiting",
  pending: "Pending",
  requested: "Requested",
  failure: "Failed",
  timed_out: "Timed out",
  startup_failure: "Startup failure",
  action_required: "Action required",
  success: "Success",
  cancelled: "Cancelled",
  skipped: "Skipped",
  neutral: "Neutral",
  stale: "Stale",
  completed: "Completed",
};
const statusLabel = (value: string) => STATUS_LABELS[value] ?? value;

const EVENT_ICONS: Record<string, string> = {
  push: "ArrowUp",
  pull_request: "GitPullRequest",
  pull_request_target: "GitPullRequest",
  workflow_dispatch: "Play",
  schedule: "Clock",
  release: "Archive",
  workflow_run: "Workflow",
  merge_group: "GitMerge",
};

const EVENT_LABELS: Record<string, string> = {
  push: "push",
  pull_request: "pull request",
  workflow_dispatch: "manual",
  schedule: "schedule",
  release: "release",
  workflow_run: "workflow run",
};

// ---------------------------------------------------------------------------
// Status visuals

type Tone = "running" | "queued" | "failed" | "success" | "muted";

function toneOf(status: string, conclusion: string | null): Tone {
  if (status === "in_progress") return "running";
  if (["queued", "waiting", "pending", "requested"].includes(status)) {
    return "queued";
  }
  if (conclusion === "success") return "success";
  if (conclusion !== null && FAILED.includes(conclusion)) return "failed";
  return "muted";
}

const TONE_ICON: Record<Tone, string> = {
  running: "Play",
  queued: "Clock",
  failed: "CircleX",
  success: "CircleCheck",
  muted: "Minus",
};
const TONE_TEXT: Record<Tone, string> = {
  running: "text-amber-500",
  queued: "text-muted-foreground",
  failed: "text-destructive",
  success: "text-emerald-500",
  muted: "text-muted-foreground",
};
const TONE_BAR: Record<Tone, string> = {
  running: "bg-amber-500",
  queued: "bg-muted-foreground/40",
  failed: "bg-destructive",
  success: "bg-emerald-500",
  muted: "bg-border",
};

function StatusIcon({
  status,
  conclusion,
  className,
}: {
  status: string;
  conclusion: string | null;
  className?: string;
}) {
  const tone = toneOf(status, conclusion);
  if (tone === "running") {
    return (
      <span
        role="img"
        aria-label={statusLabel(status)}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-amber-500",
          className,
        )}
      >
        <span className="size-[40%] rounded-full bg-amber-500" />
      </span>
    );
  }
  return (
    <Icon
      name={TONE_ICON[tone]}
      aria-label={statusLabel(conclusion ?? status)}
      className={cn("shrink-0", TONE_TEXT[tone], className)}
    />
  );
}

function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2", className)}>
      <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
    </span>
  );
}

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function EmptyState({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon name={icon} className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {children ? (
        <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}

function NativeSelect({
  value,
  onChange,
  children,
  className,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  id?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </select>
      <Icon
        name="ChevronDown"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data hooks

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      rpc
        .call("runs_list", { refresh })
        .then(
          (next) => {
            setSnapshot(next);
            setError(null);
          },
          (cause) => setError(errorText(cause)),
        )
        .finally(() => setLoading(false));
    },
    [rpc],
  );
  useEffect(() => load(false), [load]);
  // The server poller publishes whenever the set of runs changes.
  useRealtime("runs-changed", () => load(false));
  return { rpc, snapshot, error, setError, loading, load };
}

/** Re-renders once a second while `enabled`, for live durations. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

// ---------------------------------------------------------------------------
// Live job log

interface JobLog {
  status: string;
  conclusion: string | null;
  steps: Step[];
  log: string | null;
  truncated: boolean;
}

function lineTone(line: string): string | undefined {
  if (/^##\[error\]/.test(line) || /\berror\b|\bFAIL(ED)?\b/i.test(line)) {
    return "text-red-400";
  }
  if (/^##\[warning\]/.test(line) || /\bwarn(ing)?\b/i.test(line)) {
    return "text-amber-300";
  }
  if (/^##\[group\]/.test(line)) return "text-sky-300 font-semibold";
  if (/^\[command\]/.test(line)) return "text-zinc-400";
  return undefined;
}

/**
 * Step progress refreshes every few seconds while the job runs; the log
 * follows once GitHub publishes it (only after the job ends).
 */
function LogViewer({ repo, job }: { repo: string; job: Job }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<JobLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed job opens on its error rather than on the cleanup at the end.
  const failedJob = job.conclusion !== null && FAILED.includes(job.conclusion);
  const [follow, setFollow] = useState(!failedJob);
  const jumped = useRef(false);
  const [query, setQuery] = useState("");
  const [stepsOpen, setStepsOpen] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const live = data === null || !(data.status === "completed" && data.log !== null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      rpc.call("job_log", { repo, jobId: job.id }).then(
        (next) => {
          if (cancelled) return;
          setData(next);
          setError(null);
          if (!(next.status === "completed" && next.log !== null)) {
            timer = setTimeout(tick, LOG_POLL_MS);
          }
        },
        (cause) => {
          if (cancelled) return;
          setError(errorText(cause));
          timer = setTimeout(tick, LOG_POLL_MS * 3);
        },
      );
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [rpc, repo, job.id]);

  const lines = useMemo(() => {
    if (data?.log == null) return null;
    const all = data.log.split("\n").map((text, index) => ({ text, n: index + 1 }));
    while (all.length > 0 && all[all.length - 1]!.text === "") all.pop();
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? all
      : all.filter((line) => line.text.toLowerCase().includes(needle));
  }, [data?.log, query]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null || lines === null) return;
    if (follow) {
      node.scrollTop = node.scrollHeight;
      return;
    }
    if (!failedJob || jumped.current || query !== "") return;
    jumped.current = true;
    const errorLine = [...lines].reverse().find((line) => line.text.startsWith("##[error]"));
    const target =
      errorLine === undefined
        ? null
        : node.querySelector<HTMLElement>(`[data-line="${errorLine.n}"]`);
    // Leave the lines that led to the error in view above it.
    node.scrollTop =
      target === null ? node.scrollHeight : target.offsetTop - node.clientHeight * 0.75;
  }, [lines, follow, failedJob, query]);

  // A completed log is long; the steps list is noise once it is there.
  useEffect(() => {
    if (data?.log != null) setStepsOpen(false);
  }, [data?.log]);

  if (data === null) {
    return error !== null ? (
      <p className="px-1 py-2 text-xs text-destructive">{error}</p>
    ) : (
      <div className="space-y-2 py-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const now = Date.now();
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setStepsOpen((open) => !open)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Icon
          name="ChevronRight"
          className={cn("size-3.5 transition-transform", stepsOpen && "rotate-90")}
        />
        Steps
        <span className="font-normal">
          {data.steps.filter((step) => step.status === "completed").length}/
          {data.steps.length}
        </span>
      </button>
      {stepsOpen ? (
        <ol className="space-y-px rounded-lg border border-border bg-card p-1">
          {data.steps.map((step) => {
            const end = step.completedAt ?? (step.startedAt !== null ? new Date(now).toISOString() : null);
            return (
              <li
                key={step.number}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-xs",
                  step.status === "in_progress" && "bg-amber-500/10",
                  step.conclusion !== null && FAILED.includes(step.conclusion) && "bg-destructive/10",
                )}
              >
                <StatusIcon status={step.status} conclusion={step.conclusion} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{step.name}</span>
                {step.startedAt !== null && end !== null ? (
                  <span className="tabular-nums text-muted-foreground">
                    {formatDuration(Date.parse(end) - Date.parse(step.startedAt))}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-2 py-1.5">
          {live ? <LiveDot className="ml-1" /> : <Icon name="Terminal" className="ml-1 size-3.5 text-zinc-500" />}
          <span className="truncate text-xs text-zinc-400">{job.name}</span>
          <div className="ml-auto flex items-center gap-1">
            {lines !== null ? (
              <>
                <div className="relative">
                  <Icon name="Search" className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter"
                    aria-label="Filter log lines"
                    className="h-6 w-32 rounded border border-zinc-800 bg-zinc-900 pl-6 pr-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
                  />
                </div>
                <Hint label={follow ? "Stop following" : "Follow the end"}>
                  <button
                    type="button"
                    aria-pressed={follow}
                    onClick={() => setFollow((value) => !value)}
                    className={cn(
                      "flex size-6 items-center justify-center rounded hover:bg-zinc-800",
                      follow ? "text-zinc-100" : "text-zinc-500",
                    )}
                  >
                    <Icon name="ChevronsDown" className="size-3.5" />
                  </button>
                </Hint>
                <Hint label="Copy log">
                  <button
                    type="button"
                    onClick={() => void experimental_copyToClipboard({ text: data.log ?? "" })}
                    className="flex size-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <Icon name="Copy" className="size-3.5" />
                  </button>
                </Hint>
              </>
            ) : null}
            {job.url !== null ? (
              <Hint label="Open job on GitHub">
                <UrlLink
                  href={job.url}
                  className="flex size-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <Icon name="ExternalLink" className="size-3.5" />
                </UrlLink>
              </Hint>
            ) : null}
          </div>
        </div>
        {lines === null ? (
          <div className="flex items-center gap-2 px-3 py-6 text-xs text-zinc-400">
            <Icon name="Clock" className="size-3.5" />
            {data.status === "completed"
              ? "GitHub is preparing the log…"
              : "The job is running. GitHub publishes the full log when the job ends; step progress above updates every 3 seconds."}
          </div>
        ) : (
          <div
            ref={scroller}
            className="relative max-h-[28rem] overflow-auto py-1 font-mono text-[11px] leading-[1.15rem]"
          >
            {data.truncated ? (
              <div className="px-3 pb-1 text-zinc-500">… earlier lines omitted</div>
            ) : null}
            {lines.length === 0 ? (
              <div className="px-3 py-2 text-zinc-500">No matching lines.</div>
            ) : (
              lines.map((line) => (
                <div key={line.n} data-line={line.n} className="flex hover:bg-zinc-900">
                  <span className="w-12 shrink-0 select-none pr-3 text-right tabular-nums text-zinc-600">
                    {line.n}
                  </span>
                  <span className={cn("min-w-0 whitespace-pre-wrap break-all pr-3", lineTone(line.text))}>
                    {line.text.replace(/^##\[(group|endgroup|error|warning|notice|debug)\]/, "")}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function JobsPanel({ run }: { run: Run }) {
  const rpc = useRpc<typeof rpcContract>();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("run_jobs", { repo: run.repo, runId: run.id }).then(
      (result) => {
        if (cancelled) return;
        setJobs(result.jobs);
        // Start on the first failed job, else the running one, else the first.
        setSelected(
          (current) =>
            current ??
            result.jobs.find((job) => job.conclusion !== null && FAILED.includes(job.conclusion))?.id ??
            result.jobs.find((job) => job.status === "in_progress")?.id ??
            result.jobs[0]?.id ??
            null,
        );
      },
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, run.repo, run.id, run.updatedAt]);

  if (error !== null) return <p className="text-xs text-destructive">{error}</p>;
  if (jobs === null) {
    return (
      <div className="flex gap-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-7 w-32" />
      </div>
    );
  }
  if (jobs.length === 0) {
    return <p className="text-xs text-muted-foreground">No jobs yet.</p>;
  }
  const job = jobs.find((item) => item.id === selected) ?? null;
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Jobs" className="flex flex-wrap gap-1.5">
        {jobs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === selected}
            onClick={() => setSelected(item.id)}
            className={cn(
              "flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              item.id === selected
                ? "border-foreground/30 bg-state-active text-foreground"
                : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
          >
            <StatusIcon status={item.status} conclusion={item.conclusion} className="size-3.5" />
            <span className="truncate">{item.name}</span>
          </button>
        ))}
      </div>
      {job !== null && job.failedSteps.length > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <Icon name="AlertTriangle" className="size-3.5" />
          Failed at: {job.failedSteps.join(", ")}
        </p>
      ) : null}
      {job !== null ? <LogViewer key={job.id} repo={run.repo} job={job} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Send to threads

function readLastTargets(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_TARGETS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const THREAD_STATUS_DOT: Record<string, string> = {
  active: "bg-amber-500",
  starting: "bg-amber-500",
  error: "bg-destructive",
  pending: "bg-sky-500",
};

function SendDialog({
  run,
  open,
  onOpenChange,
  currentThreadId,
}: {
  run: Run;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentThreadId: string | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [subscribe, setSubscribe] = useState(false);
  const [initialSubs, setInitialSubs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setQuery("");
    setNote(run.state === "failed" ? DEFAULT_FAILURE_NOTE : "");
    setThreads(null);
    rpc.call("threads_list").then(
      (result) => setThreads(result.threads),
      (cause) => setMessage(errorText(cause)),
    );
    rpc.call("subscriptions_get", { repo: run.repo }).then(
      (result) => {
        setInitialSubs(result.threadIds);
        setSubscribe(result.threadIds.length > 0);
        const preset = currentThreadId !== null ? [currentThreadId] : readLastTargets();
        setSelected(result.threadIds.length > 0 ? result.threadIds : preset);
      },
      (cause) => setMessage(errorText(cause)),
    );
  }, [open, rpc, run.repo, run.state, currentThreadId]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = (threads ?? []).filter(
      (thread) =>
        needle === "" ||
        thread.title.toLowerCase().includes(needle) ||
        thread.projectName.toLowerCase().includes(needle),
    );
    // Selected threads float up so the choice stays visible while searching.
    return list.sort(
      (a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)),
    );
    // Ordering on open only: re-sorting on every click makes rows jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, query]);

  const toggle = (id: string, on: boolean) =>
    setSelected((current) =>
      on ? [...new Set([...current, id])] : current.filter((value) => value !== id),
    );

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await rpc.call("run_send", {
        repo: run.repo,
        runId: run.id,
        threadIds: selected,
        note,
        includeLogs,
      });
      if (subscribe || initialSubs.length > 0) {
        await rpc.call("subscriptions_set", {
          repo: run.repo,
          threadIds: subscribe ? selected : [],
        });
      }
      localStorage.setItem(LAST_TARGETS_KEY, JSON.stringify(selected));
      if (result.failed.length === 0) onOpenChange(false);
      else {
        setMessage(
          `Sent to ${result.sent.length}. Failed: ${result.failed.map((item) => item.error).join("; ")}`,
        );
      }
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to threads</DialogTitle>
          <DialogDescription>
            {run.workflow} #{run.runNumber} · {run.repo}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="relative">
              <Icon name="Search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search threads or projects"
                aria-label="Search threads"
                className="pl-9"
              />
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
              {threads === null ? (
                <div className="space-y-2 p-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : visible.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">No threads found.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {visible.slice(0, 100).map((thread) => (
                    <li key={thread.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-state-hover">
                        <Checkbox
                          checked={selected.includes(thread.id)}
                          onCheckedChange={(checked) => toggle(thread.id, checked === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate">{thread.title}</span>
                            {thread.id === currentThreadId ? (
                              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                                This thread
                              </Badge>
                            ) : null}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                THREAD_STATUS_DOT[thread.status] ?? "bg-muted-foreground/40",
                              )}
                            />
                            {thread.projectName}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add a message (optional)"
            aria-label="Message"
            rows={3}
            className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="space-y-2.5">
            <label className="flex items-center gap-2.5 text-sm">
              <Checkbox checked={includeLogs} onCheckedChange={(checked) => setIncludeLogs(checked === true)} />
              Include log excerpts of failed jobs
            </label>
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox className="mt-0.5" checked={subscribe} onCheckedChange={(checked) => setSubscribe(checked === true)} />
              <span>
                Send new failures of <span className="font-mono text-xs">{run.repo}</span> here automatically
              </span>
            </label>
          </div>
          {message !== null ? (
            <p role="alert" className="text-sm text-destructive">{message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || selected.length === 0} onClick={submit}>
            <Icon name={"Sent"} className="size-4" />
            {busy ? "Sending…" : selected.length > 1 ? `Send to ${selected.length} threads` : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Run workflow (workflow_dispatch)

interface RunTarget {
  repo: string;
  workflowId?: number;
  ref?: string;
}

function InputField({
  input,
  value,
  environments,
  onChange,
}: {
  input: DispatchInput;
  value: string;
  environments: string[];
  onChange: (value: string) => void;
}) {
  const id = `input-${input.name}`;
  const label = (
    <label htmlFor={id} className="text-sm font-medium">
      {input.name}
      {input.required ? <span className="ml-0.5 text-destructive">*</span> : null}
    </label>
  );
  const help = input.description ? (
    <p className="text-xs text-muted-foreground">{input.description}</p>
  ) : null;

  if (input.type === "boolean") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-border p-3">
        <Checkbox
          id={id}
          className="mt-0.5"
          checked={value === "true"}
          onCheckedChange={(checked) => onChange(checked === true ? "true" : "false")}
        />
        <div className="space-y-0.5">
          {label}
          {help}
        </div>
      </div>
    );
  }
  const options =
    input.type === "choice" ? input.options : input.type === "environment" ? environments : null;
  return (
    <div className="space-y-1.5">
      {label}
      {options !== null && options.length > 0 ? (
        <NativeSelect id={id} value={value} onChange={onChange}>
          {!input.required || value === "" ? <option value="">—</option> : null}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          id={id}
          type={input.type === "number" ? "number" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={input.default ?? ""}
        />
      )}
      {help}
    </div>
  );
}

function RunWorkflowDialog({
  open,
  onOpenChange,
  repos,
  initial,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: string[];
  initial: RunTarget | null;
  onStarted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [repo, setRepo] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [defaultBranch, setDefaultBranch] = useState("");
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const [ref, setRef] = useState("");
  const [form, setForm] = useState<{
    branches: string[];
    environments: string[];
    dispatchable: boolean;
    inputs: DispatchInput[];
  } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the requested target when the dialog opens. `repos` is a fresh
  // array every render, so read it through a ref instead of depending on it.
  const latest = useRef({ initial, repos });
  latest.current = { initial, repos };
  useEffect(() => {
    if (!open) return;
    const { initial: target, repos: names } = latest.current;
    setRepo(target?.repo ?? names[0] ?? "");
    setWorkflowId(target?.workflowId ?? null);
    setRef(target?.ref ?? "");
    setForm(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open || repo === "") return;
    let cancelled = false;
    setWorkflows(null);
    rpc.call("workflows_list", { repo }).then(
      (result) => {
        if (cancelled) return;
        setWorkflows(result.workflows);
        setDefaultBranch(result.defaultBranch);
        setRef((current) => current || result.defaultBranch);
        setWorkflowId(
          (current) =>
            (current !== null && result.workflows.some((w) => w.id === current) ? current : null) ??
            result.workflows.find((w) => w.dispatchable)?.id ??
            null,
        );
      },
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [open, repo, rpc]);

  useEffect(() => {
    if (!open || workflowId === null || ref === "") return;
    let cancelled = false;
    setForm(null);
    rpc.call("workflow_form", { repo, workflowId, ref }).then(
      (result) => {
        if (cancelled) return;
        setForm(result);
        setValues(
          Object.fromEntries(
            result.inputs.map((input) => [
              input.name,
              input.default ?? (input.type === "boolean" ? "false" : input.type === "choice" ? (input.options[0] ?? "") : ""),
            ]),
          ),
        );
      },
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [open, repo, workflowId, ref, rpc]);

  const workflow = workflows?.find((item) => item.id === workflowId) ?? null;
  const missing =
    form?.inputs.filter((input) => input.required && (values[input.name] ?? "") === "") ?? [];
  const canRun = form !== null && form.dispatchable && missing.length === 0 && !busy;

  const submit = async () => {
    if (workflowId === null) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("workflow_dispatch", { repo, workflowId, ref, inputs: values });
      onOpenChange(false);
      onStarted();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const branches = form?.branches ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run workflow</DialogTitle>
          <DialogDescription>
            Start a workflow with <code className="text-xs">workflow_dispatch</code> on any branch.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {repos.length > 1 ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="run-repo">Repository</label>
              <NativeSelect
                id="run-repo"
                value={repo}
                onChange={(next) => {
                  setRepo(next);
                  setWorkflowId(null);
                  setRef("");
                }}
              >
                {repos.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </NativeSelect>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <span className="text-sm font-medium">Workflow</span>
            {workflows === null ? (
              <div className="space-y-2">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">This repository has no workflows.</p>
            ) : (
              <div role="radiogroup" className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                {workflows.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={item.id === workflowId}
                    onClick={() => setWorkflowId(item.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                      item.id === workflowId ? "bg-state-active" : "hover:bg-state-hover",
                      !item.dispatchable && "opacity-60",
                    )}
                  >
                    <Icon
                      name={item.dispatchable ? "Play" : "Lock"}
                      className={cn("size-4 shrink-0", item.dispatchable ? "text-foreground" : "text-muted-foreground")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{item.name}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {item.path.replace(".github/workflows/", "")}
                      </span>
                    </span>
                    {!item.dispatchable ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {item.state === "active" ? "No manual trigger" : statusLabel(item.state)}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          {workflow !== null ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="run-ref">Branch</label>
              <NativeSelect id="run-ref" value={ref} onChange={setRef}>
                {[...new Set([ref, defaultBranch, ...branches])]
                  .filter((name) => name !== "")
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                      {name === defaultBranch ? " (default)" : ""}
                    </option>
                  ))}
              </NativeSelect>
            </div>
          ) : null}

          {workflow !== null && form === null ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : null}
          {form !== null && !form.dispatchable ? (
            <div className="flex gap-2.5 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <Icon name="Info" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-muted-foreground">
                This workflow has no <code className="text-xs">workflow_dispatch</code> trigger on{" "}
                <span className="font-mono text-xs">{ref}</span>, so GitHub does not allow starting it manually.
                You can still rerun one of its past runs.
              </p>
            </div>
          ) : null}
          {form !== null && form.dispatchable && form.inputs.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Inputs</p>
              {form.inputs.map((input) => (
                <InputField
                  key={input.name}
                  input={input}
                  value={values[input.name] ?? ""}
                  environments={form.environments}
                  onChange={(value) => setValues((current) => ({ ...current, [input.name]: value }))}
                />
              ))}
            </div>
          ) : null}
          {error !== null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canRun} onClick={submit}>
            <Icon name={"Play"} className="size-4" />
            {busy ? "Starting…" : "Run workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Run row

function RunRow({
  run,
  now,
  rpc,
  currentThreadId,
  onError,
  onChanged,
  onRunAgain,
}: {
  run: Run;
  now: number;
  rpc: Rpc;
  currentThreadId: string | null;
  onError: (message: string) => void;
  onChanged: () => void;
  onRunAgain: (target: RunTarget) => void;
}) {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sentHere, setSentHere] = useState(false);

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await action();
      onChanged();
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const ref = { repo: run.repo, runId: run.id };
  const tone = toneOf(run.status, run.conclusion);
  const started = run.startedAt ?? run.createdAt;
  const duration =
    run.state === "active" ? now - Date.parse(started) : Date.parse(run.updatedAt) - Date.parse(started);

  const analyze = () =>
    act("analyze", async () => {
      const { threadId } = await rpc.call("run_analyze", ref);
      navigate.toThread(threadId);
    });
  const compose = () =>
    act("compose", async () => {
      const { prompt, projectId } = await rpc.call("run_analysis_prompt", ref);
      navigate.toCompose({
        initialPrompt: prompt,
        focusPrompt: true,
        ...(projectId !== null ? { projectId } : {}),
      });
    });
  const sendHere = () =>
    act("send-here", async () => {
      if (currentThreadId === null) return;
      const result = await rpc.call("run_send", {
        ...ref,
        threadIds: [currentThreadId],
        note: run.state === "failed" ? DEFAULT_FAILURE_NOTE : "",
        includeLogs: true,
      });
      if (result.failed.length > 0) throw new Error(result.failed[0]!.error);
      setSentHere(true);
      setTimeout(() => setSentHere(false), 2500);
    });

  return (
    <li className="group relative">
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", TONE_BAR[tone])} aria-hidden />
      <div className="flex items-start gap-3 py-3 pl-4 pr-3">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? "Hide jobs" : "Show jobs"}
          className="mt-0.5 flex size-5 items-center justify-center"
        >
          <StatusIcon status={run.status} conclusion={run.conclusion} className="size-[18px]" />
        </button>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="block w-full min-w-0 text-left"
          >
            <span className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium">{run.workflow}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                #{run.runNumber}
                {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-sm text-muted-foreground">{run.title}</span>
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Icon name="FolderGit" className="size-3" />
              {run.repo}
            </span>
            {run.branch !== null ? (
              <span className="flex max-w-48 items-center gap-1">
                <Icon name="GitBranch" className="size-3 shrink-0" />
                <span className="truncate font-mono">{run.branch}</span>
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              <Icon name={EVENT_ICONS[run.event] ?? "Workflow"} className="size-3" />
              {EVENT_LABELS[run.event] ?? run.event}
            </span>
            {run.actor !== null ? (
              <span className="flex items-center gap-1">
                <Icon name="UserRound" className="size-3" />
                {run.actor}
              </span>
            ) : null}
            <span className="flex items-center gap-1 tabular-nums">
              <Icon name="Clock" className="size-3" />
              {formatDuration(duration)}
            </span>
            <span>{formatAgo(run.createdAt, now)}</span>
          </div>

          {run.state === "failed" || run.state === "active" || currentThreadId !== null ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {run.state === "active" ? (
                <Button size="sm" variant="outline" className="h-7" disabled={busy !== null} onClick={() => act("cancel", () => rpc.call("run_cancel", ref))}>
                  <Icon name="X" className="size-3.5" />
                  {busy === "cancel" ? "Cancelling…" : "Cancel run"}
                </Button>
              ) : null}
              {run.state === "failed" ? (
                <>
                  {run.analysisThreadId !== null ? (
                    <Button size="sm" className="h-7" onClick={() => navigate.toThread(run.analysisThreadId!)}>
                      <Icon name="MessageSquare" className="size-3.5" />
                      Open investigation
                    </Button>
                  ) : (
                    <Button size="sm" className="h-7" disabled={busy !== null} onClick={analyze}>
                      <Icon name={"Bot"} className="size-3.5" />
                      {busy === "analyze" ? "Collecting logs…" : "Ask agent"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={busy !== null}
                    onClick={() => act("rerun", () => rpc.call("run_rerun", { ...ref, failedOnly: true }))}
                  >
                    <Icon name={"RotateCcw"} className="size-3.5" />
                    {busy === "rerun" ? "Starting…" : "Rerun failed jobs"}
                  </Button>
                </>
              ) : null}
              {currentThreadId !== null ? (
                <Button size="sm" variant="outline" className="h-7" disabled={busy !== null} onClick={sendHere}>
                  <Icon
                    name={sentHere ? "Check" : "CornerDownLeft"}
                    className={cn("size-3.5", sentHere && "text-emerald-500")}
                  />
                  {sentHere ? "Sent" : "Send to this thread"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Hint label="Open on GitHub">
            <UrlLink
              href={run.url}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Icon name="ExternalLink" className="size-4" />
            </UrlLink>
          </Hint>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="More actions">
                <Icon name="MoreHorizontal" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => setSendOpen(true)}>
                <Icon name="Sent" className="size-4" />
                Send to threads…
              </DropdownMenuItem>
              {run.state === "failed" ? (
                <DropdownMenuItem onSelect={() => void compose()}>
                  <Icon name="Edit" className="size-4" />
                  Ask agent with another model…
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              {run.state !== "active" ? (
                <DropdownMenuItem
                  onSelect={() => void act("rerun-all", () => rpc.call("run_rerun", { ...ref, failedOnly: false }))}
                >
                  <Icon name="Repeat" className="size-4" />
                  Rerun all jobs
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onSelect={() =>
                  onRunAgain({ repo: run.repo, workflowId: run.workflowId, ...(run.branch !== null ? { ref: run.branch } : {}) })
                }
              >
                <Icon name="Play" className="size-4" />
                Run workflow with inputs…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void experimental_copyToClipboard({ text: run.url })}>
                <Icon name="Link" className="size-4" />
                Copy link
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-border bg-muted/20 py-3 pl-12 pr-3">
          <JobsPanel run={run} />
        </div>
      ) : null}

      <SendDialog run={run} open={sendOpen} onOpenChange={setSendOpen} currentThreadId={currentThreadId} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page

function StatTile({
  label,
  value,
  icon,
  tone,
  active,
  onClick,
  live,
}: {
  label: string;
  value: ReactNode;
  icon: string;
  tone: string;
  active?: boolean;
  onClick?: () => void;
  live?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={onClick === undefined}
      aria-pressed={active}
      className={cn(
        "flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors disabled:cursor-default",
        active ? "border-foreground/30 bg-state-active" : "border-border enabled:hover:bg-state-hover",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name={icon} className={cn("size-3.5", tone)} />
        {label}
        {live ? <LiveDot className="ml-auto" /> : null}
      </span>
      <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
    </button>
  );
}

function ActionsView({ currentThreadId }: { currentThreadId: string | null }) {
  const { rpc, snapshot, error, setError, loading, load } = useSnapshot();
  const [filter, setFilter] = useState<Filter>("active");
  const [repoFilter, setRepoFilter] = useState("");
  const [runTarget, setRunTarget] = useState<RunTarget | null>(null);
  const [runOpen, setRunOpen] = useState(false);

  const runs = snapshot?.runs ?? [];
  const scoped = repoFilter === "" ? runs : runs.filter((run) => run.repo === repoFilter);
  const stats = useMemo(() => {
    const finished = scoped.filter((run) => run.state === "success" || run.state === "failed");
    return {
      running: scoped.filter((run) => run.status === "in_progress").length,
      queued: scoped.filter((run) => run.state === "active" && run.status !== "in_progress").length,
      active: scoped.filter((run) => run.state === "active").length,
      failed: scoped.filter((run) => run.state === "failed").length,
      all: scoped.length,
      successRate:
        finished.length === 0
          ? null
          : Math.round((finished.filter((run) => run.state === "success").length / finished.length) * 100),
    };
  }, [scoped]);
  const visible = filter === "all" ? scoped : scoped.filter((run) => run.state === filter);
  const now = useNow(stats.active > 0);
  const repos = snapshot?.repos ?? [];
  const repoErrors = repos.filter((repo) => repo.error !== null);
  const repoNames = repos.map((repo) => repo.repo);

  const openRun = (target: RunTarget | null) => {
    setRunTarget(target ?? (repoFilter !== "" ? { repo: repoFilter } : null));
    setRunOpen(true);
  };

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: "active", label: "Active", count: stats.active },
    { id: "failed", label: "Failed", count: stats.failed },
    { id: "all", label: "All", count: stats.all },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-4xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 max-w-64">
                  <Icon name="FolderGit" className="size-3.5" />
                  <span className="truncate">{repoFilter === "" ? "All repositories" : repoFilter}</span>
                  <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Repository</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={repoFilter} onValueChange={setRepoFilter}>
                  <DropdownMenuRadioItem value="">All repositories</DropdownMenuRadioItem>
                  {repos.map((repo) => (
                    <DropdownMenuRadioItem key={repo.repo} value={repo.repo}>
                      <span className="truncate">{repo.repo}</span>
                      {repo.error !== null ? <Icon name="AlertTriangle" className="ml-auto size-3.5 text-destructive" /> : null}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto flex items-center gap-2">
              {snapshot?.fetchedAt ? (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  Updated {formatAgo(snapshot.fetchedAt, Date.now())}
                </span>
              ) : null}
              <Hint label="Refresh">
                <Button variant="outline" size="icon" className="size-8" disabled={loading} onClick={() => load(true)} aria-label="Refresh">
                  <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", loading && "opacity-50")} />
                </Button>
              </Hint>
              <Button size="sm" className="h-8" disabled={repos.length === 0} onClick={() => openRun(null)}>
                <Icon name="Play" className="size-3.5" />
                Run workflow
              </Button>
            </div>
          </div>

          {/* Summary */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="Running" value={stats.running} icon="Play" tone="text-amber-500" live={stats.running > 0} onClick={() => setFilter("active")} />
            <StatTile label="Queued" value={stats.queued} icon="Clock" tone="text-muted-foreground" />
            <StatTile label="Failed" value={stats.failed} icon="CircleX" tone="text-destructive" onClick={() => setFilter("failed")} />
            <StatTile
              label="Success rate"
              value={stats.successRate === null ? "—" : `${stats.successRate}%`}
              icon="CircleCheck"
              tone="text-emerald-500"
              onClick={() => setFilter("all")}
            />
          </div>

          {/* Alerts */}
          {snapshot?.authError ? (
            <div role="alert" className="flex gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <Icon name="Lock" className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p>{snapshot.authError}</p>
            </div>
          ) : null}
          {error !== null ? (
            <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1 break-words">{error}</p>
              <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="text-muted-foreground hover:text-foreground">
                <Icon name="X" className="size-4" />
              </button>
            </div>
          ) : null}
          {repoErrors.length > 0 && !snapshot?.authError ? (
            <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
              {repoErrors.map((repo) => (
                <p key={repo.repo} className="flex gap-1.5">
                  <Icon name="AlertTriangle" className="mt-px size-3.5 shrink-0 text-destructive" />
                  <span><span className="font-mono">{repo.repo}</span>: {repo.error}</span>
                </p>
              ))}
            </div>
          ) : null}

          {/* Runs */}
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
              {filters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors",
                    filter === item.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
                  )}
                >
                  {item.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[11px] tabular-nums",
                      item.id === "failed" && item.count > 0 ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {item.count}
                  </span>
                </button>
              ))}
            </div>
            {snapshot === null ? (
              <div className="divide-y divide-border">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="flex gap-3 p-4">
                    <Skeleton className="size-5 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-1/3" />
                      <Skeleton className="h-3.5 w-2/3" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : repos.length === 0 ? (
              <div className="p-4">
                <EmptyState icon="FolderGit" title="No repositories to watch">
                  Add a GitHub remote to a BB project, or list repositories in the plugin settings.
                </EmptyState>
              </div>
            ) : visible.length === 0 ? (
              <div className="p-4">
                {filter === "active" ? (
                  <EmptyState icon="CircleCheck" title="Nothing is running">
                    New runs show up here as soon as GitHub starts them.
                  </EmptyState>
                ) : filter === "failed" ? (
                  <EmptyState icon="CircleCheck" title="No failed runs" />
                ) : (
                  <EmptyState icon="Workflow" title="No runs yet" />
                )}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {visible.map((run) => (
                  <RunRow
                    key={`${run.repo}#${run.id}`}
                    run={run}
                    now={now}
                    rpc={rpc}
                    currentThreadId={currentThreadId}
                    onError={setError}
                    onChanged={() => load(false)}
                    onRunAgain={openRun}
                  />
                ))}
              </ul>
            )}
          </section>

          {repos.length > 0 ? (
            <p className="text-center text-xs text-muted-foreground">
              Watching {repos.length} {repos.length === 1 ? "repository" : "repositories"}
            </p>
          ) : null}
        </div>
      </div>

      <RunWorkflowDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        repos={repoNames}
        initial={runTarget}
        onStarted={() => {
          setFilter("active");
          load(true);
        }}
      />
    </TooltipProvider>
  );
}

function ActionsPage() {
  return <ActionsView currentThreadId={null} />;
}

function ThreadActionsPanel({ threadId }: { threadId: string }) {
  return <ActionsView currentThreadId={threadId} />;
}

export default definePluginApp((app) => {
  // A page of its own in the sidebar…
  app.slots.navPanel({
    id: "actions",
    title: "GitHub Actions",
    icon: "Workflow",
    path: "actions",
    component: ActionsPage,
  });
  // …and a tab beside any thread, whose "Send to this thread" targets it.
  app.slots.threadPanelAction({
    id: "actions",
    title: "GitHub Actions",
    icon: "Workflow",
    component: ThreadActionsPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "GitHub Actions" });
    },
  });
});
