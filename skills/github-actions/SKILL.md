---
name: github-actions
description: List, start, rerun, or cancel GitHub Actions runs of the repositories the GitHub Actions plugin watches, with the `bb github-actions` CLI. Use when the user asks about CI/CD status, a failing pipeline, or to restart a workflow run.
---

# GitHub Actions

The GitHub Actions plugin watches the GitHub repositories of the BB projects
(their git remote) plus any repositories listed in its settings. The same data
backs the GitHub Actions page in the BB sidebar and the thread side-panel tab.

## Commands

| Command | Effect |
| --- | --- |
| `bb github-actions list` | Recent runs of every watched repo: state, repo, run id, workflow, branch, result. |
| `bb github-actions list --active` | Only queued or running runs. |
| `bb github-actions list --failed` | Only failed runs. |
| `bb github-actions rerun <owner/repo> <run-id>` | Rerun the failed jobs of a run. Add `--all` to rerun every job. |
| `bb github-actions cancel <owner/repo> <run-id>` | Cancel a running run. |
| `bb github-actions workflows <owner/repo>` | List workflows, mark the ones that can run manually, and show their inputs. |
| `bb github-actions run <owner/repo> <workflow> [--ref <branch>] [name=value ...]` | Start a `workflow_dispatch` run. `<workflow>` is the id, file name, or name from `workflows`. |

Add `--json` to `list` when the output drives code.

## Investigating a failure

1. Find the run with `bb github-actions list --failed`.
2. Read the failing log with `gh run view <run-id> --repo <owner/repo> --log-failed`.
3. Explain the root cause before you change code.

## Starting a workflow

1. Run `bb github-actions workflows <owner/repo>` and pick a workflow marked `[manual]`.
2. Pass each input as `name=value`; choice inputs accept only the listed options,
   booleans take `true` or `false`. Omitted inputs use their defaults.
3. Add `--ref <branch>` to run on a branch other than the default.

## Rules

- Start, rerun, or cancel a run only when the user asked for it.
- A repository that is not watched is refused; ask the user to add it in
  the plugin settings (`bb plugin config github-actions`).
