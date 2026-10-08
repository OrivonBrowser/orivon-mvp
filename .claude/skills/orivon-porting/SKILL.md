---
name: "orivon-porting"
description: Use when porting a third-party app (Electron, web or Node server) to run in Orivon, when judging whether an app is portable, when working on anything in the sibling `orivon-ports` checkout, when updating a port to a new upstream release, when the owner reports something broken in a ported app, when rebuilding or republishing ports (IPFS, IPNS, Explore, Web3 Score) after a change here, and when deciding which app-behaviour rows and specs a port needs in this repository. Loads the porting skill that lives in the ports checkout and says what this repository owes a port.
---

# Porting: the skill lives with the ports

The porting skill is kept in the repository it describes, so it changes in the same pull request as
the code it describes. Read it now:

1. `../orivon-ports/.claude/skills/orivon-porting/SKILL.md`, and the file its first table names for
   this job.
2. `../orivon-ports/CLAUDE.md`, whose rules apply to every change made there.

If `../orivon-ports` is missing, ask the owner where it is. Nothing in this repository depends on it.

## What this repository owes a port

- **A gap a port finds is fixed here, generically** (Rule 20): the fix, a row in
  [`test/app-behaviours/catalogue.md`](../../../test/app-behaviours/catalogue.md) and an end-to-end
  spec that names no app, written as
  [`test/app-behaviours/README.md`](../../../test/app-behaviours/README.md) says. The port's README
  then names the row, and the row's Ports column names the port.
- **A change here that alters what an app counts on** carries a line under `### Changed for apps` in
  [`CHANGELOG.md`](../../../CHANGELOG.md) naming the ports to recheck. A change to the Node shim
  reaches a port only when that port is rebuilt, so the ports that bundle it are rebuilt and, when
  published, republished; the porting skill's `maintain.md` says how.
- **A port is driven from a scratch worktree of this repository**, never from the owner's checkout:
  their `npm run dev` watches its `out/`.
