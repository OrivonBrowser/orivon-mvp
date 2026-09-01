# Working in parallel

How several people — or several agent sessions — work in this repository at the same time
without corrupting each other's work.

If you are working alone and sequentially, you need only §The merge protocol. The rest costs
you nothing.

---

## Why parallelism has to be manufactured

[`build-plan.md`](../planning/build-plan.md) is dependency-ordered:

```
spike -> shell -> broker -> shim -> app loader -> torrent app -> THE CLIP
```

Step 3 cannot begin before step 2 exists. So parallelism here is not *discovered* by finding
independent work — there is very little. It is **manufactured**, by freezing the interfaces in
[`src/contracts/`](../../src/contracts/) so that a stream can build against a **contract and a
stub** instead of against another stream's half-finished code.

That is the entire trick, and it is why the contracts package exists at all. Everything else on
this page is bookkeeping around it.

---

## The ownership map

Each stream owns a disjoint set of paths and **writes nowhere else**. If your change needs a
file another stream owns, that is a signal — either the boundary is wrong (raise it), or the
change belongs in their stream.

| Stream | Owns | Build step | State |
|---|---|---|---|
| `shell` | `src/main/{index,window,tabs,omnibox,ipc}.ts`, `src/renderer/`, `src/preload/shell.ts`, **`scripts/smoke.mjs`**, **`test/`** | 1 | **done**, maintenance only |
| `contracts` | `src/contracts/` | — | **change-controlled**, see below |
| `shared` | `src/shared/` | — | **change-controlled**, same rules as `contracts`. Empty by design; see its `README.md` |
| `broker` | `src/broker/`, `src/broker/policy/`, `src/preload/app.ts` | 2 | critical path |
| `shim` | `src/shim/`, the `renderer.resolve.alias` map in `electron.vite.config.ts` | 3 | |
| `loader` | `src/loader/` | 4 | |
| `torrent-app` | `apps/torrent/` | 5 | ships as a pre-built app asset |
| `fixture-app` | `apps/fixture/` | testing | also app #3 and the dev-mode example |
| `trust` | `src/trust/` | 6 | first to cut if the schedule slips |
| `nostr` | `src/nostr/` | 7 | second to cut |
| `telemetry` | `src/telemetry/` | 8 | independent of the critical path |
| `packaging` | `electron-builder` config, `scripts/` **except `smoke.mjs`** | 10 | independent of everything |
| `docs` | `docs/`, root markdown, **`.github/`**, **`.claude/`** | — | always available |

> **`.claude/` is owned by `docs` for want of a better home, and the fit is imperfect.** It holds
> agent instructions and the project skill — read by tooling, not shipped — so it belongs to no
> build step and has no natural stream. It was unowned until 2026-08-27 — the same oversight
> `.github/` had, found the same week: a path nobody owns is a path two streams edit on the same
> afternoon without either noticing. If a session is editing `.claude/skills/`, say so before
> starting.

Every directory above carries its own `README.md` stating what it depends on and **what it must
never import**. Those are the real boundary; this table is the index.

**Why `scripts/` is split.** `scripts/` holds two unrelated things. The guards
(`check-no-*.mjs`) and the release tooling are packaging's. `smoke.mjs` and `test/` are the
shell's own regression check — they exist to catch shell regressions, they change when the
shell changes, and a packaging change never touches them. Corrected 2026-08-27, after
`stream/backlog-05-smoke-coverage` edited `smoke.mjs` and the table said packaging owned it.

**Why `docs` owns `.github/`.** It was in nobody's column until 2026-08-27, by oversight rather
than design, and two changes had already landed there. Its contents are process and
documentation infrastructure — the pull request template, the issue templates — and `docs` is
the stream that is always available. **`ci.yml` is the awkward exception**: a change to it is far
likelier to come from `packaging`, or from whichever stream adds the check it runs. Treated as a
borrow rather than a split, on the same terms as a `backlog-NN` branch — name it in the PR.

### `backlog-NN` branches

Not every task belongs to a build step. Maintenance and follow-up work runs on
`stream/backlog-NN-<slug>` branches, which own **no paths of their own** — a backlog branch
borrows the paths of whichever stream the work belongs to, and its PR body must name that
stream. If the work would touch two streams' paths, it is two branches.

### Concurrent right now

`broker` · `packaging` · `telemetry` · `docs` — four streams, no path overlap.

---

## Prevention: four rules

### 1. One worktree per stream

Two sessions in two directories physically cannot write the same file.

```bash
git worktree add ../orivon-broker -b stream/broker
cd ../orivon-broker
npm install
```

Branch naming: `stream/<name>`, matching the table above.

When the stream is merged and done:

```bash
git worktree remove ../orivon-broker
```

### 2. Stay inside your owned paths

See the table. This is the rule that makes the others unnecessary most of the time.

### 3. Contracts and shared changes are their own pull request, merged first

A change to `src/contracts/` touches every stream at once, so it is where coordination is
genuinely required.

- A contracts change goes in **its own PR**, with no implementation in it.
- It merges **before** any stream builds on it.
- Other streams then rebase onto `main` and pick it up.

**Never modify `src/contracts/` in the same PR as an implementation.** If you find you need to,
split the PR — the contract change is almost always the more consequential half and deserves to
be reviewed alone.

**[`src/shared/`](../../src/shared/) follows the same three rules**, for the same reason: one
edit there can break every stream that imports it. It holds pure helpers needed on both sides of
a trust boundary — added 2026-08-27, empty by design, and the bar for putting something in it is
in [its `README.md`](../../src/shared/README.md). See
[`code-guidelines.md`](code-guidelines.md) Rule 3 for why it exists.

### 4. Append at the append points; never edit them

Two files exist purely so that streams can register themselves without editing shared logic:

| File | What you append |
|---|---|
| [`src/main/subsystems.ts`](../../src/main/subsystems.ts) | One import, one array entry |
| `electron.vite.config.ts` → `preload.build.rollupOptions.input` | One key |

Git merges appends at different positions of a list cleanly. It cannot merge two edits to the
same conditional. **Do not add logic to `subsystems.ts`** — if a subsystem needs conditional
behaviour, that belongs inside the subsystem.

---

## Repair: for when prevention fails

### `package-lock.json` — regenerate, never hand-merge

**This is the most common parallel-work conflict and the most dangerous.** A hand-merged
lockfile can look entirely correct and install a different dependency tree than either side
intended, and nothing will tell you.

```bash
git checkout --theirs package-lock.json   # or --ours; it does not matter which
npm install                               # regenerates it against package.json
git add package-lock.json
```

**Never resolve it hunk by hunk.** `package.json` is the source of truth; the lockfile is
derived, so derive it again.

### `merge=union` on the append-only files

[`.gitattributes`](../../.gitattributes) sets `merge=union` on `devlog/journal.md` and
`CHANGELOG.md`. Git resolves those automatically by keeping both sides, instead of stopping the
merge.

This is correct **only** where every change is an append and order does not matter. It must
never be extended to source files — union-merging code produces something syntactically valid
and semantically wrong, which is strictly worse than a conflict you can see.

### Open-question numbers — renumber yours, never main's

`open-questions.md` is the one shared file every stream appends to, and its rows are
**numbered**. Four streams branched from the same main, each read "A14 is the highest", and
each filed its finding as A15. On 2026-08-27 that produced three separate claims to A15, three
to A16 and two to A17, across four branches.

**A number allocated on a branch is provisional until that branch merges.** So on a conflict:

- **main's numbers win**, always. They are already merged, and other documents cite them —
  `smoke.mjs` names A16 in an assertion label, `ADR-0010` and `capability-api.md` cite A17.
  Renumbering a merged question silently breaks every one of those.
- **Your branch's questions take the next free numbers**, above everything on main *and* above
  anything claimed by a branch merging ahead of you.
- **Never renumber to fill a gap.** Numbers are permanent identifiers, not an ordering. A4 and
  A10 are already absent because they resolved.

**Renumbering is not a table edit.** Grep the number before you finish — a question is cited
from section headings further down the same file, from source comments, and from other
documents. A renumber that stops at the table leaves code pointing at a stranger's question,
which is worse than the collision, because it looks right. This happened for real:
`origin.ts` cited `open-questions.md A16` for a rule about persisting loopback grants, and by
the time it merged, A16 was "what should closing the last tab do".

Cheapest prevention, if you are about to file one — take the next number above what **main**
has, not above what your branch has:

```bash
git fetch origin
git show origin/main:docs/open-questions.md | grep -oE '^\| A[0-9]+' | sort -V | tail -1
```

### CI is the semantic check

A textual merge can succeed while the result does not compile or does not pass. That is the
class of conflict git cannot see, and CI is what catches it:

| Check | Catches |
|---|---|
| `npm run typecheck` | Two streams' types no longer agree |
| `npm test` | Behaviour regressed |
| `npm run check:natives` | A dependency that needs a compiler (Rule 8) |
| `npm run check:contracts` | `src/contracts/` grew an edge out of the directory |
| `npm run build` | The bundle no longer builds |

With no dedicated code reviewer, **CI is the reviewer** — so a red PR does not merge, ever.

---

## The merge protocol

1. **Branch** from `main`, in a worktree: `stream/<name>`.
2. **Work.** Stay in your paths. Commit often; a small PR is reviewed in seconds and a large one
   is not reviewed at all.
3. **Rebase on `main`** before opening the PR, and run the full gate locally:
   ```bash
   npm run typecheck && npm test && npm run check:natives && npm run check:contracts
   npm run smoke     # only if you touched src/main/
   ```
4. **Open the PR**, titled and described per
   [`pr-blueprint.md`](pr-blueprint.md). GitHub pre-fills the form, so in practice this is
   filling in what is already there. Its `## Stream, paths and merge order` block is the part
   this page cares about — the stream, the paths and whether the PR is independent or stacked on
   another — and **its labels are how you see which streams are open at once**.
5. **CI must be green.**
6. **The owner merges.**

The pull requests are also the public record of the work. Someone arriving in six months reads
them to find out not just what was built, but what was tried and why it is shaped this way.

---

## If you are an agent

Read this page before starting any build step. Then:

- Work in a worktree on `stream/<name>`.
- Stay inside your owned paths.
- Never modify `src/contracts/` in the same PR as an implementation.
- Append at the append points rather than editing shared logic.
- Surface contradictions rather than smoothing them over — append to
  [`open-questions.md`](../open-questions.md) ([`CLAUDE.md`](../../CLAUDE.md) Rule 3).
