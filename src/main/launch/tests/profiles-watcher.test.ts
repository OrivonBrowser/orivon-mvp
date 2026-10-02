import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { watchProfiles } from '../profiles-watcher.js'
import type { ProfilesWatcher } from '../profiles-watcher.js'

let root: string
const opened: ProfilesWatcher[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orivon-profiles-watcher-'))
})

afterEach(async () => {
  for (const watcher of opened.splice(0)) watcher.close()
  await rm(root, { recursive: true, force: true })
})

/** Waits for `onChange` to have fired at least once, or for `ms` to pass without it -- a plain poll, since the debounce timer is real. */
async function waitForChange (calls: () => number, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (calls() > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/**
 * Waits until `calls()` has not changed for `quietMs`, or `ceilingMs` runs
 * out -- more tolerant than a fixed wait of a debounce timer that fires
 * later than usual under load: a burst that is still settling when a fixed
 * wait's clock runs out reads as "kept scheduling forever" even though it
 * was only running late.
 */
async function waitForSettled (calls: () => number, quietMs = 400, ceilingMs = 4000): Promise<number> {
  const deadline = Date.now() + ceilingMs
  let last = calls()
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30))
    const now = calls()
    if (now !== last) { last = now; quietSince = Date.now() }
    if (Date.now() - quietSince >= quietMs) return last
  }
  return last
}

/**
 * Writes `path` repeatedly, each time a distinct change, until `calls`
 * (relative to whatever it already was) moves or `ceilingMs` runs out --
 * for a directory whose own watch was JUST discovered and is set up
 * asynchronously (reconcilePerProfileWatches, run from the root-level
 * watch's own event), rather than a fixed wait guessing how long that setup
 * takes. A single write made before the watch exists is simply never seen;
 * retrying is what makes this reliable under load instead of assuming a
 * number of milliseconds that measured fine once.
 */
async function writeUntilSeen (path: string, calls: () => number, ceilingMs = 8000): Promise<boolean> {
  const before = calls()
  const deadline = Date.now() + ceilingMs
  while (Date.now() < deadline) {
    await writeFile(path, JSON.stringify({ name: `New-${String(Date.now())}-${String(Math.random())}` }))
    if (await waitForChange(() => calls() - before, 300)) return true
  }
  return false
}

function watching (): { watcher: ProfilesWatcher, calls: () => number } {
  let count = 0
  const watcher = watchProfiles(root, () => { count += 1 })
  opened.push(watcher)
  return { watcher, calls: () => count }
}

describe('watchProfiles', () => {
  it('fires when another process changes the default profile\'s own file at the root', async () => {
    const { calls } = watching()

    await writeFile(join(root, 'profile.json'), JSON.stringify({ name: 'Renamed' }))

    expect(await waitForChange(calls)).toBe(true)
  })

  it('fires when a profile made after the watch started changes, even though profiles/ did not exist yet', async () => {
    const { calls } = watching()

    // Synchronous, so profiles/ and profiles/abc both exist before the watcher is given a turn: the
    // watch on profiles/ then starts with abc already inside it and gets no event for it.
    mkdirSync(join(root, 'profiles', 'abc'), { recursive: true })
    expect(await waitForChange(calls)).toBe(true) // the mkdir itself, a root-level event

    // Proves the retried, deeper watch on profiles/abc is ALSO live, not
    // just the root-level one -- writeUntilSeen's own header on why this
    // retries the write instead of waiting a fixed amount first.
    expect(await writeUntilSeen(join(root, 'profiles', 'abc', 'profile.json'), calls)).toBe(true)
  // waitForChange (2 s) and writeUntilSeen (8 s) may both run to their own
  // ceilings on a loaded machine; the runner's 5 s default would end the test
  // before either had decided.
  }, 15_000)

  it('coalesces a burst of writes into far fewer calls than writes', async () => {
    const { calls } = watching()

    for (let i = 0; i < 10; i++) await writeFile(join(root, 'profile.json'), JSON.stringify({ name: `n${String(i)}` }))

    expect(await waitForChange(calls)).toBe(true)
    expect(await waitForSettled(calls)).toBeLessThan(10)
  })

  it('never fires again once closed', async () => {
    const { watcher, calls } = watching()
    watcher.close()

    await writeFile(join(root, 'profile.json'), JSON.stringify({ name: 'After close' }))
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(calls()).toBe(0)
  })

  it('never fires when a deep file changes under a profile\'s own cache directory', async () => {
    await mkdir(join(root, 'profiles', 'work', 'Cache', 'sub'), { recursive: true })
    await writeFile(join(root, 'profiles', 'work', 'profile.json'), JSON.stringify({ name: 'Work' }))
    const { calls } = watching()

    await writeFile(join(root, 'profiles', 'work', 'Cache', 'sub', 'entry'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(calls()).toBe(0)
  })

  it('never fires for an unrelated file at the root, such as settings.json', async () => {
    const { calls } = watching()

    await writeFile(join(root, 'settings.json'), '{}')
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(calls()).toBe(0)
  })

  it('fires once, debounced, for editing an existing profile\'s profile.json', async () => {
    await mkdir(join(root, 'profiles', 'work'), { recursive: true })
    await writeFile(join(root, 'profiles', 'work', 'profile.json'), JSON.stringify({ name: 'Work' }))
    const { calls } = watching()

    await writeFile(join(root, 'profiles', 'work', 'profile.json'), JSON.stringify({ name: 'Renamed' }))

    expect(await waitForChange(calls)).toBe(true)
    const afterFirst = calls()
    expect(await waitForSettled(calls)).toBe(afterFirst)
  })

  it('fires when a profile directory is added', async () => {
    const { calls } = watching()

    await mkdir(join(root, 'profiles', 'new-one'), { recursive: true })

    expect(await waitForChange(calls)).toBe(true)
  })

  it('a profile removed and a different one added later still gets its own watch', async () => {
    await mkdir(join(root, 'profiles', 'gone'), { recursive: true })
    await writeFile(join(root, 'profiles', 'gone', 'profile.json'), JSON.stringify({ name: 'Gone' }))
    const { calls } = watching()

    await rm(join(root, 'profiles', 'gone'), { recursive: true, force: true })
    expect(await waitForChange(calls)).toBe(true)

    const afterRemoval = calls()
    await mkdir(join(root, 'profiles', 'new-one'), { recursive: true })
    expect(await waitForChange(() => calls() - afterRemoval)).toBe(true)
    expect(await writeUntilSeen(join(root, 'profiles', 'new-one', 'profile.json'), calls)).toBe(true)
  })

  it('does not throw when the root does not exist yet', () => {
    const missing = join(root, 'not-made-yet')
    expect(() => {
      const watcher = watchProfiles(missing, () => {})
      opened.push(watcher)
    }).not.toThrow()
  })
})
