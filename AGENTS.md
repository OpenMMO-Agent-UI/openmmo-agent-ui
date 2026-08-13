# Agent Guidelines

## General rules

- Keep responses focused, brief, and concise.
- Comments only when truly necessary, and short. Shorten or delete verbose ones
  you come across.
- Prefer editing existing files. No abstractions or files beyond what the task
  requires.

## Branching

```bash
git checkout develop && git pull --rebase origin develop
git checkout -b feat/add-certmanager-gcp develop
```

Never push to `develop` — always branch and open a merge request. Branch prefix
is the commit type: `feat`, `fix`, `refactor`, `chore`, `docs`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Types:
`feat` `fix` `refactor` `chore` `docs` `ci` `test` `revert`. Scope is optional
but recommended — the chart, module, or subsystem (`cert-manager`, `ansible`,
`k8s`).

```
feat(cert-manager): add GCP DNS01 solver

feat!: drop support for standalone SeaweedFS mode

BREAKING CHANGE: seaweedfs_mode=standalone is no longer supported; all
deployments require HA.
```

## Interactive commands

Never run a command that can block on input. Prefix git reads with
`--no-pager`, pass `-y` / `--non-interactive` where a prompt is possible, and
read or write files with the file tools instead of `less` / `vim`.

## Tests

Prune redundant, obsolete, dead-code-only, brittle, and low-value tests while preserving every supported
behavioral contract: map each deletion to equivalent retained coverage or confirmed dead behavior, keep distinct
boundaries/failures/integration signals, strengthen or consolidate retained tests where needed, remove orphaned
test support, leave production unchanged, run relevant checks, and summarize evidence that confidence is
preserved.
