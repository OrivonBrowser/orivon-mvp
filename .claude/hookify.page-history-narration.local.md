---
name: warn-page-narrates-its-history
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: ^(?:.*/)?(?:README\.md|ARCHITECTURE\.md|CONTRIBUTING\.md|SECURITY\.md|docs/(?:glossary|inventory|mvp-scope)\.md|docs/architecture/[^/]+\.md|docs/development/(?:code-guidelines|packaging|parallel-work|pr-blueprint|release-checklist|security-review-briefing|setup|testing)\.md|docs/planning/(?:build-plan|compatibility-matrix)\.md)$
  - field: content
    operator: regex_match
    pattern: (?i)(what changed since|since the last (derivation|pass|run)|\b(this|that|the last|an earlier) (lane|pass)\b|\bthis run's\b|\b(corrected|rewritten|added|landed|resolved|fixed|decided|approved)( on)? 20\d\d-\d\d-\d\d|\b(an?|the) (earlier|first|previous|original|old) (version|revision|draft) of this\b|\bused to (say|read|list|claim|name)\b|owner'?s (decision|verdict)|~~[^~\n]+~~|\bmoved here from\b|\bPR #?\d{2,4}\b|\(#\d{2,4}\)|\b[dD]-\d{4}\b)
---

**This page is narrating its own history (CLAUDE.md Rule 2).**

A page states how Orivon works now. "What changed since the last derivation", "corrected
2026-09-15", "the first version of this did...", "used to say", "this lane", PR numbers,
decision IDs, struck-through rows: a newcomer cannot use any of it, and it goes stale the day
it is written. Git, `CHANGELOG.md` and `docs/decisions/decision-log.md` hold how the page got
here.

Write the current state instead. If the old text was wrong, replace it; do not annotate it. If
a rejected alternative explains the design, state it as a reason ("gating on X would race"), not
as an episode. If the change itself is worth recording, it is a decision-log row or a
`CHANGELOG.md` entry.

Change records are outside this rule's file list on purpose: `CHANGELOG.md`, `docs/decisions/`,
`docs/open-questions.md`, `readability-log.md`, `review-coverage.md`, `devlog/`, and every
`docs/planning/` file except `build-plan.md` and `compatibility-matrix.md`. Warn, not block: a
quoted example (like this paragraph's) is a legitimate hit.
