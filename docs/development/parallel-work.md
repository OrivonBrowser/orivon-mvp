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
| `broker` | `src/broker/`, `src/broker/policy/`, `src/preload/app.ts` | 2 | critical path |
| `shim` | `src/shim/`, the `renderer.resolve.alias` map in `electron.vite.config.ts` | 3 | |
| `loader` | `src/loader/` | 4 | |
| `torrent-app` | `apps/torrent/` | 5 | ships as a pre-built app asset |
| `fixture-app` | `apps/fixture/` | testing | also app #3 and the dev-mode example |
| `trust` | `src/trust/` | 6 | first to cut if the schedule slips |
| `nostr` | `src/nostr/` | 7 | second to cut |
| `telemetry` | `src/telemetry/` | 8 | independent of the critical path |
| `packaging` | `electron-builder` config, `scripts/` **except `smoke.mjs`** | 10 | independent of everything |
| `docs` | `docs/`, root markdown | — | always available |

Every directory above carries its own `README.md` stating what it depends on and **what it must
never import**. Those are the real boundary; this table is the index.

**Why `scripts/` is split.** `scripts/` holds two unrelated things. The guards
(`check-no-*.mjs`) and the release tooling are packaging's. `smoke.mjs` and `test/` are the
shell's own regression check — they exist to catch shell regressions, they change when the
shell changes, and a packaging change never touches them. Corrected 2026-08-27, after
`stream/backlog-05-smoke-coverage` edited `smoke.mjs` and the table said packaging owned it.

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

### 3. Contracts changes are their own pull request, merged first

A change to `src/contracts/` touches every stream at once, so it is the one place where
coordination is genuinely required.

- A contracts change goes in **its own PR**, with no implementation in it.
- It merges **before** any stream builds on it.
- Other streams then rebase onto `main` and pick it up.

**Never modify `src/contracts/` in the same PR as an implementation.** If you find you need to,
split the PR — the contract change is almost always the more consequential half and deserves to
be reviewed alone.

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
4. **Open the PR**, with a body stating four things:
   - **Goal** — what this is for, in one sentence.
   - **Paths touched** — and confirmation they are yours.
   - **Contracts depended on** — which types from `src/contracts/`, and whether any changed.
   - **How it was verified** — the commands you ran and what they said.
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
