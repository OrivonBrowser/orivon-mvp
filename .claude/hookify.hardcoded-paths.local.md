---
name: warn-hardcoded-user-paths
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: ^(?!.*(test|spec|fixture)).*\.(ts|tsx)$
  - field: content
    operator: regex_match
    pattern: XDG_(CONFIG|DATA|CACHE)_HOME|\.config/orivon|\.local/share|os\.homedir\(\)|process\.env\.HOME\b|process\.env\.APPDATA|/home/[a-z]|~/\.
---

**Platform-specific storage path detected (ADR-0003, build-plan.md "Platform policy" #2).**

All persistent storage goes through `app.getPath('userData')` so data lands in the right place
on Linux, Windows and macOS alike. Hardcoded XDG / `$HOME` paths break run-from-source users on
two of the three supported platforms. If this is a deliberate exception, say why in a comment.
