# Agent Guidelines

## General rules

- Keep responses focused, brief, and concise.
- Remove any code comments you come across and only leave the usage for scripts.

## Branching

```bash
git checkout develop && git pull --rebase origin develop
git checkout -b feat/add-certmanager-gcp develop
```

Never push to `develop` — always branch and open a merge request. Branch prefix
is the commit type: `feat`, `fix`, `refactor`, `chore`, `docs`.

## Commit messages

- Message format: conventional commits
- Scope of work: logical commits

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
