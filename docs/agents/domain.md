# Domain Docs

This repository uses a single-context domain-doc layout.

## Before exploring

- Read the root `CONTEXT.md` when it exists.
- Read ADRs under `docs/adr/` that touch the area being changed.
- Proceed silently when a referenced domain document does not exist.

## Vocabulary

Use the glossary terms defined in `CONTEXT.md` in specifications, issues, tests, and implementation discussions. Avoid synonyms that the glossary explicitly rejects.

When a required concept is absent from the glossary, reconsider whether an existing term already covers it. If the concept is genuinely new, note the domain-model gap rather than silently inventing competing terminology.

## ADRs

Surface any conflict with an existing ADR explicitly. Do not silently override an accepted architectural decision.
