# Repo openness and parallel work — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this repository something a developer can start working in alone without AI, and
make it safe for several Claude Code sessions to work in it at once.

**Architecture:** Three layers, built in dependency order. First a **types-only
`src/contracts/`** transcribed from the two specification documents, guarded by a CI check that
proves it imports nothing — this is what turns the build plan's *sequential* steps into
*concurrent* streams. Then the **parallel-work machinery**: a composition root in
`src/main/` that subsystems append to rather than edit, one directory per stream each carrying
its own boundary README, and a `.gitattributes` that auto-resolves the append-only files. Then
the **human entry path** — README, ARCHITECTURE, CONTRIBUTING, LICENSE and a docs index —
written last, deliberately, because describing a structure that already exists is far more
accurate than describing an intended one. Publishing to GitHub is the final task.

**Tech Stack:** TypeScript 7, Node 24, Electron 44, electron-vite 5, Vitest 4, GitHub Actions.

**Spec:** `docs/planning/repo-and-parallel-work-design.md` — read it before starting. It records
the five owner decisions this plan implements and the reasoning behind each.

## Global Constraints

Every task's requirements implicitly include all of these.

- **TypeScript only.** No Rust, no C++, no new languages (`ADR-0002`). A hookify rule blocks
  non-TypeScript sources.
- **Pure-JS dependencies only.** No dependency may require a compiler at install time
  (`CLAUDE.md` Rule 8). `npm run check:natives` enforces this and runs on `postinstall`.
- **No new runtime dependencies in this plan at all.** Every task below is satisfiable with
  what `package.json` already has. If a task seems to need one, stop and raise it.
- **Docs are Markdown, `kebab-case.md`.** Match the surrounding corpus's prose style.
- **Never launch Electron directly.** `ELECTRON_RUN_AS_NODE=1` is set in this machine's ambient
  shell and makes Electron run as plain Node with no windows, failing silently. Use
  `test/launch-electron.mjs`, and read `.claude/skills/orivon-electron/SKILL.md` first.
- **`src/contracts/` imports nothing.** No `electron`, no `node:*`, no third-party types, not
  even `import type`. Enforced by Task 1's guard.
- **Node `>=22.12.0`** per `package.json` `engines`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Contradictions get surfaced, not smoothed over** (`CLAUDE.md` Rule 3). Transcribing the
  contracts will expose gaps in `capability-api.md` and `handle-contracts.md`. Append them to
  `docs/open-questions.md`; never invent around them.

## Two deviations from the spec, decided while planning

Recorded here rather than applied silently.

1. **`electron.vite.config.ts` is not restructured.** The spec named it a composition root
   alongside `src/main/index.ts`. On inspection its two extension points are already
   one-line-per-entry records (`preload.build.rollupOptions.input`, `renderer.resolve.alias`),
   and only one stream (`shim`) will ever touch the alias map. Restructuring buys nothing.
   Task 4 adds a comment block naming which stream owns which extension point instead.
2. **`docs/development/release-checklist.md` covers only what is decidable today.** The spec
   called for closing this gap. Three of its items (the pinned MP4 torrent, the three pinned
   Nostr clients) depend on artefacts that will not exist until build steps 5 and 7, so writing
   them now would produce placeholders. Task 8 writes the three items that *are* decidable, in
   full, and states which build step adds the rest.

---

## File structure

**Created:**

| Path | Responsibility |
|---|---|
| `scripts/check-contracts-pure.mjs` | Guard: `src/contracts/` has every required file and imports nothing |
| `scripts/check-contracts-pure.test.ts` | Its unit tests |
| `src/contracts/errors.ts` | `OrivonErrorCode` closed enum, `OrivonError` shape |
| `src/contracts/handles.ts` | `Handle` and the five handle interfaces |
| `src/contracts/manifest.ts` | `/.well-known/orivon.json` shape, `Grant` |
| `src/contracts/capability-api.ts` | The `orivon.*` surface |
| `src/contracts/limits.ts` | Per-origin limit defaults |
| `src/contracts/ipc.ts` | Renderer/main message shapes, the credit-window protocol |
| `src/contracts/index.ts` | Single import site; re-exports everything |
| `src/main/registry.ts` | `Subsystem` type + the two pure phase runners |
| `src/main/registry.test.ts` | Its unit tests |
| `src/main/subsystems.ts` | The append-only registration list |
| `src/{broker,shim,loader,trust,nostr,telemetry}/README.md` | One per stream: what lives here, what it depends on, what it must never import |
| `src/broker/policy/README.md` | The pure-function boundary from `build-plan.md` §Week 0 |
| `apps/{torrent,fixture}/README.md` | Same, for the two app assets |
| `docs/development/parallel-work.md` | The ownership map and the merge protocol |
| `docs/development/setup.md` | Prerequisites, install, run, the `ELECTRON_RUN_AS_NODE` trap |
| `docs/development/testing.md` | What is tested, why so little is |
| `docs/development/readability-log.md` | Part D of the spec, as a running record |
| `docs/development/release-checklist.md` | The decidable subset |
| `docs/README.md` | Reading order, relocated out of `CLAUDE.md` |
| `.gitattributes` | `merge=union` on the append-only files |
| `LICENSE` | Apache-2.0 |
| `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` | The human entry path |
| `src/README.md`, `scripts/README.md`, `test/README.md`, `spike/README.md` | Boundary READMEs for existing directories |

**Modified:**

| Path | Change |
|---|---|
| `src/main/index.ts` | Runs the subsystem registry around `createShellWindow()` |
| `electron.vite.config.ts` | Comment block naming stream ownership of each extension point |
| `package.json` | `license`, `repository`/`bugs`/`homepage`, `check:contracts` script |
| `.github/workflows/ci.yml` | Adds the contracts-purity step |
| `CLAUDE.md` | Reading order moves out; parallel-work protocol and readability policy move in |

---

## Task 1: The contracts-purity guard

Built before the contracts themselves, so the rule exists before the thing it governs. Mirrors
`scripts/check-no-native-modules.mjs` exactly: an exported pure function taking a root, unit
tested against `mkdtemp` fixtures, plus a direct-invocation CLI block.

**Files:**
- Create: `scripts/check-contracts-pure.mjs`
- Test: `scripts/check-contracts-pure.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `checkContractsArePure(root: string) => { ok: boolean, offenders: string[], missing: string[] }`.
  `offenders` are contract files containing a module reference; `missing` are required files
  absent from the tree. Both are root-relative, sorted, forward-slashed. `ok` is true only when
  both are empty. Task 3 wires this into `package.json` and CI.

- [ ] **Step 1: Write the failing test**

Create `scripts/check-contracts-pure.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkContractsArePure, REQUIRED_CONTRACT_FILES } from './check-contracts-pure.mjs'

/** A root whose src/contracts holds exactly the files given, all import-free. */
const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-contracts-'))
  mkdirSync(join(root, 'src', 'contracts'), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, 'src', 'contracts', name), body)
  }
  return root
}

/** Every required file, each holding a trivially valid, import-free declaration. */
const complete = (overrides: Record<string, string> = {}): string =>
  fixture({
    ...Object.fromEntries(
      REQUIRED_CONTRACT_FILES.map((name) => [name, `export type Placeholder${name.length} = string\n`])
    ),
    ...overrides
  })

describe('checkContractsArePure', () => {
  describe('what it must reject: any module reference', () => {
    it.each([
      ['a value import', `import { app } from 'electron'\nexport type A = string\n`],
      ['a type-only import', `import type { App } from 'electron'\nexport type A = string\n`],
      ['a bare side-effect import', `import 'node:buffer'\nexport type A = string\n`],
      ['a re-export from', `export type { A } from './errors.js'\n`],
      ['a require call', `const fs = require('node:fs')\nexport type A = string\n`],
      ['a dynamic import', `export const load = () => import('./errors.js')\n`]
    ])('fails on %s', (_label, body) => {
      const result = checkContractsArePure(complete({ 'errors.ts': body }))
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual(['src/contracts/errors.ts'])
    })

    it('reports every offender, not just the first', () => {
      const root = complete({
        'errors.ts': `import 'x'\nexport type A = string\n`,
        'handles.ts': `import 'y'\nexport type B = string\n`
      })
      expect(checkContractsArePure(root).offenders).toHaveLength(2)
    })
  })

  describe('what it must NOT reject', () => {
    it('allows the word import inside a line comment', () => {
      const root = complete({
        'errors.ts': `// Consumers import this from ./index.js\nexport type A = string\n`
      })
      expect(checkContractsArePure(root).ok).toBe(true)
    })

    it('allows the word import inside a block comment', () => {
      const root = complete({
        'errors.ts': `/**\n * Do not import electron here.\n */\nexport type A = string\n`
      })
      expect(checkContractsArePure(root).ok).toBe(true)
    })

    it('allows an identifier that merely contains the substring import', () => {
      const root = complete({ 'errors.ts': `export type Important = string\n` })
      expect(checkContractsArePure(root).ok).toBe(true)
    })

    it('ignores files outside src/contracts', () => {
      const root = complete()
      mkdirSync(join(root, 'src', 'main'), { recursive: true })
      writeFileSync(join(root, 'src', 'main', 'index.ts'), `import { app } from 'electron'\n`)
      expect(checkContractsArePure(root).ok).toBe(true)
    })

    it('ignores a colocated test file', () => {
      const root = complete({ 'scratch.test.ts': `import { it } from 'vitest'\nit.skip('x', () => {})\n` })
      expect(checkContractsArePure(root).ok).toBe(true)
    })
  })

  describe('required files', () => {
    it('reports a missing required file', () => {
      const root = complete()
      const { rmSync } = require('node:fs') as typeof import('node:fs')
      rmSync(join(root, 'src', 'contracts', 'ipc.ts'))
      const result = checkContractsArePure(root)
      expect(result.ok).toBe(false)
      expect(result.missing).toEqual(['src/contracts/ipc.ts'])
    })

    it('reports the whole set when src/contracts does not exist at all', () => {
      const root = mkdtempSync(join(tmpdir(), 'orivon-contracts-'))
      const result = checkContractsArePure(root)
      expect(result.ok).toBe(false)
      expect(result.missing).toHaveLength(REQUIRED_CONTRACT_FILES.length)
    })

    it('passes on a complete, import-free tree', () => {
      expect(checkContractsArePure(complete())).toEqual({ ok: true, offenders: [], missing: [] })
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/check-contracts-pure.test.ts`
Expected: FAIL — cannot resolve `./check-contracts-pure.mjs`.

- [ ] **Step 3: Write the implementation**

Create `scripts/check-contracts-pure.mjs`:

```javascript
/**
 * Fails the build if src/contracts/ is incomplete or references any module.
 *
 * src/contracts/ is the frozen interface every parallel stream codes against
 * (docs/planning/repo-and-parallel-work-design.md, Part B). Two properties make
 * it safe for several streams to depend on it at once:
 *
 *   1. It imports NOTHING -- not electron, not node:*, not even `import type`.
 *      An import is a dependency edge, and a dependency edge is a merge
 *      conflict waiting for two streams to reach it from different directions.
 *      ReadableStream, WritableStream and Uint8Array are ambient globals,
 *      available via tsconfig.json's lib: ["ES2023", "DOM", "DOM.Iterable"].
 *   2. Every required file exists, so a stream importing from ./index.js never
 *      finds a half-transcribed surface.
 *
 * Colocated *.test.ts files are exempt: they are not part of the shipped
 * surface and no stream imports them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Files that must exist. Order is the reading order, not alphabetical. */
export const REQUIRED_CONTRACT_FILES = [
  'errors.ts',
  'handles.ts',
  'manifest.ts',
  'capability-api.ts',
  'limits.ts',
  'ipc.ts',
  'index.ts'
]

const CONTRACTS_DIR = join('src', 'contracts')

/** `import ...`, `export ... from ...`, `require(...)`, `import(...)`. */
const MODULE_REFERENCE = /(^|[^.\w])(import\s*[({'"`*]|import\s+[\w{*]|export\s[\s\S]*?\sfrom\s*['"`]|require\s*\()/

/**
 * @param {string} root Directory containing the src/contracts tree to check.
 * @returns {{ ok: boolean, offenders: string[], missing: string[] }}
 *   `offenders` reference a module; `missing` are absent required files. Both
 *   are root-relative, sorted, and forward-slashed so output is stable across
 *   platforms.
 */
export function checkContractsArePure (root) {
  const dir = join(root, CONTRACTS_DIR)
  const rel = (full) => relative(root, full).split(sep).join('/')

  let present = []
  try {
    if (statSync(dir).isDirectory()) {
      present = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    }
  } catch {
    // Absent directory: every required file is missing, reported below.
  }

  const missing = REQUIRED_CONTRACT_FILES
    .filter((name) => !present.includes(name))
    .map((name) => `${CONTRACTS_DIR}/${name}`.split(sep).join('/'))
    .sort()

  const offenders = present
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => MODULE_REFERENCE.test(stripComments(readSafe(join(dir, name)))))
    .map((name) => rel(join(dir, name)))
    .sort()

  return { ok: offenders.length === 0 && missing.length === 0, offenders, missing }
}

function readSafe (path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Removes line and block comments so prose about importing does not trip the
 * check. Deliberately naive -- it does not parse strings or regex literals,
 * because a contracts file is type declarations only and contains neither.
 */
function stripComments (source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href

if (invokedDirectly) {
  const { ok, offenders, missing } = checkContractsArePure(process.cwd())

  if (!ok) {
    if (missing.length > 0) {
      console.error('\nsrc/contracts/ is incomplete. Missing:\n')
      for (const file of missing) console.error(`  ${file}`)
    }
    if (offenders.length > 0) {
      console.error('\nsrc/contracts/ must import nothing. These reference a module:\n')
      for (const file of offenders) console.error(`  ${file}`)
      console.error(
        '\nReadableStream, WritableStream and Uint8Array are ambient globals here;' +
        '\nthey need no import. If a contract genuinely needs a type from elsewhere,' +
        '\nthat is a design change -- raise it, do not add the import.'
      )
    }
    console.error('\nSee docs/planning/repo-and-parallel-work-design.md, Part B.\n')
    process.exit(1)
  }

  console.log(
    `src/contracts/ is complete (${REQUIRED_CONTRACT_FILES.length} files) and imports nothing.`
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/check-contracts-pure.test.ts`
Expected: PASS, all cases.

Then run the full suite to confirm nothing regressed:
Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-contracts-pure.mjs scripts/check-contracts-pure.test.ts
git commit -m "$(cat <<'EOF'
Guard: src/contracts must be complete and import nothing

The contracts package is what lets sequentially-dependent build steps be
worked on concurrently, which only holds if every stream can depend on it
without inheriting a dependency edge. Mirrors the shape of
check-no-native-modules.mjs: a pure exported function over a root, tested
against tmpdir fixtures, plus a CLI block.

Wired into package.json and CI by the task that completes the transcription.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Contracts — errors and handles

Transcription, not design. The source documents contain literal TypeScript; copy it, do not
improve it. Where transcription is impossible because the source is ambiguous, **stop and
append the ambiguity to `docs/open-questions.md`** rather than deciding it here — these are the
two highest-care artefacts in the repository (`ADR-0002`).

**Files:**
- Create: `src/contracts/errors.ts`, `src/contracts/handles.ts`, `src/contracts/index.ts`
- Source: `docs/architecture/handle-contracts.md`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `src/contracts/index.ts`:
  `OrivonErrorCode`, `OrivonError`, `Handle`, `TcpSocket`, `TcpServer`, `UdpSocket`,
  `Datagram`, `FileHandle`, `FileStat`, `IdentityHandle`. Tasks 3 and every future stream
  import these from `../contracts/index.js`.

- [ ] **Step 1: Write `src/contracts/errors.ts`**

Transcribe `handle-contracts.md:40-45` (the `OrivonError` shape) and the code table at
`handle-contracts.md:48-60`. The enum is **closed** and has exactly eleven members, in this
order: `denied`, `revoked`, `unreachable`, `timeout`, `reset`, `closed`, `limit`, `invalid`,
`notFound`, `exists`, `internal`.

```typescript
// Transcribed from docs/architecture/handle-contracts.md SSErrors. That
// document is the specification; this file must not diverge from it. Adding a
// code is a breaking change once orivonApiVersion reaches 1 (SSVersioning).
//
// OrivonError is declared as an interface, not a class, because src/contracts
// emits no runtime code -- a `class` would. The broker constructs the concrete
// error; every consumer only needs its shape.

/**
 * Closed enum. An app may switch on this exhaustively and treat an
 * unrecognised value as a bug, not a case to silently ignore.
 */
export type OrivonErrorCode =
  /** Outside what was granted: pattern mismatch, undeclared capability, privileged port, blocked address range. */
  | 'denied'
  /** The grant authorising this handle was withdrawn. */
  | 'revoked'
  /** The peer could not be reached: refused, no route, DNS failure. */
  | 'unreachable'
  /** The operation exceeded its deadline. */
  | 'timeout'
  /** The peer terminated an established connection abruptly. */
  | 'reset'
  /** Operation attempted on a handle that is already closed. */
  | 'closed'
  /** A resource limit was hit: quota, socket count, in-flight cap. See ./limits.js. */
  | 'limit'
  /** Malformed argument: bad path, bad address, bad option. */
  | 'invalid'
  /** The named file or directory does not exist. */
  | 'notFound'
  /** The named file or directory already exists. */
  | 'exists'
  /** A broker fault. Should never be observed by an app; always logged. */
  | 'internal'

export interface OrivonError extends Error {
  readonly code: OrivonErrorCode
  /**
   * The underlying engine's own detail -- a Node errno today (ECONNREFUSED,
   * ENOENT), whatever WASI or Mojo expose later. ADVISORY AND UNVERSIONED: an
   * app branching on this codes against the engine, not against Orivon. It
   * exists so orivon-node-shim can reconstruct a faithful Node Error, because
   * `err.code === 'ECONNREFUSED'` is a real Node idiom that must keep working.
   *
   * NEVER present when `code` is 'denied'. That is deliberate: if denials
   * varied by reason, an app could iterate through them and map exactly which
   * pattern, port or address class is blocked, turning the permission boundary
   * itself into a probe target (SSErrors, owner decision 2026-08-26).
   */
  readonly platformCode?: string
  readonly handleId?: string
}
```

- [ ] **Step 2: Write `src/contracts/handles.ts`**

Transcribe, in this order, preserving every `readonly` and every signature exactly:

| From | Lines | Interfaces |
|---|---|---|
| §Common shape | `handle-contracts.md:21-27` | `Handle` |
| §TcpSocket | `handle-contracts.md:107-118` | `TcpSocket` |
| §TcpServer | `handle-contracts.md:177-183` | `TcpServer` |
| §UdpSocket | `handle-contracts.md:205-219` | `Datagram`, `UdpSocket` |
| §FileHandle | `handle-contracts.md:241-257` | `FileStat`, `FileHandle` |
| §IdentityHandle | `handle-contracts.md:288-294` | `IdentityHandle` |

`Handle` is the base every other extends:

```typescript
export interface Handle {
  /** Opaque; per-origin, not forgeable across origins (security-model.md T11c). */
  readonly id: string
  /** Resolves on clean close; rejects with an OrivonError otherwise. */
  readonly closed: Promise<void>
  /** Idempotent. */
  close(): Promise<void>
}
```

Carry these four rules into the file as comments, because each is a contract a
future implementer will otherwise violate:

1. **Handles are never transferable** (§Common shape). A `MessagePort` is transferable and
   carries no sender identity, so a transferred handle would be a bearer capability the broker
   cannot see.
2. **`TcpSocket.remoteAddress` is the RESOLVED address**, not the hostname the app asked for —
   the same address the T12 policy check ran against.
3. **Every synchronous-looking property is populated before the acquisition promise settles.**
   Never a cache filled in by a later event. This is the fix for the `address()` problem
   `spike/gate1b/shim/dgram.js` had to work around.
4. **`FileHandle` has no implicit cursor** — `position` is explicit and required on every
   positional call, because a shared cursor across an async IPC boundary is a race the instant
   two writes are in flight, which a torrent writer does routinely.

- [ ] **Step 3: Write `src/contracts/index.ts` with what exists so far**

```typescript
// The single import site for the Orivon capability surface. Consumers import
// from here, never from a sibling file directly, so the internal file split
// can change without touching any stream.
//
// This directory imports NOTHING and emits NO runtime code. See
// scripts/check-contracts-pure.mjs and
// docs/planning/repo-and-parallel-work-design.md Part B.
export type { OrivonErrorCode, OrivonError } from './errors.js'
export type {
  Handle,
  TcpSocket,
  TcpServer,
  UdpSocket,
  Datagram,
  FileHandle,
  FileStat,
  IdentityHandle
} from './handles.js'
```

> **Note the exception:** `index.ts` is the one contracts file that legitimately contains
> `export ... from`. Task 1's guard will flag it. That is correct behaviour to *discover*, not
> to work around — Step 4 fixes the guard.

- [ ] **Step 4: Exempt `index.ts` from the module-reference rule**

The barrel file must re-export, and re-exporting is a module reference. Add the exemption to
`scripts/check-contracts-pure.mjs`, narrowly — `index.ts` may only re-export from siblings in
the same directory, never from outside:

In `checkContractsArePure`, replace the `offenders` computation with:

```javascript
  const offenders = present
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => {
      const source = stripComments(readSafe(join(dir, name)))
      // index.ts is the barrel: it re-exports siblings and nothing else. Any
      // other module reference in it, and any module reference at all in the
      // other files, is a violation.
      if (name === 'index.ts') return hasNonSiblingReference(source)
      return MODULE_REFERENCE.test(source)
    })
    .map((name) => rel(join(dir, name)))
    .sort()
```

and add, beside `stripComments`:

```javascript
/** True if the barrel references anything other than a `./sibling.js`. */
function hasNonSiblingReference (source) {
  const specifiers = [...source.matchAll(/from\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
  const otherReference = /(^|[^.\w])(import\s*[({'"`*]|import\s+[\w{*]|require\s*\()/
  return otherReference.test(source) ||
    specifiers.some((s) => !/^\.\/[a-z-]+\.js$/.test(s))
}
```

Add the matching cases to `scripts/check-contracts-pure.test.ts`:

```typescript
  describe('the index.ts barrel exemption', () => {
    it('allows index.ts to re-export a sibling', () => {
      const root = complete({ 'index.ts': `export type { A } from './errors.js'\n` })
      expect(checkContractsArePure(root).ok).toBe(true)
    })

    it('rejects index.ts re-exporting outside the directory', () => {
      const root = complete({ 'index.ts': `export type { App } from 'electron'\n` })
      expect(checkContractsArePure(root).ok).toBe(false)
      expect(checkContractsArePure(root).offenders).toEqual(['src/contracts/index.ts'])
    })

    it('rejects a plain import in index.ts', () => {
      const root = complete({ 'index.ts': `import 'electron'\nexport type A = string\n` })
      expect(checkContractsArePure(root).ok).toBe(false)
    })

    it('still rejects a re-export from a sibling in a non-barrel file', () => {
      const root = complete({ 'handles.ts': `export type { A } from './errors.js'\n` })
      expect(checkContractsArePure(root).ok).toBe(false)
    })
  })
```

- [ ] **Step 5: Run the checks**

Run: `npm run typecheck && npx vitest run scripts/check-contracts-pure.test.ts`
Expected: typecheck PASS (contracts compile), all guard tests PASS.

Run: `node scripts/check-contracts-pure.mjs`
Expected: FAIL, listing exactly the four not-yet-written files —
`src/contracts/capability-api.ts`, `ipc.ts`, `limits.ts`, `manifest.ts`. This is the correct
state at the end of Task 2; Task 3 makes it green.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/errors.ts src/contracts/handles.ts src/contracts/index.ts \
        scripts/check-contracts-pure.mjs scripts/check-contracts-pure.test.ts
git commit -m "$(cat <<'EOF'
Contracts: the error enum and the five handle interfaces

Transcribed from handle-contracts.md, which contains literal TypeScript --
this is a transcription, not a design. OrivonError is an interface rather
than a class because this directory emits no runtime code.

The barrel file legitimately re-exports, so the purity guard gains a narrow
exemption: index.ts may reference ./sibling.js and nothing else.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Contracts — the capability surface, manifest, limits and IPC

**Files:**
- Create: `src/contracts/manifest.ts`, `src/contracts/capability-api.ts`, `src/contracts/limits.ts`, `src/contracts/ipc.ts`
- Modify: `src/contracts/index.ts`, `package.json`, `.github/workflows/ci.yml`
- Source: `docs/architecture/capability-api.md`, `docs/architecture/handle-contracts.md` §Limits

**Interfaces:**
- Consumes: `OrivonErrorCode` and the handle types from Task 2.
- Produces: `Manifest`, `Capabilities`, `Grant`, `GrantId`, `Orivon` (the root `orivon.*`
  object), `LIMITS`, and the IPC message unions. Every stream from build step 2 onward imports
  these.

- [ ] **Step 1: Write `src/contracts/manifest.ts`**

Transcribe the JSON shape at `capability-api.md:72-96`. Carry these facts in as comments:

- `publisherKey` is **cut from v0** (owner decision 2026-08-25) — do not add a field for it.
  v0 integrity is hash-pinning alone, and there is no UNSIGNED badge anywhere, because
  "unsigned" is not a distinction when everything is.
- `id` is reverse-DNS and **informational**. The **origin** is the real key — it keys storage,
  the session partition, the grant ledger and the derived identity key.
- `"connect": ["*:*"]` is what the torrent app genuinely needs. The grant prompt must render it
  as *"connect to any computer on the internet"*, not as a pattern string.
- `listen` rejects `"*"`: a declared port range is required, and privileged ports below 1024
  are denied at every tier (`capability-api.md` A9 §1).

```typescript
export type GrantId = string

export interface Manifest {
  /** 0 means UNSTABLE: breaking changes are permitted until it reaches 1. */
  readonly orivonApiVersion: 0
  /** Reverse-DNS, informational only. The origin is the real isolation key. */
  readonly id: string
  /** Self-asserted by the site. The grant prompt shows the ORIGIN first and marks this as claimed. */
  readonly name: string
  readonly version: string
  readonly entry: string
  readonly capabilities: Capabilities
}
```

Then `Capabilities`, `NetCapability`, `TcpCapability`, `UdpCapability`, `FsCapability`,
`IdCapability`, and `Grant` (an origin, a capability kind, the granted pattern set, and its
`GrantId` — the pattern set is what the re-consent subset check at `capability-api.md:346-366`
compares against).

- [ ] **Step 2: Write `src/contracts/limits.ts`**

Transcribe the table at `handle-contracts.md:342-347`. These are runtime *values*, not types —
`limits.ts` is therefore the one contracts file that emits code, and that is fine: it emits a
frozen object literal and still imports nothing.

```typescript
/**
 * Per-origin resource limits (handle-contracts.md SSLimits, security-model.md
 * T11/T11b). Defaults chosen against gate 4's measured numbers -- 100
 * concurrent sockets exercised cleanly -- with headroom.
 *
 * Exceeding any of these yields an OrivonError with code 'limit'. Calls beyond
 * the in-flight cap REJECT IMMEDIATELY; they do not queue. An unbounded queue
 * on the broker's UI thread is precisely how one misbehaving origin freezes
 * every tab.
 */
export const LIMITS = {
  /** TcpSocket + UdpSocket + accepted connections, combined. */
  concurrentSockets: 512,
  concurrentFileHandles: 64,
  inFlightOperations: 256,
  /** Per-socket read credit window, in bytes. 1 MiB. */
  readWindowBytes: 1024 * 1024
} as const

export type Limits = typeof LIMITS
```

- [ ] **Step 3: Write `src/contracts/capability-api.ts`**

Transcribe `capability-api.md:112-141`. Every entry point returns a Promise (design rule 2:
across an IPC boundary nothing can be constructed synchronously).

Carry in the two identity kinds, because conflating them is a recorded past error
(`capability-api.md:152-166`): **app keys** are per-origin and silent; **named identities** are
cross-origin *by design*, behind an explicit connect prompt, because an npub must be identical
across every Nostr client or the identity fragments per site.

And the binding rule: `IdentityHandle.signEvent` takes a structured object, never raw bytes.
A raw-signing oracle would let a compromised client wipe a follow list (kind 3), delete posts
(kind 5), replace the profile (kind 0) or authenticate to relays (kind 22242) — and `ADR-0003`
excludes export, so the user could not rotate away from it.

- [ ] **Step 4: Write `src/contracts/ipc.ts`**

The renderer/main message shapes, including the credit-window protocol specified in
`handle-contracts.md:150-173`. Constants to encode:

```typescript
/**
 * Backpressure (handle-contracts.md SSTcpSocket). The broker sends at most
 * WINDOW bytes ahead of what the renderer has acknowledged consuming; when
 * outstanding credit hits zero it STOPS READING THE UNDERLYING OS SOCKET
 * rather than buffering in the main process, so real TCP backpressure reaches
 * the remote peer.
 *
 * Credit updates are coalesced: at most one message per CREDIT_COALESCE_BYTES
 * consumed, or once per animation frame, whichever comes first. A 52 MB/s
 * stream (gate 4's measured throughput) must not emit one broker message per
 * chunk.
 */
export const CREDIT_COALESCE_BYTES = 64 * 1024
```

Two rules that belong in this file as comments, both established by spike gate 0 and binding
per `handle-contracts.md:353-390`:

1. **Every reply-carrying message needs an explicit timeout.** This transport's failure mode is
   total silence, not an error. A promise awaiting a reply with no timeout hangs forever.
2. **No transferables on the renderer to main path, ever.** `electron#34905` reproduces: an
   `ArrayBuffer` in a `postMessage` transfer list renderer to main silently never arrives.
   Structured clone is the only mechanism, and at 313–1134 MB/s measured against a 1–5 MB/s
   product need, it is entirely sufficient.

- [ ] **Step 5: Extend `src/contracts/index.ts`**

Add the four new re-export blocks, keeping the reading order: errors, handles, manifest,
capability-api, limits, ipc.

- [ ] **Step 6: Wire the guard into `package.json` and CI**

In `package.json` `scripts`, after `check:natives`:

```json
    "check:contracts": "node scripts/check-contracts-pure.mjs",
```

In `.github/workflows/ci.yml`, after the Rule 8 step:

```yaml
      - name: Contracts import nothing and are complete
        run: npm run check:contracts
```

- [ ] **Step 7: Run everything**

Run: `npm run check:contracts`
Expected: PASS — `src/contracts/ is complete (7 files) and imports nothing.`

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS. The build must still produce `out/main/index.js`; contracts emit no runtime
code, so bundle size should be unchanged.

- [ ] **Step 8: Record any gaps found, then commit**

If transcription surfaced anything ambiguous in the two source documents, append it to
`docs/open-questions.md` §A now (`CLAUDE.md` Rule 3). Then:

```bash
git add src/contracts package.json .github/workflows/ci.yml docs/open-questions.md
git commit -m "$(cat <<'EOF'
Contracts: capability surface, manifest, limits and the IPC shapes

Completes the transcription of capability-api.md and handle-contracts.md
into types. limits.ts is the one file here that emits runtime code -- a
frozen object literal -- and still imports nothing.

check:contracts now runs in CI, so a stream cannot land a contracts change
that pulls in a dependency edge.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: The composition root

Converts `src/main/index.ts` from a file every stream must *edit* into one every stream
*appends to*. Two lines per subsystem: an import and a list entry.

**Files:**
- Create: `src/main/registry.ts`, `src/main/registry.test.ts`, `src/main/subsystems.ts`
- Modify: `src/main/index.ts`, `electron.vite.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Subsystem { readonly name: string; beforeReady?(): void; afterReady?(ctx: SubsystemContext): void | Promise<void> }`,
  `interface SubsystemContext { readonly app: App }`,
  `runBeforeReady(list: Subsystem[]): SubsystemFailure[]`,
  `runAfterReady(list: Subsystem[], ctx: SubsystemContext): Promise<SubsystemFailure[]>`,
  `interface SubsystemFailure { readonly name: string; readonly phase: 'beforeReady' | 'afterReady'; readonly error: unknown }`.
  Every stream from build step 2 onward adds one entry to `src/main/subsystems.ts`.

**Why two phases:** `protocol.registerSchemesAsPrivileged` must be called *before* `app` is
ready, and build step 5's range-capable custom media scheme (`build-plan.md` §5) needs it. One
phase would force that stream to restructure `index.ts` — exactly what this task exists to
prevent.

- [ ] **Step 1: Write the failing test**

Create `src/main/registry.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { runAfterReady, runBeforeReady, type Subsystem, type SubsystemContext } from './registry.js'

// The registry never touches Electron at runtime -- SubsystemContext.app is a
// type-only import, erased by verbatimModuleSyntax -- so a plain object stands
// in for the App here.
const ctx = { app: {} } as unknown as SubsystemContext

describe('runBeforeReady', () => {
  it('runs every beforeReady in list order', () => {
    const order: string[] = []
    const make = (name: string): Subsystem => ({ name, beforeReady: () => { order.push(name) } })
    runBeforeReady([make('a'), make('b'), make('c')])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('skips a subsystem that declares no beforeReady', () => {
    expect(runBeforeReady([{ name: 'passive' }])).toEqual([])
  })

  it('reports a throwing subsystem instead of propagating', () => {
    const boom = new Error('scheme registration failed')
    const failures = runBeforeReady([{ name: 'broken', beforeReady: () => { throw boom } }])
    expect(failures).toEqual([{ name: 'broken', phase: 'beforeReady', error: boom }])
  })

  it('still runs later subsystems after one throws', () => {
    const after = vi.fn()
    runBeforeReady([
      { name: 'broken', beforeReady: () => { throw new Error('x') } },
      { name: 'later', beforeReady: after }
    ])
    expect(after).toHaveBeenCalledOnce()
  })
})

describe('runAfterReady', () => {
  it('awaits each subsystem in list order, not concurrently', async () => {
    const order: string[] = []
    const slow: Subsystem = {
      name: 'slow',
      afterReady: async () => {
        await new Promise((r) => setTimeout(r, 10))
        order.push('slow')
      }
    }
    const fast: Subsystem = { name: 'fast', afterReady: () => { order.push('fast') } }
    await runAfterReady([slow, fast], ctx)
    expect(order).toEqual(['slow', 'fast'])
  })

  it('passes the context through', async () => {
    const seen = vi.fn()
    await runAfterReady([{ name: 'a', afterReady: seen }], ctx)
    expect(seen).toHaveBeenCalledWith(ctx)
  })

  it('reports a rejecting subsystem instead of propagating', async () => {
    const boom = new Error('broker failed to start')
    const failures = await runAfterReady(
      [{ name: 'broker', afterReady: async () => { throw boom } }],
      ctx
    )
    expect(failures).toEqual([{ name: 'broker', phase: 'afterReady', error: boom }])
  })

  it('still runs later subsystems after one rejects', async () => {
    const after = vi.fn()
    await runAfterReady([
      { name: 'broken', afterReady: () => { throw new Error('x') } },
      { name: 'later', afterReady: after }
    ], ctx)
    expect(after).toHaveBeenCalledOnce()
  })

  it('returns no failures for an empty list', async () => {
    expect(await runAfterReady([], ctx)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/registry.test.ts`
Expected: FAIL — cannot resolve `./registry.js`.

- [ ] **Step 3: Write `src/main/registry.ts`**

```typescript
// The composition root's mechanism. Each subsystem -- broker, shim, loader,
// trust indicator, Nostr, telemetry -- registers itself here rather than
// editing app lifecycle code, so adding one is an APPEND to
// src/main/subsystems.ts (two lines: an import and a list entry) and never an
// edit to shared logic. Git merges appends to different positions of a list
// cleanly; it does not merge two edits to the same conditional.
//
// See docs/development/parallel-work.md.
//
// Two phases, because Electron forces it: protocol.registerSchemesAsPrivileged
// must be called BEFORE app ready, and build step 5's range-capable media
// scheme needs it (build-plan.md SS5). A single phase would make that stream
// restructure this file -- exactly what this exists to prevent.
//
// This module imports nothing from electron at runtime: `App` is a type-only
// import, erased by verbatimModuleSyntax. That is what makes it unit testable.
import type { App } from 'electron'

export interface SubsystemContext {
  readonly app: App
}

export interface Subsystem {
  /** Used in failure reports. Keep it short and stream-shaped, e.g. 'broker'. */
  readonly name: string
  /** Runs before app ready. For registrations Electron requires that early. */
  beforeReady?: () => void
  /** Runs after app ready, before the shell window is created. */
  afterReady?: (ctx: SubsystemContext) => void | Promise<void>
}

export interface SubsystemFailure {
  readonly name: string
  readonly phase: 'beforeReady' | 'afterReady'
  readonly error: unknown
}

/**
 * A failing subsystem must not take down the browser, and must not silently
 * prevent the ones after it from starting. Failures are collected and returned
 * for the caller to report; they are never swallowed and never propagated.
 */
export function runBeforeReady (list: Subsystem[]): SubsystemFailure[] {
  const failures: SubsystemFailure[] = []
  for (const subsystem of list) {
    if (subsystem.beforeReady === undefined) continue
    try {
      subsystem.beforeReady()
    } catch (error) {
      failures.push({ name: subsystem.name, phase: 'beforeReady', error })
    }
  }
  return failures
}

/** Sequential, not concurrent: a later subsystem may depend on an earlier one. */
export async function runAfterReady (
  list: Subsystem[],
  ctx: SubsystemContext
): Promise<SubsystemFailure[]> {
  const failures: SubsystemFailure[] = []
  for (const subsystem of list) {
    if (subsystem.afterReady === undefined) continue
    try {
      await subsystem.afterReady(ctx)
    } catch (error) {
      failures.push({ name: subsystem.name, phase: 'afterReady', error })
    }
  }
  return failures
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/registry.test.ts`
Expected: PASS, all eleven cases.

- [ ] **Step 5: Write `src/main/subsystems.ts`**

```typescript
// THE APPEND POINT. Adding a subsystem is two lines: an import above, and one
// entry in the array below. Do not add logic to this file -- conditionals here
// reintroduce exactly the merge conflicts the registry exists to remove.
//
// Ownership of each subsystem is recorded in docs/development/parallel-work.md.
import type { Subsystem } from './registry.js'

export const subsystems: Subsystem[] = [
  // build step 2: broker
  // build step 3: shim
  // build step 4: loader
  // build step 6: trust
  // build step 7: nostr
  // build step 8: telemetry
]
```

- [ ] **Step 6: Rewire `src/main/index.ts`**

Keep every existing comment block — the CJS/ESM note, the `BrowserWindow -> BaseWindow` note
and the tried-and-reverted `ozone-platform` warning are all load-bearing history. Replace only
the bottom section:

```typescript
import { app, BaseWindow } from 'electron'
import { createShellWindow } from './window.js'
import { runAfterReady, runBeforeReady, type SubsystemFailure } from './registry.js'
import { subsystems } from './subsystems.js'

// ... existing comment blocks unchanged ...

function report (failures: SubsystemFailure[]): void {
  // Loud, not silent. handle-contracts.md SSWhat the shim must do rule 2: in
  // security-relevant code an error must be MORE visible than the default, not
  // less. A subsystem that failed to start is a capability that may not be
  // enforcing anything.
  for (const { name, phase, error } of failures) {
    console.error(`[orivon] subsystem "${name}" failed during ${phase}:`, error)
  }
}

report(runBeforeReady(subsystems))

void app.whenReady().then(async () => {
  report(await runAfterReady(subsystems, { app }))
  createShellWindow()
  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createShellWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 7: Annotate `electron.vite.config.ts`**

No structural change (see the deviations note at the top of this plan). Add one comment above
`preload.build.rollupOptions.input`:

```typescript
      // APPEND POINT. Each entry is one line; a stream adding a preload adds
      // one key here and nothing else. Ownership: docs/development/parallel-work.md.
```

and one above `renderer.resolve.alias`, after the existing block:

```typescript
      // APPEND POINT, owned by the `shim` stream (build step 3). No other
      // stream writes to this map.
```

- [ ] **Step 8: Verify the shell still works**

Run: `npm run typecheck && npm test`
Expected: PASS, including the pre-existing `src/main/omnibox.test.ts`.

Run: `npm run smoke`
Expected: PASS. This builds and drives the real shell with real clicks. **Read the JSON result
and the failure list it prints — never trust the exit code alone** (`CLAUDE.md` traps). A window
must actually appear; if nothing does, check `ELECTRON_RUN_AS_NODE` is being stripped by
`test/launch-electron.mjs`.

- [ ] **Step 9: Commit**

```bash
git add src/main/registry.ts src/main/registry.test.ts src/main/subsystems.ts \
        src/main/index.ts electron.vite.config.ts
git commit -m "$(cat <<'EOF'
Composition root: subsystems append, they do not edit

src/main/index.ts was the file every future stream would have to edit to
wire itself in, which makes it the repository's worst merge surface.
Adding a subsystem is now two lines appended to src/main/subsystems.ts.

Two phases because Electron forces it: registerSchemesAsPrivileged must
run before app ready, and build step 5's media scheme needs that.

Failures are collected and reported loudly rather than propagated: a
subsystem that failed to start may be a capability enforcing nothing, and
that must not be quiet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Stream directories and their boundary READMEs

Creates the skeleton the ownership map refers to. Git does not track empty directories, so
**the README is what makes each directory exist** — which is convenient, because the README is
also the boundary declaration.

**Files:**
- Create: `src/README.md`, `src/contracts/README.md`, `src/broker/README.md`,
  `src/broker/policy/README.md`, `src/shim/README.md`, `src/loader/README.md`,
  `src/trust/README.md`, `src/nostr/README.md`, `src/telemetry/README.md`,
  `apps/torrent/README.md`, `apps/fixture/README.md`, `scripts/README.md`, `test/README.md`,
  `spike/README.md`

**Interfaces:**
- Consumes: the stream names from the spec's ownership table.
- Produces: the directory skeleton Task 6's ownership map points at, and the boundary statements
  Task 9's `ARCHITECTURE.md` summarises.

- [ ] **Step 1: Write the boundary READMEs**

Every one answers exactly three questions, in this order, in a few lines each:

```markdown
# <directory>

**What lives here.** <one or two sentences>

**What it depends on.** <exact list, or "nothing">

**What it must never import.** <exact list, with the reason>

**Build step / owner stream.** <n, name> — see `docs/development/parallel-work.md`.
```

The specific content per directory:

| Directory | Depends on | Must never import | Why |
|---|---|---|---|
| `src/contracts/` | nothing | anything at all | A dependency edge here is a merge conflict every stream reaches from a different direction. Enforced by `npm run check:contracts` |
| `src/broker/` | `src/contracts/`, `electron` | `src/shim/`, `src/loader/`, any renderer code | The broker is the authority; importing a consumer inverts the trust direction |
| `src/broker/policy/` | `src/contracts/` only | **`electron`, `node:fs`, `node:net`, `node:dns`, anything performing I/O** | `build-plan.md` §Week 0: these are pure functions constructed as `createBroker({ dial, resolve, now, fs, keychain })`, so every capability test runs against stubs. Deciding this later costs a day of refactor exactly when the schedule is tightest |
| `src/shim/` | `src/contracts/` | `electron`, `src/broker/` | The shim runs in the renderer and reaches the broker only through `orivon.*`. Importing the broker would give it main-process authority it must not have |
| `src/loader/` | `src/contracts/`, `src/broker/` | `src/shim/` | |
| `src/trust/` | `src/contracts/` | `src/broker/` internals | Reads the broker's connection log through a contract, per `ADR-0006` |
| `src/nostr/` | `src/contracts/` | `src/broker/` internals | |
| `src/telemetry/` | `src/contracts/` | `src/broker/` internals | |
| `apps/torrent/` | `src/contracts/` (types only) | anything under `src/` at runtime | It is an ordinary URL-delivered app (`ADR-0005`) and must have no privileged path. **Ships as a pre-built app asset, never a shell dependency** — webtorrent reaches `node-datachannel`, which needs CMake (Rule 8) |
| `apps/fixture/` | nothing | — | The e2e fixture app, also app #3 for the genericity test and the developer-mode example |
| `scripts/` | `node:*` | `src/` | Build and CI guards. Two live here: Rule 8's native-module check and the contracts-purity check |
| `test/` | `@playwright/test`, `electron` | — | `launch-electron.mjs` is the only correct way to start Electron in this repo |
| `spike/` | — | — | **Historical evidence, not live code.** Seven gate directories behind `docs/planning/spike-verdict.md`. Do not import from it, do not modernise it, do not fix its lint. It is the record of what was measured on 2026-08-25 and must stay as it was when measured |

`src/README.md` is the index: a table of the subdirectories, each with its one-line purpose and
its build step, plus the one-paragraph data flow (renderer → `orivon.*` → preload
`contextBridge` closures → broker → OS).

- [ ] **Step 2: Verify nothing broke**

Run: `npm run typecheck && npm test && npm run check:contracts`
Expected: PASS. Empty directories containing only a README must not affect the build.

Run: `git status --short`
Expected: exactly the fourteen new READMEs, nothing else.

- [ ] **Step 3: Commit**

```bash
git add src apps scripts/README.md test/README.md spike/README.md
git commit -m "$(cat <<'EOF'
One README per directory: what lives here, what it depends on, what it
must never import

The third line is the point -- it turns the directory tree from a
description into an enforceable boundary, and it is the ownership map the
parallel-work system relies on.

Also creates the stream skeleton. Git does not track empty directories,
so the README is what makes each one exist.

src/broker/policy/ records the no-Electron, no-I/O rule from build-plan.md
week 0 at the boundary itself, where the stream that fills it will see it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The parallel-work system, written down

**Files:**
- Create: `docs/development/parallel-work.md`, `.gitattributes`, `docs/development/readability-log.md`

**Interfaces:**
- Consumes: the directory skeleton from Task 5, the append points from Task 4.
- Produces: the operational guide `CONTRIBUTING.md` (Task 9) and `CLAUDE.md` (Task 10) both
  link to. This is the authoritative ownership map.

- [ ] **Step 1: Write `docs/development/parallel-work.md`**

Required sections, in order:

1. **Why parallelism has to be manufactured.** `build-plan.md` is dependency-ordered; step 3
   cannot begin before step 2 exists. Freezing the interfaces in `src/contracts/` is what lets a
   stream build against a contract and a stub instead of against another stream's half-finished
   code.
2. **The ownership map** — the eleven-row table from the spec, verbatim, with each `Owns` path
   now real on disk.
3. **Starting a stream** — the exact commands:
   ```bash
   git worktree add ../orivon-broker -b stream/broker
   cd ../orivon-broker && npm install
   ```
   plus: run `npm run typecheck && npm test` before opening the PR, and rebase on `main` first.
4. **The four prevention rules** — worktrees; stay inside your owned paths; contracts changes
   are their own PR merged first; append at the append points, never edit them.
5. **The three repair mechanisms** — the lockfile rule, `merge=union`, CI. State the lockfile
   rule as an imperative, because it is the one most often got wrong: *take either side whole,
   run `npm install`, commit the regenerated file. Never resolve it hunk by hunk — a hand-merged
   lockfile can look correct and install a different tree.*
6. **The merge protocol** — branch, work, rebase, PR with the four-part body (goal, paths
   touched, contracts depended on, how it was verified), CI green, owner merges.
7. **What is concurrent right now** — `broker`, `packaging`, `telemetry`, `docs`.

- [ ] **Step 2: Write `.gitattributes`**

```gitattributes
# Append-only files: git keeps both sides instead of stopping the merge.
#
# Correct ONLY where every change is an append and order does not matter.
# NEVER extend this to source files -- union-merging code produces something
# syntactically valid and semantically wrong, which is worse than a conflict.
devlog/journal.md   merge=union
CHANGELOG.md        merge=union

# Regenerate, never hand-merge. See docs/development/parallel-work.md.
# A hand-merged lockfile can look correct and install a different tree.
package-lock.json   -diff
```

- [ ] **Step 3: Write `docs/development/readability-log.md`**

The running record for the spec's Part D. Header explaining the protocol — *one artefact, one
question: "where is the first place you got lost, or had to guess?"*, because "is this good?"
reliably returns a useless answer — then a table with columns: Date, Artefact, First confusion
point, Fix made. One seeded row is added in Task 9 when the first check actually runs; the file
ships with the protocol and an empty table.

- [ ] **Step 4: Verify the union merge actually works**

Do not assume it. Prove it:

```bash
git checkout -b tmp/union-a && printf '\n- line from A\n' >> devlog/journal.md \
  && git commit -aqm "tmp A"
git checkout -q - && git checkout -b tmp/union-b && printf '\n- line from B\n' >> devlog/journal.md \
  && git commit -aqm "tmp B"
git merge tmp/union-a
```

Expected: the merge **succeeds without a conflict**, and `devlog/journal.md` ends with both
lines. Then clean up:

```bash
git checkout -q master && git branch -qD tmp/union-a tmp/union-b
```

If it conflicted, `.gitattributes` was not in effect on both branches — commit it first, then
retest.

- [ ] **Step 5: Commit**

```bash
git add docs/development/parallel-work.md docs/development/readability-log.md .gitattributes
git commit -m "$(cat <<'EOF'
The parallel-work system: ownership map, worktree flow, conflict repair

Records which stream owns which paths, how to start one in a worktree, and
the three repair mechanisms for when prevention fails. The lockfile rule is
stated as an imperative because it is the one most often got wrong: a
hand-merged package-lock.json can look correct and install a different tree.

merge=union on the two genuinely append-only files, verified by actually
merging two divergent appends rather than assuming it works.

Also starts the readability log -- the standing check that the docs are
legible to a human, run on the owner at the end of every build step.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: The docs index and the developer guides

**Files:**
- Create: `docs/README.md`, `docs/development/setup.md`, `docs/development/testing.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the reading order `README.md` (Task 9) and `CLAUDE.md` (Task 10) both link to,
  replacing the list currently embedded in `CLAUDE.md`.

- [ ] **Step 1: Write `docs/development/setup.md`**

Must contain, concretely:

- **Prerequisites:** Node `>=22.12.0` (24 recommended, matching CI), git. **No compiler, no
  Python, no CMake** — and if `npm install` ever asks for one, that is a Rule 8 violation and
  `npm run check:natives` should have caught it.
- **Install and run:** `git clone`, `npm install`, `npm run dev`.
- **The `ELECTRON_RUN_AS_NODE` trap**, in full and prominently. On a machine where it is set in
  the ambient shell, the Electron binary runs as plain Node — no window, no `MessagePortMain` —
  and **it does not fail loudly.** Never launch Electron directly; use `test/launch-electron.mjs`,
  which strips it and verifies the launch is real. This costs hours if discovered by debugging.
- **Every script in `package.json`**, one line each: `dev`, `build`, `start`, `typecheck`,
  `test`, `check:natives`, `check:contracts`, `smoke`.
- **Platform notes:** Linux is the packaged target (AppImage + deb). Windows and macOS are
  supported day one via run-from-source, which is why Rule 8 exists. `safeStorage` differs per
  platform and on Linux needs an available keyring.
- **Reading `npm run smoke` output:** it prints a JSON result and a failure list. Read those,
  not the exit code alone.

- [ ] **Step 2: Write `docs/development/testing.md`**

Must explain the *reasoning*, because the surprising thing about this repo is how little is
tested and a newcomer will otherwise assume neglect:

- Testing is deliberately minimal, concentrated where silent failure is plausible and costly
  (`build-plan.md` §Testing). **No UI tests, no coverage targets** — at this scale they cost
  more than they return.
- **The six unit-tested areas**, listed with why each is security-critical: capability checking
  at the call site (not just the matcher); `fs` path-traversal rejection; origin derivation,
  split in two; key derivation as frozen golden vectors; the update decision table; telemetry
  session accounting.
- **The one end-to-end smoke test** and its highest-value assertion: the fixture app attempts a
  connection *outside* its manifest patterns and is **rejected**. Without that clause, nothing
  fails if capability enforcement degrades to allow-all.
- **How to run each:** `npm test` (Vitest, `environment: 'node'`, `src/**/*.test.ts` and
  `scripts/**/*.test.ts`), `npm run smoke` (real Electron), `npm run typecheck`.
- **The known e2e risk:** spike gate 3 is BLOCKED, not failed — the app works, but Playwright's
  `_electron` driver could not attach to that window for an unidentified reason. Build step 2's
  e2e uses the same driver. Check early.

- [ ] **Step 3: Write `docs/README.md`**

The reading order, in three explicit tracks, so a reader picks one rather than reading all 45
documents:

- **To understand the product:** `mvp-scope.md` → `architecture/capability-api.md` →
  `architecture/handle-contracts.md`
- **To understand a decision:** `decisions/` — eight ADRs. Warn that **ADR-0002 and ADR-0005
  carry amendments superseding parts of their own text**, and ADR-0008 rescopes ADR-0002's
  Node-shape rule to the shim.
- **To start working:** `development/setup.md` → `development/parallel-work.md` →
  `development/testing.md` → `planning/build-plan.md`

Plus the sources-of-truth table relocated from `CLAUDE.md`, and one warning a newcomer needs
early: **`docs/planning/audit-2026-08-25.md` records corrections that reverse earlier claims**,
and several documents carry inline reversals. Read the correction blocks; they are not
decoration.

- [ ] **Step 4: Check every link resolves**

```bash
grep -rhoE '\]\([^)#][^)]*\)' docs/README.md docs/development/*.md \
  | sed -E 's/^\]\(//; s/\)$//' | sort -u \
  | while read -r p; do [ -e "docs/$p" ] || [ -e "$p" ] || echo "BROKEN: $p"; done
```

Expected: no output. Fix any `BROKEN:` line before committing.

- [ ] **Step 5: Commit**

```bash
git add docs/README.md docs/development/setup.md docs/development/testing.md
git commit -m "$(cat <<'EOF'
Docs index and developer guides

The reading order lived in CLAUDE.md, which is an agent file -- so the only
map of a 45-document corpus was addressed to a machine. It now lives in
docs/README.md, in three tracks so a reader picks one instead of reading
everything.

setup.md leads with the ELECTRON_RUN_AS_NODE trap because it fails silently
and costs hours. testing.md explains why so little is tested, since a
newcomer will otherwise read the gap as neglect rather than as the
deliberate choice build-plan.md records.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: The release checklist, scoped to what is decidable

`build-plan.md` §Testing references `docs/testing/release-checklist.md`, which does not exist.
This closes the gap for the items that can be written completely today. Three of its eventual
items depend on artefacts that will not exist until build steps 5 and 7 — a named, pinned,
well-seeded MP4 torrent and three pinned Nostr clients — and are recorded as scheduled
additions rather than written as placeholders.

Note the path: the plan uses `docs/development/release-checklist.md`, keeping all
contributor-facing material in one directory. Task 10 updates `build-plan.md`'s reference.

**Files:**
- Create: `docs/development/release-checklist.md`
- Modify: `docs/planning/build-plan.md` (the one path reference)

- [ ] **Step 1: Write the three decidable items**

Each needs a **precondition**, a **fixed input** and a **falsifiable assertion** — as prose in a
scope document they cannot be run identically twice, which is the whole reason this file exists.

1. **Telemetry first-run disclosure.** Precondition: a clean profile (`app.getPath('userData')`
   removed). Input: first launch. Assertions: the literal JSON that would be sent is displayed;
   there are exactly two buttons, visually equal weight; **neither is preselected**; and
   **nothing is transmitted before the choice is made** — verified by watching outbound requests,
   not by reading the code (`ADR-0004`).
2. **Launch with no keyring available.** Precondition: `--password-store=basic`. Input: normal
   launch, then create an identity. Assertion: the seed is **never written in plaintext**;
   `safeStorage.isEncryptionAvailable()` returning false produces the documented fallback and a
   visible statement to the user, not a silent downgrade (`security-model.md`).
3. **Run-from-source on Windows and macOS.** Precondition: a clean checkout, no build tools
   installed. Input: `git clone`, `npm install`, `npm start`. Assertions: `npm install`
   completes **without invoking a compiler**, a window appears, and telemetry works identically
   to Linux. This is the supported path most likely to break silently, because nothing in CI
   exercises it.

- [ ] **Step 2: Record the scheduled additions**

A short section stating exactly what gets added and when, so this is a known-partial document
rather than a forgotten one:

- **Journey 1 (the clip)** — added at build step 5. Needs a *named, pinned, well-seeded MP4
  torrent*; "a magnet link" makes pass/fail track that day's swarm health instead of the code.
- **Journey 3 (the identity)** — added at build step 7. Needs *three Nostr clients pinned at a
  version*, asserting the displayed npub is **byte-identical across two of them** — the check
  that would have caught the per-origin-key contradiction (`open-questions.md` B4).
- **Journey 2 (the app from a URL)** — added at build step 4.

- [ ] **Step 3: Fix the stale reference in `build-plan.md`**

Change `docs/testing/release-checklist.md` to `docs/development/release-checklist.md`. Verify:

```bash
grep -rn "docs/testing" docs/ CLAUDE.md
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add docs/development/release-checklist.md docs/planning/build-plan.md
git commit -m "$(cat <<'EOF'
Release checklist: the three items decidable today

build-plan.md referenced docs/testing/release-checklist.md, which never
existed. Written now for the three items that can be stated completely --
the telemetry first-run screen, launch with no keyring, and
run-from-source on Windows and macOS -- each with a precondition, a fixed
input and a falsifiable assertion, so it can be run identically twice.

The three journey items depend on artefacts that do not exist until build
steps 4, 5 and 7 (a pinned MP4 torrent, three pinned Nostr clients).
Recorded as scheduled additions rather than written as placeholders.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: The human entry path

The tasks above built the structure; this one describes it. Written in this order deliberately —
a README describing a layout that already exists is accurate, one describing an intended layout
is a wish.

**Files:**
- Create: `LICENSE`, `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: the repository's front door. Task 11 publishes it.

- [ ] **Step 1: Write `LICENSE`**

The verbatim Apache License 2.0 text. Do not paraphrase or abbreviate it — a modified licence
is not the licence. The copyright line is:

```
Copyright 2026 Davide Martinico
```

- [ ] **Step 2: Update `package.json`**

```json
  "license": "Apache-2.0",
  "repository": { "type": "git", "url": "git+https://github.com/OrivonBrowser/orivon-mvp.git" },
  "bugs": { "url": "https://github.com/OrivonBrowser/orivon-mvp/issues" },
  "homepage": "https://github.com/OrivonBrowser/orivon-mvp#readme",
```

`"private": true` **stays** — this is an application, not an npm package, and the flag only
prevents accidental `npm publish`. It has nothing to do with the repository being public.

- [ ] **Step 3: Write `README.md`**

Required sections, in this order. Total target: readable in five minutes.

1. **One-sentence definition**, then the thesis in a short paragraph: a browser that runs
   applications *impossible in Chrome* — reaching the network and filesystem under
   user-granted, per-app capabilities — while those applications are ordinary web frontends
   delivered from a URL.
2. **Status, honestly and near the top.** Pre-alpha. Build step 1 of 10 (the shell) is done.
   Nothing is packaged, nothing is released, and the capability broker — the actual product —
   is not written yet. A reader must not have to infer this.
3. **Quickstart:** `git clone`, `npm install`, `npm run dev`. Note that no compiler is needed,
   on any platform, and that this is deliberate.
4. **What makes it different**, in one short table: per-app capabilities declared in a manifest
   and granted by the user; apps delivered from a URL, never bundled; local-first storage with
   no Orivon server holding user data.
5. **The flagship**, in two sentences: BitTorrent streaming in a tab, no client installed, with
   the real grant prompt shown rather than hidden. Link `ADR-0001`.
6. **Where to go next** — three links: `ARCHITECTURE.md`, `docs/README.md`, `CONTRIBUTING.md`.
7. **Known limitations of v0**, stated rather than buried: MP4/H.264 only; swarm peers see the
   user's IP (no Tor); reduced seeding behind NAT (no UPnP); non-address input in the address
   bar goes to DuckDuckGo, so search text leaves the machine.
8. **Licence:** Apache-2.0.

Link out to `orivon-docs` for the long-term vision; **do not restate it** (`CLAUDE.md`
§Sources of truth).

- [ ] **Step 4: Write `ARCHITECTURE.md`**

The five-minute "how does this work". Required content:

1. **The one load-bearing idea.** The durable asset is the capability API (`orivon.*`), not the
   engine beneath it: Node broker now, Wasmtime later, Chromium/Mojo later, invisible to apps
   already written. That property — not Electron — is what keeps the Chromium path open
   (`ADR-0002`).
2. **The diagram**, as a fenced ASCII block:
   ```
   app (renderer, sandboxed)
        |  orivon.*                     <- the durable interface, src/contracts/
        v
   preload (isolated world)             <- contextBridge closures; the raw
        |  IPC + MessageChannelMain        MessagePortMain never crosses into
        v                                  the main world (T17)
   broker (main process)                <- authorisation: manifest, grants,
        |                                  per-origin enforcement
        v
   OS (sockets, filesystem, keychain)
   ```
3. **Directory map** — a table of every top-level directory and its one-line purpose, matching
   the boundary READMEs from Task 5. Mark `spike/` explicitly as historical evidence.
4. **What survives a Chromium fork and what is knowingly disposable** (`CLAUDE.md` Rule 5):
   `src/contracts/` and the broker's policy functions survive; the Electron shell, the preload
   bridging and `orivon-node-shim` are disposable.
5. **Two facts that will otherwise be rediscovered painfully**, each in a sentence with a link:
   transferable `ArrayBuffer`s renderer→main silently never arrive (`electron#34905`), so
   structured clone is the only mechanism and every reply-carrying message needs a timeout; and
   webtorrent's `browser` field maps `net`/`bittorrent-dht`/`utp` to `false`, so a naive
   renderer bundle is WebRTC-only, which is Brave parity and the exact thing `ADR-0001` exists
   to beat.

- [ ] **Step 5: Write `CONTRIBUTING.md`**

1. **Setup** — link `docs/development/setup.md`, do not duplicate it.
2. **The eight rules**, copied from `CLAUDE.md` with their reasons. Rule 8 (pure-JS
   dependencies) and the TypeScript-only rule (`ADR-0002`) are the two a newcomer breaks first.
3. **Before you open a PR:** `npm run typecheck && npm test && npm run check:natives && npm run check:contracts`,
   and `npm run smoke` if anything under `src/main/` changed.
4. **Working in parallel** — link `docs/development/parallel-work.md`. State the lockfile rule
   here too; it is the one thing worth duplicating.
5. **PR body format** — goal, paths touched, contracts depended on, how it was verified.
6. **Writing an ADR** — when (a load-bearing choice reversible only at cost), and how
   (`docs/decisions/ADR-0000-template.md`, monotonically numbered, never renumbered).
7. **Commit style** — imperative subject, a body explaining *why*, matching the existing log.
8. **A note on the AI-assisted workflow**, stated plainly rather than hidden: much of this
   repository was written with Claude Code, `CLAUDE.md` is its instruction file, and none of
   that is required to contribute. The human docs are the contract.

- [ ] **Step 6: Write `SECURITY.md` and `CODE_OF_CONDUCT.md`**

`SECURITY.md`: how to report (a private channel — GitHub private vulnerability reporting, plus
an email address the owner supplies), what is in scope (the broker's authorisation logic is the
crown jewel; `docs/architecture/security-model.md` lists the threat model), expected response
time, and an explicit statement that **the MVP's security model is authorisation, not
containment** — a granted capability is genuinely granted, and that is stated openly rather than
papered over.

> **Owner input needed:** the security contact address. Leave a clearly-marked line for it and
> raise it rather than inventing one.

`CODE_OF_CONDUCT.md`: Contributor Covenant 2.1, verbatim, with the same contact address.

- [ ] **Step 7: Write `CHANGELOG.md`**

Keep a Changelog format. One `## [Unreleased]` section with what has actually landed: the
week-0 spike resolved, build step 1 (the shell) complete, the contracts package, and the
parallel-work system. No version has been released, and the file must say so.

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test && npm run check:natives && npm run check:contracts && npm run build`
Expected: all PASS.

Then the link check from Task 7 Step 4, widened to the new root files:

```bash
grep -rhoE '\]\([^)#][^)]*\)' README.md ARCHITECTURE.md CONTRIBUTING.md docs/README.md \
  | sed -E 's/^\]\(//; s/\)$//' | sort -u \
  | while read -r p; do [ -e "$p" ] || echo "BROKEN: $p"; done
```
Expected: no output.

- [ ] **Step 9: Run the readability check — this is a gate, not a formality**

Hand the owner **`README.md` and `ARCHITECTURE.md`**, with exactly one question:

> Read these cold. Where is the first place you got lost, or had to guess?

Everything after the first confusion point is unreliable, because the reader is already lost —
so fix that point, and only then ask about what follows. Record the date, the artefact, the
confusion point and the fix in `docs/development/readability-log.md`. **Do not proceed to
Task 10 until this has been run and its fixes applied.**

- [ ] **Step 10: Commit**

```bash
git add LICENSE README.md ARCHITECTURE.md CONTRIBUTING.md SECURITY.md \
        CODE_OF_CONDUCT.md CHANGELOG.md package.json docs/development/readability-log.md
git commit -m "$(cat <<'EOF'
The human entry path: README, ARCHITECTURE, CONTRIBUTING, LICENSE

Written after the structure exists rather than before, so they describe
what is actually there.

package.json said "UNLICENSED", which legally forbids the clone-and-npm-start
path build-plan.md treats as a supported platform strategy. Now Apache-2.0,
copyright Davide Martinico.

README states the status near the top -- pre-alpha, build step 1 of 10, the
broker not yet written -- because a reader should not have to infer it, and
lists v0's known limitations rather than burying them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Rewrite CLAUDE.md around the new structure

**Files:**
- Modify: `CLAUDE.md`

`CLAUDE.md` currently carries the reading order and the sources-of-truth table, which Task 7
moved to `docs/README.md`. Leaving both means two maps that will drift apart.

- [ ] **Step 1: Remove what moved**

Delete the §Sources of truth table and the numbered reading list from §Start here. Replace with
a short pointer: *the human documentation is the map — read `README.md`, `ARCHITECTURE.md` and
`docs/README.md` first; this file adds only what is specific to working here as an agent.*

Keep, unchanged: the phase pointer, the spike-resolved summary, the `ELECTRON_RUN_AS_NODE`
warning, the tooling table, the eight rules, the devlog capture instruction, and the
conventions.

- [ ] **Step 2: Add the two new standing rules**

**Parallel work.** Before starting any build step, read `docs/development/parallel-work.md`.
Work in a worktree on `stream/<name>`, stay inside your owned paths, never modify
`src/contracts/` in the same PR as an implementation, and append at the append points
(`src/main/subsystems.ts`) rather than editing shared logic.

**The readability check.** At the end of every build step, hand the owner exactly one artefact —
the document a newcomer would hit at that point — and ask *"where is the first place you got
lost, or had to guess?"* Not "is this good?", which reliably returns a useless answer. Record
the result in `docs/development/readability-log.md`. This is a standing policy from the owner,
2026-08-26, and it does not lapse.

- [ ] **Step 3: Update the phase pointer**

State the current position: the contracts package and the parallel-work system are done; build
step 2 (the broker) is next and is unblocked; `src/contracts/` is the interface it implements.

- [ ] **Step 4: Verify no dangling references**

```bash
grep -rn "docs/testing\|SS Sources of truth" CLAUDE.md docs/ || echo "clean"
```
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
CLAUDE.md: point at the human docs, add the two standing rules

The reading order and sources-of-truth table moved to docs/README.md in
the docs-index task. Keeping copies in both would guarantee they drift, so
this file now points at them and carries only what is agent-specific.

Adds the parallel-work protocol and the readability check, both standing
owner policies from 2026-08-26.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Publish to GitHub

**Blocked** until `gh` has `repo` and `workflow` scopes. See the spec's §Open items: `gh`
currently authenticates from `GITHUB_TOKEN` at `~/.bashrc:164`, a classic PAT scoped
`read:user` and `repo:status`. **`.github/workflows/ci.yml` is tracked, so the first push fails
without `workflow` scope.** While `GITHUB_TOKEN` is set in the environment, `gh auth login` and
`gh auth refresh` are both ignored.

**Files:** none. This task is entirely git and `gh` operations.

- [ ] **Step 1: Confirm the token can do the job**

```bash
gh auth status
```
Expected: scopes include `repo` and `workflow`. **If they do not, stop and tell the owner** —
pushing will fail partway and leave a half-published repository.

- [ ] **Step 2: Confirm the tree is clean and green**

```bash
git status --short
npm run typecheck && npm test && npm run check:natives && npm run check:contracts && npm run build
```
Expected: no uncommitted changes, all checks PASS. Do not publish a red tree; CI will run on the
first push and its result is the repository's first public signal.

- [ ] **Step 3: Confirm what is about to become public**

This is the irreversible step. Once pushed, it is public permanently, even if deleted later.

```bash
git ls-files | wc -l
git log --oneline | wc -l
```

Show the owner the count and confirm, one last time, that decision D1 stands: the full history
and the planning corpus — `readiness.md`, `audit-2026-08-25.md`, `mvp-scope.md`'s funnel
arithmetic, and `devlog/` — all become public.

- [ ] **Step 4: Create the repository and push**

```bash
gh repo create OrivonBrowser/orivon-mvp \
  --public \
  --source=. \
  --remote=origin \
  --description="A browser that runs applications impossible in Chrome, under user-granted per-app capabilities" \
  --push
```

- [ ] **Step 5: Verify CI is green on the first run**

```bash
gh run list --limit 1
gh run watch
```
Expected: the `check` job passes all six steps — `npm ci`, typecheck, unit tests, Rule 8 guard,
contracts guard, build. If `npm ci` fails on a fresh runner but works locally, the likely cause
is a `package-lock.json` out of sync with `package.json`; regenerate it, do not edit it.

- [ ] **Step 6: Protect `main`**

Decision D5 is only real if the branch enforces it:

```bash
gh api -X PUT repos/OrivonBrowser/orivon-mvp/branches/main/protection \
  -F "required_status_checks[strict]=true" \
  -F "required_status_checks[contexts][]=check" \
  -F "enforce_admins=false" \
  -F "required_pull_request_reviews[required_approving_review_count]=0" \
  -F "restrictions=null"
```

`enforce_admins=false` deliberately: the owner is the only maintainer and must be able to push a
fix directly if CI itself breaks.

> **Note:** the local branch is `master`. Either rename it to `main` before this step
> (`git branch -m master main`) or substitute `master` in the command above. Renaming is
> recommended — `main` is what a contributor will assume, and `CLAUDE.md` already records `main`
> as the PR target.

- [ ] **Step 7: Raise the two org-level questions**

Neither is decided (spec §Open items 2). Ask the owner, do not act unilaterally:

1. **Archive `orivon-browser` and `orivon-browser-v2`?** Someone landing on the org sees three
   similarly-named repositories and cannot tell which is alive, which defeats goal 1 before they
   reach this repository's README. `gh repo archive <name>` greys them out and marks them
   read-only.
2. **Set the org's pinned repositories** so `orivon-mvp` appears first.

- [ ] **Step 8: Record it**

Append one line to the current week's **Done / results** section of `devlog/journal.md`, per
`CLAUDE.md` §Devlog capture. Then:

```bash
git add devlog/journal.md && git commit -m "$(cat <<'EOF'
Devlog: the repo is public

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)" && git push
```

---

## Deferred, with reasons

Recorded so they are not silently forgotten, and not done because each fails a test in
`CLAUDE.md` Rule 7 (do not over-document trivia) or Rule 4 (absent from scope is out).

| Item | Why not now | Trigger to revisit |
|---|---|---|
| npm workspaces monorepo | Spec D4: costs a day of build-system rework to enforce a boundary four streams can hold by convention | Stream count exceeds ~6, or a boundary violation actually happens |
| A guard that parses the ownership map and asserts every listed path exists | Couples a test to a Markdown table's formatting; brittle for the amount it buys | The map goes stale and it is not noticed |
| Issue and PR templates | Useful with outside contributors, noise with one | The first outside contributor |
| Dependabot / Renovate | `build-plan.md` §Risks makes tracking Electron CVEs a real requirement, but automated PRs against a one-person repo mid-sprint are a distraction | Build step 10 (packaging), when a release exists to protect |
| Screenshot or clip in the README | The shell runs but there is nothing worth showing until the flagship works | Build step 5, when the clip exists |

---

## Self-review

**Spec coverage.** Every section of `repo-and-parallel-work-design.md` maps to a task:
Part A → Tasks 5, 7, 8, 9, 10. Part B → Tasks 1, 2, 3. Part C prevention → Tasks 4, 5, 6;
repair → Task 6. Part D → Tasks 6 and 9 Step 9, made durable in Task 10. D1/D2 → Task 11.
D3 → Task 9 Steps 1–2. D4 → the whole shape of Tasks 2–5. D5 → Task 11 Step 6. The spec's six
definition-of-done items are covered by, in order: Task 9 Step 9, Task 11 Step 5, Task 3 Step 7,
Task 6 Step 1, Task 6 Step 4, Task 9 Steps 1–2.

**Two deviations**, both recorded at the top of this plan with reasoning:
`electron.vite.config.ts` is annotated rather than restructured, and the release checklist
covers only currently-decidable items.

**Owner input still required**, and the tasks that need it: the security contact address
(Task 9 Step 6), the `gh` token scopes (Task 11, blocking), archiving the two dead repositories
(Task 11 Step 7), and `master` → `main` (Task 11 Step 6).

**Type consistency.** `checkContractsArePure` and `REQUIRED_CONTRACT_FILES` are named
identically in Tasks 1, 2 and 3. `Subsystem`, `SubsystemContext`, `SubsystemFailure`,
`runBeforeReady` and `runAfterReady` are named identically in Task 4's test, implementation and
`index.ts` rewiring. Contract type names in Task 3's Interfaces block match the exports declared
in Task 2's `index.ts`.
