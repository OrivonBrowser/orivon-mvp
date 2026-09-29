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

    await mkdir(join(root, 'profiles', 'abc'), { recursive: true })
    // The mkdir above is itself what should be seen (a root-level event);
    // this second write proves the retried, deeper watch on profiles/ is
    // ALSO now live, not just the root-level one.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const before = calls()
    await writeFile(join(root, 'profiles', 'abc', 'profile.json'), JSON.stringify({ name: 'New' }))

    expect(await waitForChange(() => calls() - before)).toBe(true)
  })

  it('fires when an existing profiles/ subdirectory changes', async () => {
    await mkdir(join(root, 'profiles', 'work'), { recursive: true })
    await writeFile(join(root, 'profiles', 'work', 'profile.json'), JSON.stringify({ name: 'Work' }))
    const { calls } = watching()

    await writeFile(join(root, 'profiles', 'work', 'profile.json'), JSON.stringify({ name: 'Renamed' }))

    expect(await waitForChange(calls)).toBe(true)
  })

  it('coalesces a burst of writes into far fewer calls than writes', async () => {
    const { calls } = watching()

    for (let i = 0; i < 10; i++) await writeFile(join(root, 'profile.json'), JSON.stringify({ name: `n${String(i)}` }))

    expect(await waitForChange(calls)).toBe(true)
    const afterBurst = calls()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(calls()).toBe(afterBurst) // settled: the burst did not keep scheduling forever
    expect(afterBurst).toBeLessThan(10)
  })

  it('never fires again once closed', async () => {
    const { watcher, calls } = watching()
    watcher.close()

    await writeFile(join(root, 'profile.json'), JSON.stringify({ name: 'After close' }))
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(calls()).toBe(0)
  })

  it('does not throw when the root does not exist yet', () => {
    const missing = join(root, 'not-made-yet')
    expect(() => {
      const watcher = watchProfiles(missing, () => {})
      opened.push(watcher)
    }).not.toThrow()
  })
})
