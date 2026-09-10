// Shared launcher for every Electron-driving test/smoke script in this repo.
//
// WHY THIS EXISTS -- read before "simplifying" it away.
//
// This machine has ELECTRON_RUN_AS_NODE=1 set in the ambient environment. That
// variable makes the Electron binary behave as plain Node: no windows, no
// `require('electron')`, and critically NO MessagePortMain. Under that
// variable Electron-driving code does not fail loudly -- it fails in ways
// that look like unrelated bugs, and the whole point of a smoke/e2e run is to
// produce a trustworthy result.
//
// It cost roughly an hour during the week-0 spike (2026-08-25), and the
// misleading symptom was a module-format error that had nothing to do with
// module formats. So the variable is stripped here and the launch asserts it
// really is Electron.
//
// Ported verbatim from spike/launch.mjs (build step 1, 2026-08-26) -- this is
// the load-bearing bit that must survive spike/ being deleted. See
// .claude/skills/orivon-electron/SKILL.md for the full incident writeup.
import { _electron as electron } from 'playwright'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The minimal shape registerLaunchForTeardown/closeElectron actually call --
 * `process()` and `close()`, nothing else a real `ElectronApplication` has.
 * Named as its own typedef, rather than importing playwright's own type, so
 * a unit test can hand these functions a plain wrapper around an ordinary
 * `node` child process (see ./launch-electron-teardown.test.ts) without
 * needing to fake the entire Playwright surface -- a real
 * `ElectronApplication` still satisfies this structurally, so every real
 * call site is unaffected.
 * @typedef {{ process: () => import('node:child_process').ChildProcess, close: () => Promise<unknown> }} TeardownApp
 */

/** Environment variables that silently change what the binary IS. */
const POISON = ['ELECTRON_RUN_AS_NODE']

/**
 * Ceiling on any single Playwright ACTION (click, fill, press) started
 * through an app launched here.
 *
 * WHY IT IS SET AT ALL. Every action in this repo targets a local Electron
 * window and lands in milliseconds; nothing legitimately waits seconds. But an
 * action whose selector cannot match does not fail — it blocks. A smoke run
 * that blocks produces no JSON result and no failure list, which is precisely
 * the outcome `scripts/smoke.mjs` exists to rule out (its header, and
 * `scripts/README.md`: read the result, not the exit code). Ten seconds is far
 * above any real action here and far below "a human gave up and hit Ctrl-C".
 *
 * DOES NOT COVER `page.evaluate()` -- found 2026-08-28. This context option
 * only applies to Playwright's own action methods; `evaluate()` has no
 * timeout in this Playwright version regardless of this setting (confirmed
 * against the installed source: it passes `kNoTimeout` internally). Every
 * call site in this repo goes through `test/smoke-helpers.mjs`'s
 * `evaluateRetrying()`, which races the evaluate against its own deadline
 * explicitly for exactly this reason -- do not assume this constant covers
 * it.
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 10_000

/**
 * Ceiling on the graceful half of closeElectron()'s teardown race, below.
 * `_electron`'s own `app.close()` is documented (e2e-helpers.ts's
 * closeElectronApp) to hang indefinitely while any tab remains open --
 * this is how long to wait for the graceful path before falling back to
 * SIGKILL. The single canonical figure every e2e file's teardown budget
 * accounts for -- do not redeclare this constant locally in a test file.
 */
export const APP_CLOSE_RACE_MS = 8_000

/**
 * Per-launch bookkeeping a caller must not be trusted to remember itself
 * (this file's own header explains why: forgetting one launch's cleanup is
 * exactly the arrangement that leaked 105 MB overnight). Keyed by the
 * ElectronApplication object identity so closeElectron() below can always
 * find what launchElectron() created, with no argument the caller could
 * omit or get wrong.
 */
const USER_DATA_DIRS = new WeakMap()

/**
 * Every pid this module has ever been told is part of a launched app's
 * process tree, across every close performed in the calling file --
 * refreshed at close time with a fresh /proc scan (see closeElectron),
 * because most of these pids (Electron's own GPU/zygote/renderer helpers)
 * do not exist yet at launch time to record. assertNoElectronSurvivors()
 * is the self-check a suite runs against exactly this set, once, at the
 * very end of the file.
 */
const SEEN_PIDS = new Set()

/**
 * Registers a launch's teardown state -- called by launchElectron() for a
 * real launch, and directly by a unit test exercising closeElectron()
 * against a fake app with no real launchElectron() call behind it (see
 * ./launch-electron-teardown.test.ts).
 *
 * @param {TeardownApp} app
 * @param {{ userDataDir?: string }} [state]
 */
export function registerLaunchForTeardown (app, { userDataDir } = {}) {
  if (userDataDir !== undefined) USER_DATA_DIRS.set(app, userDataDir)
  const pid = app.process().pid
  if (pid !== undefined) SEEN_PIDS.add(pid)
}

/**
 * @param {object} [options]
 * @param {string} [options.appPath] Directory of the app to run. Defaults to
 *   the repo root (the real app); tests may pass a fixture directory.
 * @param {string[]} [options.args] Extra argv for the Electron process.
 * @param {number} [options.defaultTimeoutMs] Ceiling on any single Playwright
 *   action. See DEFAULT_ACTION_TIMEOUT_MS — raise it deliberately or not at all.
 * @returns {Promise<import('playwright').ElectronApplication>} Launched
 *   against a fresh, unique --user-data-dir -- never this machine's real
 *   `orivon` profile. See the userDataDir comment below.
 */
export async function launchElectron ({
  appPath = '.',
  args = [],
  defaultTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS
} = {}) {
  const env = { ...process.env }
  const stripped = []
  for (const key of POISON) {
    if (env[key] !== undefined) {
      delete env[key]
      stripped.push(key)
    }
  }
  if (stripped.length > 0) {
    console.log(`[launch] stripped from env: ${stripped.join(', ')}`)
  }

  // BUG (found 2026-09-01, real regression): with no --user-data-dir, Electron
  // defaults to this machine's actual `orivon` profile directory
  // (app.getPath('userData'), ~/.config/orivon on Linux) -- the SAME one a
  // real `npm run dev` writes to. HERMETIC_RESOLVER (scripts/smoke.mjs)
  // blackholes the network, but nothing blackholed disk state: a leftover
  // bookmarks.json from an earlier manual run silently added a second tile
  // to the dashboard's bookmarks grid, which `page.click('#bookmarks-grid
  // .tile')` (a plain CSS selector, not a strict Locator) clicked instead of
  // the fixture the test just starred -- confirmed by reading that file's
  // actual contents on this machine. A fresh, unique directory per launch is
  // what "hermetic by construction" (this file's own header, and
  // smoke.mjs's) already promised for the network; it never covered disk.
  const userDataDir = await mkdtemp(join(tmpdir(), 'orivon-test-'))
  const app = await electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`, ...args],
    env
  })

  // Tied to the launch itself, not left for the caller to remember --
  // closeElectron() below is what actually removes userDataDir and kills
  // the process tree, and it can only do that if it knows this launch
  // exists. Registered before the isReal check below so even a launch that
  // turns out not to be real Electron still gets torn down through the
  // same path, instead of the bare `app.close()` this file used to call
  // there (which never removed userDataDir on that path either).
  registerLaunchForTeardown(app, { userDataDir })

  // Applies to every page this app produces, including tab views created
  // later. Without it a click on a selector that cannot match blocks instead
  // of failing — see DEFAULT_ACTION_TIMEOUT_MS.
  app.context().setDefaultTimeout(defaultTimeoutMs)

  // Forward MAIN-process stdout/stderr. Without this, console output from the
  // main process is swallowed -- Playwright captures the child's streams and
  // does not relay them -- so a run can look silent when the main side is
  // talking.
  app.process().stdout?.on('data', (d) => process.stderr.write(`[main] ${d}`))
  app.process().stderr?.on('data', (d) => process.stderr.write(`[main] ${d}`))

  // Assert we got Electron, not Node wearing its binary. If this throws, no
  // result from this run may be trusted.
  const isReal = await app.evaluate(async ({ app: electronApp, MessageChannelMain }) => {
    return typeof electronApp?.getVersion === 'function' &&
           typeof MessageChannelMain === 'function'
  })
  if (isReal !== true) {
    await closeElectron(app)
    throw new Error(
      'Launched binary is not a real Electron main process ' +
      '(no app.getVersion or no MessageChannelMain). Refusing to trust this run.'
    )
  }

  return app
}

/** Root of the OS process-info pseudo-filesystem, overridable so a unit
 * test can point the tree-walk and exe-resolution logic below at a fixture
 * directory instead of the real, Linux-only /proc. */
const DEFAULT_PROC_ROOT = '/proc'

async function readPpid (pid, procRoot) {
  try {
    const status = await readFile(join(procRoot, String(pid), 'status'), 'utf8')
    const match = /^PPid:\s*(\d+)/m.exec(status)
    return match?.[1] === undefined ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

/**
 * Every pid in `rootPid`'s own process subtree, `rootPid` itself included --
 * read fresh from procRoot rather than trusted from what launchElectron
 * originally spawned, because Electron forks its own GPU/zygote/renderer
 * helper processes well after launch, none of which exist yet at launch
 * time to record.
 *
 * Degrades to `[rootPid]` alone when procRoot cannot be listed at all (a
 * non-Linux host, or a fixture path in a test) -- still lets the caller act
 * on the one pid it definitely holds a handle to, rather than throwing.
 *
 * @param {number | undefined} rootPid
 * @param {{ procRoot?: string }} [options]
 * @returns {Promise<number[]>}
 */
export async function collectProcessTree (rootPid, { procRoot = DEFAULT_PROC_ROOT } = {}) {
  if (rootPid === undefined) return []
  let entries
  try {
    entries = await readdir(procRoot)
  } catch {
    return [rootPid]
  }
  const pids = entries.filter((entry) => /^\d+$/.test(entry)).map(Number)
  const ppidOf = new Map(await Promise.all(pids.map(async (pid) => [pid, await readPpid(pid, procRoot)])))
  // A fixpoint, not a single pass keyed on readdir's order: /proc lists pids
  // in no guaranteed order, so a child can appear before the parent that
  // would have qualified it on the first pass.
  const tree = new Set([rootPid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, ppid] of ppidOf) {
      if (ppid !== undefined && tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid)
        grew = true
      }
    }
  }
  return [...tree]
}

/**
 * SIGKILLs every pid in rootPid's current process tree (collectProcessTree,
 * above). An already-dead pid (ESRCH) is silently fine -- the goal is
 * "nothing survives", not "every individual kill call succeeded".
 *
 * @param {number | undefined} rootPid
 * @param {{ procRoot?: string, signal?: NodeJS.Signals }} [options]
 * @returns {Promise<number[]>} The pids this call attempted to kill.
 */
export async function killProcessTree (rootPid, { procRoot = DEFAULT_PROC_ROOT, signal = 'SIGKILL' } = {}) {
  const pids = await collectProcessTree(rootPid, { procRoot })
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone -- that is the goal, not a failure.
    }
  }
  return pids
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Polls until `pid` is gone or `timeoutMs` passes. Node auto-reaps a child
 * it spawned directly as soon as SIGKILL lands (the 'exit' event firing IS
 * that reap); for the rest of the tree (Electron's own helper processes,
 * never a direct child of THIS process) reaping is whichever process
 * inherits them -- their own parent if still alive, or init/systemd after
 * a reparent -- so this is confirmation the pid is gone, not an action that
 * makes it so.
 *
 * @param {number | undefined} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} false if `pid` was still alive at the deadline.
 */
export async function waitForPidExit (pid, timeoutMs = 5_000) {
  if (pid === undefined) return true
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

/**
 * The real path of the binary backing a running pid, or undefined if it
 * cannot be read (the process already exited, or -- on a non-Linux host --
 * procRoot does not exist at all).
 *
 * Resolving this, rather than trusting a command-line string, is the whole
 * point (docs/development/unattended-run-protocol.md, the survivor-check
 * section): `pgrep -f node_modules/electron/dist/electron` also matches
 * whatever process is doing the matching, because that exact string sits in
 * ITS OWN argv too -- a false positive that costs a session hunting for a
 * leak that was never there.
 *
 * @param {number} pid
 * @param {{ procRoot?: string }} [options]
 * @returns {Promise<string | undefined>}
 */
export async function resolveExePath (pid, { procRoot = DEFAULT_PROC_ROOT } = {}) {
  try {
    return await realpath(join(procRoot, String(pid), 'exe'))
  } catch {
    return undefined
  }
}

let electronBinaryRealPath

async function getElectronBinaryRealPath () {
  if (electronBinaryRealPath === undefined) {
    const { default: electronPath } = await import('electron')
    electronBinaryRealPath = await realpath(electronPath)
  }
  return electronBinaryRealPath
}

/**
 * Which of `pids` are still a real, live Electron process -- decided by
 * resolving /proc/<pid>/exe and comparing it to THIS install's actual
 * Electron binary (the same one `import('electron')` resolves to), never by
 * matching a command-line string (resolveExePath's own header explains why
 * that trap matters).
 *
 * Returns `[]` without checking anything on a host with no /proc, logging
 * why -- there is no reliable way to answer this question there, and a
 * caller silently guessing would be worse than one told plainly "not
 * checked on this platform" (this repo's CI and dev machine are both
 * Linux, so this is a graceful degrade for portability, not a gap here).
 *
 * @param {number[]} pids
 * @param {{ procRoot?: string }} [options]
 * @returns {Promise<number[]>}
 */
export async function findLiveElectronPids (pids, { procRoot = DEFAULT_PROC_ROOT } = {}) {
  try {
    await readdir(procRoot)
  } catch {
    console.error(`[survivor-check] ${procRoot} is not readable on this platform -- skipping (Linux-only check)`)
    return []
  }
  const electronPath = await getElectronBinaryRealPath()
  const survivors = []
  for (const pid of pids) {
    if ((await resolveExePath(pid, { procRoot })) === electronPath) survivors.push(pid)
  }
  return survivors
}

async function removeUserDataDirFor (app) {
  const dir = USER_DATA_DIRS.get(app)
  if (dir === undefined) return
  USER_DATA_DIRS.delete(app)
  await rm(dir, { recursive: true, force: true }).catch((error) => {
    console.error(`[closeElectron] failed to remove ${dir}:`, error)
  })
}

/**
 * The one teardown path every e2e file shares (docs/development/
 * code-guidelines.md Rule 3 -- this used to be reimplemented, slightly
 * differently, in four separate finally blocks). Always: runs
 * `beforeClose` (a caller's own graceful UI steps, e.g. closing tabs before
 * `app.close()` -- see e2e-helpers.ts's closeElectronApp), races
 * `app.close()` against `raceMs`, then UNCONDITIONALLY SIGKILLs whatever is
 * left of the process tree and waits for the root pid to be reaped --
 * killing an already-dead tree is a harmless no-op (ESRCH, swallowed in
 * killProcessTree), so there is no reason to branch on whether the graceful
 * path already worked. The temp `--user-data-dir` is always removed in a
 * `finally`, so a thrown `beforeClose` or a hung `app.close()` still leaves
 * nothing behind on disk.
 *
 * @param {TeardownApp} app
 * @param {{ raceMs?: number, beforeClose?: (app: TeardownApp) => Promise<void> }} [options]
 * @returns {Promise<void>}
 */
export async function closeElectron (app, { raceMs = APP_CLOSE_RACE_MS, beforeClose } = {}) {
  const pid = app.process().pid
  try {
    if (typeof beforeClose === 'function') {
      await beforeClose(app).catch((error) => {
        console.error('[closeElectron] beforeClose step threw; tearing down anyway:', error)
      })
    }
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), raceMs))
    ]).catch(() => false)
    if (!closed) {
      console.error(`[closeElectron] app.close() did not settle within ${raceMs}ms -- killing the process tree`)
    }
    const treePids = await killProcessTree(pid)
    for (const treePid of treePids) SEEN_PIDS.add(treePid)
    if (!(await waitForPidExit(pid))) {
      console.error(`[closeElectron] pid ${pid} still reported alive after SIGKILL and a 5s wait`)
    }
  } finally {
    await removeUserDataDirFor(app)
  }
}

/**
 * The suite-level self-check (docs/development/unattended-run-protocol.md's
 * survivor-check section): fails loudly if any pid this file has EVER
 * closeElectron()'d is still a live Electron process. Deliberately scoped
 * to the pids THIS FILE spawned, not "is Electron running anywhere on this
 * machine" -- a developer's own desktop can legitimately have unrelated
 * Electron processes open, and a global-count assertion would fail for a
 * reason that has nothing to do with this suite's own hygiene.
 *
 * Call once, in a file-level `afterAll`, after every `it` has torn its own
 * app down.
 *
 * @returns {Promise<number[]>} Any surviving pids -- expect this to be `[]`.
 */
export async function assertNoElectronSurvivors () {
  const pids = [...SEEN_PIDS]
  const survivors = await findLiveElectronPids(pids)
  SEEN_PIDS.clear()
  return survivors
}
