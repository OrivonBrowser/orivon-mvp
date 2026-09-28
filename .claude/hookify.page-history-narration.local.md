---
name: warn-page-narrates-its-history
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: ^(?:.*/)?(?:README\.md|ARCHITECTURE\.md|CONTRIBUTING\.md|SECURITY\.md|docs/(?:glossary|inventory|scope)\.md|docs/architecture/[^/]+\.md|docs/development/(?:code-guidelines|packaging|parallel-work|pr-blueprint|release-checklist|security-review-briefing|setup|testing)\.md|docs/planning/(?:build-plan|compatibility-matrix)\.md|\.claude/skills/orivon-(?:comments|electron|workflow)/.+)$
  - field: content
    operator: regex_match
    pattern: (?i)(what changed since|since the last (derivation|pass|run)|\b(this|that|the last|an earlier) (lane|pass)\b|\bthis run's\b|\b(corrected|rewritten|added|landed|resolved|fixed|decided|approved)( on)? 20\d\d-\d\d-\d\d|\b(an?|the) (earlier|first|previous|original|old) (version|revision|draft) of this\b|\bused to (say|read|list|claim|name)\b|owner'?s (decision|verdict)|~~[^~\n]+~~|\bmoved here from\b|\bPR #?\d{2,4}\b|\(#\d{2,4}\)|\b[dD]-\d{4}\b)
---

**This page narrates its own history (CLAUDE.md Rule 2).**

A page states how Orivon works now. "What changed since", "corrected <date>", "the first version
of this did", "used to say", "this lane", PR numbers, decision IDs and struck-through rows go
stale the day they are written. Git, `CHANGELOG.md` and `docs/decisions/decision-log.md` hold
how the page got here.

Write the current state. If the old text was wrong, replace it; do not annotate it. State a
rejected alternative as a reason ("gating on X would race"), not as an episode. A change worth
recording is a decision-log row or a `CHANGELOG.md` entry.

Change records (`CHANGELOG.md`, `docs/decisions/`, `open-questions.md`, the logs, `devlog/`, and
`docs/planning/` apart from two pages) are outside this rule's file list. A quoted example is a
legitimate hit.
