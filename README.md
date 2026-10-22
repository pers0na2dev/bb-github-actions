# GitHub Actions for BB

A [BB](https://getbb.app) plugin that shows the GitHub Actions runs of your projects and lets you act on them without leaving BB.

## Features

- **Runs page and thread tab.** A GitHub Actions page in the sidebar, and the same view as a tab beside any thread (new tab → Actions → GitHub Actions). A summary shows running, queued, and failed runs and the success rate; the list filters by Active / Failed / All and by repository.
- **Run workflow.** Start any workflow that has a `workflow_dispatch` trigger, on any branch. Inputs (string, number, boolean, choice, environment) become a form and are validated before the request reaches GitHub.
- **Live job view.** Step progress refreshes every 3 seconds while a job runs. The log appears once GitHub publishes it (GitHub serves a job log only after the job ends), with line numbers, error highlighting, a filter, and copy.
- **Rerun and cancel.** Rerun failed jobs or the whole run; cancel a run in progress.
- **Ask agent.** Opens a BB thread in the repository's project with the error excerpt of the failed jobs and a brief to find the root cause. "Ask agent with another model…" opens the same prompt in the composer instead.
- **Send to threads.** Post a run report to the BB threads you choose, and subscribe them to future failures of the repository.
- **CLI and skill.** `bb github-actions` for agents and terminals; the bundled skill teaches agents to use it.

## Requirements

- A GitHub account with access to the repositories. The plugin uses the token of the [GitHub CLI](https://cli.github.com) (`gh auth token`), or a token you set in the plugin settings. Rerun, cancel, and manual runs need write access to Actions.
- BB projects whose git remote points at GitHub, or repositories listed in the plugin settings.

## Install

From the BB marketplace, or from source:

```sh
git clone https://github.com/pers0na2dev/bb-github-actions.git
cd bb-github-actions
npm install
bb plugin install .
```

## Settings

`bb plugin config github-actions`, or Settings → Installed plugins → GitHub Actions:

| Setting | Default | |
| --- | --- | --- |
| GitHub token | — | Secret. Falls back to `gh auth token`. |
| Watch the GitHub repositories of BB projects | on | Uses each project's git remote. |
| Extra repositories | — | `owner/repo`, one per line. |
| Recent runs to load per repository | 20 | 1–100. |
| GitHub polling interval, seconds | 30 | 15 s while a run is active. |
| Project for investigations | — | For repositories without a BB project. |
| Model for failure investigations | project default | |

## CLI

```text
bb github-actions list [--active|--failed] [--json]
bb github-actions rerun <owner/repo> <run-id> [--all]
bb github-actions cancel <owner/repo> <run-id>
bb github-actions workflows <owner/repo> [--json]
bb github-actions run <owner/repo> <workflow-id|file|name> [--ref <branch>] [name=value ...]
```

## Development

```sh
npm install
npm run typecheck
npm run build      # bb plugin build
bb plugin dev      # rebuild and reload on save
```

## License

MIT
