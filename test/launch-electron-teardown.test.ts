// Unit coverage for launch-electron.mjs's teardown machinery -- the
// process-tree kill, the userDataDir removal, and the survivor check --
// written so every one of these can be proven WITHOUT a real Electron
// launch. That split matters here specifically: this lane
// (stream/test-01-launch-hygiene) does not hold the conductor's Electron
// launch token, and launching Electron incorrectly from a lane that is
// fixing launch-hygiene bugs is exactly how the owner's machine gets a new
// orphan (docs/development/unattended-run-protocol.md).
//
// Every test below spawns ordinary `node` child processes -- never
// `electron` -- to exercise collectProcessTree/killProcessTree's generic
// tree-walk against a real, small process tree, and wraps a plain node
// child in a minimal fake "app" (just `{ process(), close() }`, the only
// two members closeElectron actually calls) to exercise the full
// closeElectron path end to end. None of this opens a window, needs Xvfb,
// or can leave anything behind that this file does not itself clean up --
// each test kills its own spawned processes even where the function under
// test is expected to have already done so, as a backstop against a bug in
// the very code being tested leaking a process onto this machine.
//
// WHAT THIS FILE CANNOT PROVE, listed here because it is exactly the gap
// the PR body must repeat for the conductor: that a REAL Electron process
// (a) actually appears as a survivor to findLiveElectronPids when left
// alive, and (b) that the whole path behaves the same against Electron's
// real multi-process shape (GPU/zygote/renderer helpers) as it does
// against a single plain node child here. Both need a real launch to prove
// and are the conductor's to verify -- see this PR's body.
//
// Run directly, without pulling in the other (real-launch) files in this
// directory's vitest.e2e.config.ts: `npx vitest run --config
// test/vitest.e2e.config.ts test/launch-electron-teardown.test.ts`

import { describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hoisted (vitest runs vi.mock/vi.hoisted before every import below) so the
// mock is in place before launch-electron.mjs's own top-level `import {
// _electron as electron } from 'playwright'` resolves -- needed only by the
// C-12 regression test further down, which must prove launchElectron()
// cleans up after a failed launch WITHOUT ever spawning a real Electron
// process (this lane holds no launch token; see the file header above).
const { mockElectronLaunch } = vi.hoisted(() => ({ mockElectronLaunch: vi.fn() }))
vi.mock('playwright', () => ({ _electron: { launch: mockElectronLaunch } }))

import {
  APP_CLOSE_RACE_MS,
  assertNoElectronSurvivors,
  closeElectron,
  collectProcessTree,
  findLiveElectronPids,
  killProcessTree,
  launchElectron,
  registerLaunchForTeardown,
  resolveExePath,
  waitForPidExit
} from './launch-electron.mjs'

/** A pid nothing on this machine plausibly has -- Linux pid_max is well
 * under this even on a system tuned to its largest legal value. */
const IMPOSSIBLE_PID = 2 ** 30

/** A `--procRoot` pointing at nothing, to exercise every function's
 * no-/proc degrade path deterministically rather than relying on this CI
 * box happening to lack one (it won't -- this repo's CI and dev machine are
 * both Linux; the degrade path is for portability, not for here). */
const NO_PROC = join(tmpdir(), 'orivon-test-no-such-proc-root')

/** Spawns a plain, harmless `node` process that spawns exactly one child of
 * its own and idles both -- a real two-level process tree with no
 * Electron, no window, nothing that could paint on a display. Resolves
 * once the child has reported its own pid over stdout, so the caller has
 * both pids before doing anything else. Always killed by the caller. */
async function spawnNodeTree (): Promise<{ parent: ChildProcess, parentPid: number, childPid: number }> {
  const script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);" +
    "process.stdout.write(String(c.pid) + '\\n'); setInterval(() => {}, 1000)"
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  const parentPid = parent.pid
  if (parentPid === undefined) throw new Error('spawnNodeTree: parent reported no pid')
  const childPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('spawnNodeTree: child pid never arrived')), 5_000)
    parent.stdout?.on('data', (buffer: Buffer) => {
      const n = Number(buffer.toString().trim())
      if (Number.isInteger(n)) {
        clearTimeout(timer)
        resolve(n)
      }
    })
  })
  return { parent, parentPid, childPid }
}

/** True while the OS still has this pid, zombie or not -- the same check
 * waitForPidExit itself uses, kept independent here so a test asserting on
 * waitForPidExit's own behaviour is not just checking its output against
 * itself. */
function isAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Backstop cleanup: SIGKILL a pid if it happens to still be alive.
 * Harmless no-op (ESRCH swallowed) when the function under test already
 * did its job -- exists so a genuine bug in that function cannot leave a
 * process running on this machine after the test file exits. */
function forceKill (pid: number | undefined): void {
  if (pid === undefined) return
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

describe('launchElectron', () => {
  it('leaves no orivon-test-* directory behind when electron.launch itself rejects (C-12)', async () => {
    // electron.launch is fully mocked (see the vi.mock above) -- this never
    // spawns a real process, so it is safe to run without the conductor's
    // launch token. The rejection stands in for a missing out/ build, a bad
    // argument, or a missing binary, which is exactly what C-12 found live.
    mockElectronLaunch.mockRejectedValueOnce(new Error('injected: launch failure'))
    await expect(launchElectron({ appPath: 'unused-because-launch-is-mocked' }))
      .rejects.toThrow('injected: launch failure')
    expect(mockElectronLaunch).toHaveBeenCalledTimes(1)
    // The directory launchElectron created is only visible to us via the
    // args it handed to the (mocked) launch call -- it never got a chance
    // to return the directory any other way, since the launch itself is
    // what threw.
    const [{ args }] = mockElectronLaunch.mock.calls[0] as [{ args: string[] }]
    const userDataDirArg = args.find((arg) => arg.startsWith('--user-data-dir='))
    if (userDataDirArg === undefined) throw new Error('launchElectron did not pass --user-data-dir to electron.launch')
    const userDataDir = userDataDirArg.slice('--user-data-dir='.length)
    await expect(stat(userDataDir)).rejects.toThrow()
  })
})

describe('collectProcessTree', () => {
  it('finds a real child underneath its real parent', async () => {
    const { parent, parentPid, childPid } = await spawnNodeTree()
    try {
      const tree = await collectProcessTree(parentPid)
      expect(tree).toContain(parentPid)
      expect(tree).toContain(childPid)
    } finally {
      forceKill(childPid)
      forceKill(parentPid)
      parent.kill('SIGKILL')
    }
  })

  it('degrades to just the root pid when procRoot cannot be listed', async () => {
    const tree = await collectProcessTree(process.pid, { procRoot: NO_PROC })
    expect(tree).toEqual([process.pid])
  })

  it('returns nothing for an undefined root rather than throwing', async () => {
    expect(await collectProcessTree(undefined)).toEqual([])
  })
})

describe('killProcessTree', () => {
  it('SIGKILLs both the parent and the child it found', async () => {
    const { parent, parentPid, childPid } = await spawnNodeTree()
    try {
      await killProcessTree(parentPid)
      expect(await waitForPidExit(parentPid, 5_000)).toBe(true)
      expect(await waitForPidExit(childPid, 5_000)).toBe(true)
    } finally {
      forceKill(childPid)
      forceKill(parentPid)
      parent.kill('SIGKILL')
    }
  })

  it('killing an already-dead tree is a harmless no-op, not a throw', async () => {
    await expect(killProcessTree(IMPOSSIBLE_PID)).resolves.toEqual([IMPOSSIBLE_PID])
  })
})

describe('waitForPidExit', () => {
  it('resolves true once a real process actually exits', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const pid = child.pid
    if (pid === undefined) throw new Error('child reported no pid')
    await new Promise((resolve) => child.once('exit', resolve))
    expect(await waitForPidExit(pid, 2_000)).toBe(true)
  })

  it('resolves false if the deadline passes while the process is still alive', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const pid = child.pid
    if (pid === undefined) throw new Error('child reported no pid')
    try {
      expect(await waitForPidExit(pid, 200)).toBe(false)
      expect(isAlive(pid)).toBe(true)
    } finally {
      forceKill(pid)
    }
  })
})

describe('resolveExePath', () => {
  it('resolves this very test process to the real node binary', async () => {
    const [expected, actual] = await Promise.all([realpath(process.execPath), resolveExePath(process.pid)])
    expect(actual).toBe(expected)
  })

  it('returns undefined for a pid that does not exist', async () => {
    expect(await resolveExePath(IMPOSSIBLE_PID)).toBeUndefined()
  })
})

describe('findLiveElectronPids', () => {
  it('does not report this test process (a real, live pid, but not Electron)', async () => {
    expect(await findLiveElectronPids([process.pid])).toEqual([])
  })

  it('degrades to an empty, non-throwing result with no /proc to read', async () => {
    await expect(findLiveElectronPids([process.pid], { procRoot: NO_PROC })).resolves.toEqual([])
  })

  // What this file CANNOT prove (see the header): that a pid whose exe
  // really does resolve to node_modules/electron/dist/electron is reported
  // as a survivor. That needs a real Electron process, which this lane's
  // own unit tests deliberately never start -- the conductor's launch is
  // the only place that path gets exercised.
})

describe('closeElectron, against a fake app wrapping a real (non-Electron) process', () => {
  /** The two members closeElectron actually calls on `app` -- nothing
   * about a real ElectronApplication beyond that is needed to exercise
   * this function, which is the point: no playwright, no Electron, no
   * window. */
  function fakeApp (child: ChildProcess, { hangs }: { hangs: boolean }): { process: () => ChildProcess, close: () => Promise<void> } {
    return {
      process: () => child,
      close: async () => {
        if (hangs) await new Promise(() => {}) // never resolves, forcing the SIGKILL fallback
      }
    }
  }

  it('removes the temp profile dir and kills the process when close() resolves promptly', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const pid = child.pid
    if (pid === undefined) throw new Error('child reported no pid')
    const userDataDir = await mkdtemp(join(tmpdir(), 'orivon-test-'))
    const app = fakeApp(child, { hangs: false })
    registerLaunchForTeardown(app, { userDataDir })
    try {
      await closeElectron(app, { raceMs: APP_CLOSE_RACE_MS })
      expect(await waitForPidExit(pid, 2_000)).toBe(true)
      await expect(stat(userDataDir)).rejects.toThrow()
    } finally {
      forceKill(pid)
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('falls back to SIGKILL and still removes the temp dir when close() hangs', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const pid = child.pid
    if (pid === undefined) throw new Error('child reported no pid')
    const userDataDir = await mkdtemp(join(tmpdir(), 'orivon-test-'))
    const app = fakeApp(child, { hangs: true })
    registerLaunchForTeardown(app, { userDataDir })
    try {
      // A short race, not APP_CLOSE_RACE_MS's real 8s -- this test asserts
      // the FALLBACK behaves correctly, not how long the real ceiling is.
      await closeElectron(app, { raceMs: 200 })
      expect(await waitForPidExit(pid, 2_000)).toBe(true)
      await expect(stat(userDataDir)).rejects.toThrow()
    } finally {
      forceKill(pid)
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('still removes the temp dir when beforeClose itself throws', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const pid = child.pid
    if (pid === undefined) throw new Error('child reported no pid')
    const userDataDir = await mkdtemp(join(tmpdir(), 'orivon-test-'))
    const app = fakeApp(child, { hangs: false })
    registerLaunchForTeardown(app, { userDataDir })
    try {
      await closeElectron(app, {
        raceMs: 200,
        beforeClose: async () => { throw new Error('a graceful UI step failed') }
      })
      expect(await waitForPidExit(pid, 2_000)).toBe(true)
      await expect(stat(userDataDir)).rejects.toThrow()
    } finally {
      forceKill(pid)
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('still reaches SIGKILL and removes the temp dir, within budget, when beforeClose itself hangs (R6-02)', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const pid = child.pid
    if (pid === undefined) throw new Error('child reported no pid')
    const userDataDir = await mkdtemp(join(tmpdir(), 'orivon-test-'))
    // close() itself resolves promptly -- beforeClose is the only thing
    // hanging here, isolating the defect this test targets. Before the
    // R6-02 fix, an unbounded `await beforeClose(app)` never returns
    // control to closeElectron at all, so this test would time out rather
    // than fail an assertion -- that IS the regression.
    const app = fakeApp(child, { hangs: false })
    registerLaunchForTeardown(app, { userDataDir })
    const start = Date.now()
    try {
      await closeElectron(app, {
        raceMs: 200,
        beforeClose: async () => { await new Promise(() => {}) }
      })
      const elapsedMs = Date.now() - start
      // Bounded by beforeClose's own raceMs (200ms), not left to whatever
      // waitForPidExit's default ceiling (5s) alone would allow -- proves
      // this settles quickly rather than merely "eventually".
      expect(elapsedMs).toBeLessThan(4_000)
      expect(await waitForPidExit(pid, 2_000)).toBe(true)
      await expect(stat(userDataDir)).rejects.toThrow()
    } finally {
      forceKill(pid)
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('kills every pid in a real tree, not just the root, when close() hangs', async () => {
    const { parent, parentPid, childPid } = await spawnNodeTree()
    const userDataDir = await mkdtemp(join(tmpdir(), 'orivon-test-'))
    const app = fakeApp(parent, { hangs: true })
    registerLaunchForTeardown(app, { userDataDir })
    try {
      await closeElectron(app, { raceMs: 200 })
      expect(await waitForPidExit(parentPid, 2_000)).toBe(true)
      expect(await waitForPidExit(childPid, 2_000)).toBe(true)
    } finally {
      forceKill(childPid)
      forceKill(parentPid)
      await rm(userDataDir, { recursive: true, force: true })
    }
  })
})

describe('assertNoElectronSurvivors', () => {
  it('reports clean after closeElectron has torn down every registered launch', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const pid = child.pid
    if (pid === undefined) throw new Error('child reported no pid')
    const userDataDir = await mkdtemp(join(tmpdir(), 'orivon-test-'))
    const app = { process: () => child, close: async (): Promise<void> => { child.kill() } }
    registerLaunchForTeardown(app, { userDataDir })
    try {
      await closeElectron(app, { raceMs: APP_CLOSE_RACE_MS })
      // Not Electron even while alive, so this is really exercising "the
      // set gets cleared and the function runs to completion", not the
      // true-positive match path (see findLiveElectronPids's own header).
      expect(await assertNoElectronSurvivors()).toEqual([])
    } finally {
      forceKill(pid)
      await rm(userDataDir, { recursive: true, force: true })
    }
  })
})
