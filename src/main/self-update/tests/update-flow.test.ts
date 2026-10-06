import { describe, expect, it, vi } from 'vitest'
import { createUpdateFlow } from '../update-flow.js'
import type { FlowDeps, FlowState, Installability } from '../update-flow.js'
import type { ReleaseInfo } from '../update-check.js'

const FILE = { name: 'Orivon-1.2.0-x86_64.AppImage', size: 1000, sha256: 'a'.repeat(64) }
const RELEASE: ReleaseInfo = { version: 'v1.2.0', url: 'https://example.test/r' }
const ABLE: Installability = { ok: true, kind: 'appimage', file: FILE }

function setup (patch: Partial<FlowDeps> = {}, able: Installability = ABLE): { flow: ReturnType<typeof createUpdateFlow>, states: FlowState[], clock: { at: number } } {
  const states: FlowState[] = []
  const clock = { at: 0 }
  const flow = createUpdateFlow({
    installability: async () => able,
    download: async () => '/pending/file',
    install: async () => ({ ok: true }),
    changed: (state) => { states.push(state) },
    now: () => clock.at,
    ...patch
  })
  return { flow, states, clock }
}

describe('the update flow', () => {
  it('knows nothing is on offer, and refuses to install it', async () => {
    const { flow } = setup()
    expect(flow.release()).toBeNull()
    expect(await flow.install()).toMatchObject({ ok: false, why: 'none' })
  })

  it('works out whether this copy can take the release when it is offered', async () => {
    const { flow } = setup()
    await flow.offer(RELEASE)
    expect(flow.release()).toBe(RELEASE)
    expect(flow.installability()).toEqual(ABLE)
    await flow.offer(null)
    expect(flow.release()).toBeNull()
    expect(flow.installability()).toBeNull()
  })

  it('downloads the file the manifest lists for this copy, installs it, and ends with the install asked for', async () => {
    const download = vi.fn(async () => '/pending/file')
    const install = vi.fn(async () => ({ ok: true as const }))
    const { flow, states } = setup({ download, install })
    await flow.offer(RELEASE)
    expect(await flow.install()).toEqual({ ok: true })
    expect(download).toHaveBeenCalledWith('v1.2.0', FILE, expect.any(Function))
    expect(install).toHaveBeenCalledWith('appimage', '/pending/file')
    expect(states.map((state) => state.phase)).toEqual(['downloading', 'installing', 'restarting'])
  })

  it('refuses to install what this copy cannot take, and says why', async () => {
    const download = vi.fn()
    const { flow } = setup({ download }, { ok: false, why: 'This copy runs from its source folder, so it cannot replace itself.' })
    await flow.offer(RELEASE)
    expect(await flow.install()).toMatchObject({ ok: false, why: 'unavailable', reason: expect.stringContaining('source folder') })
    expect(download).not.toHaveBeenCalled()
  })

  it('moves the percentage at most every 500 ms, and always reports the end', async () => {
    const download: FlowDeps['download'] = async (_tag, _file, progress) => {
      for (const [at, received] of [[0, 10], [100, 100], [200, 200], [600, 300], [700, 400], [1200, 1000]] as const) {
        clock.at = at
        progress(received, 1000)
      }
      return '/pending/file'
    }
    const { flow, states, clock } = setup({ download })
    await flow.offer(RELEASE)
    await flow.install()
    expect(states.filter((state) => state.phase === 'downloading').map((state) => state.percent)).toEqual([0, 1, 30, 100])
  })

  it('fails with the download\'s own sentence, keeps the offer, and allows another try', async () => {
    let attempt = 0
    const { flow, states } = setup({ download: async () => { attempt += 1; if (attempt === 1) throw new Error('The download is larger than the release says, so it was thrown away.'); return '/p' } })
    await flow.offer(RELEASE)
    expect(await flow.install()).toEqual({ ok: false, why: 'failed', reason: 'The download is larger than the release says, so it was thrown away.', declined: false })
    expect(flow.state()).toEqual({ phase: 'failed', percent: null, failure: 'The download is larger than the release says, so it was thrown away.' })
    expect(flow.release()).toBe(RELEASE)
    expect(await flow.install()).toEqual({ ok: true })
    expect(states.at(-1)?.phase).toBe('restarting')
  })

  it('reports a refused install as such, and a failed one with its reason', async () => {
    const { flow } = setup({ install: async () => ({ ok: false, reason: 'You did not allow the installation.', declined: true }) })
    await flow.offer(RELEASE)
    expect(await flow.install()).toEqual({ ok: false, why: 'failed', reason: 'You did not allow the installation.', declined: true })
  })

  it('lets a second install join the one that runs, and does not change the offer meanwhile', async () => {
    let release!: () => void
    const download = vi.fn(async () => await new Promise<string>((resolve) => { release = () => { resolve('/p') } }))
    const { flow } = setup({ download })
    await flow.offer(RELEASE)
    const first = flow.install()
    const second = flow.install()
    await flow.offer(null)
    expect(flow.release()).toBe(RELEASE)
    release()
    expect(await first).toEqual(await second)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('says it is restarting once the install steps succeeded, and refuses another install meanwhile', async () => {
    const install = vi.fn(async () => ({ ok: true as const }))
    const { flow, states } = setup({ install })
    await flow.offer(RELEASE)
    expect(await flow.install()).toEqual({ ok: true })
    expect(flow.state().phase).toBe('restarting')
    expect(states.map((state) => state.phase)).toEqual(['downloading', 'installing', 'restarting'])
    expect(await flow.install()).toMatchObject({ ok: false, why: 'unavailable' })
    expect(install).toHaveBeenCalledTimes(1)
    await flow.offer(null)
    expect(flow.release()).toBe(RELEASE)
  })

  it('keeps the old release and its file together while installability of a new one is worked out', async () => {
    let finish!: (value: Installability) => void
    const download = vi.fn(async () => '/p')
    const second: ReleaseInfo = { version: 'v1.3.0', url: 'u' }
    const secondFile = { name: 'Orivon-1.3.0-x86_64.AppImage', size: 5, sha256: 'b'.repeat(64) }
    const { flow } = setup({
      download,
      installability: async (release) => release === second ? await new Promise<Installability>((resolve) => { finish = resolve }) : ABLE
    })
    await flow.offer(RELEASE)
    const offering = flow.offer(second)
    const installing = flow.install()
    finish({ ok: true, kind: 'appimage', file: secondFile })
    await offering
    await installing
    expect(download).toHaveBeenCalledWith('v1.2.0', FILE, expect.any(Function))
    expect(flow.release()).toBe(RELEASE)
  })

  it('takes the new release and its file together once both are known', async () => {
    const second: ReleaseInfo = { version: 'v1.3.0', url: 'u' }
    const secondFile = { name: 'Orivon-1.3.0-x86_64.AppImage', size: 5, sha256: 'b'.repeat(64) }
    const { flow } = setup({ installability: async (release) => release === second ? { ok: true, kind: 'appimage', file: secondFile } : ABLE })
    await flow.offer(RELEASE)
    await flow.offer(second)
    expect(flow.release()).toBe(second)
    expect(flow.installability()).toEqual({ ok: true, kind: 'appimage', file: secondFile })
  })

  it('clears a failure when a different release is offered, and keeps it for the same one', async () => {
    const { flow } = setup({ download: async () => { throw new Error('No.') } })
    await flow.offer(RELEASE)
    await flow.install()
    expect(flow.state().phase).toBe('failed')
    await flow.offer({ ...RELEASE })
    expect(flow.state().phase).toBe('failed')
    await flow.offer({ version: 'v1.3.0', url: 'u' })
    expect(flow.state().phase).toBe('idle')
  })

  it('clears a failure when the offer goes away', async () => {
    const { flow } = setup({ download: async () => { throw new Error('No.') } })
    await flow.offer(RELEASE)
    await flow.install()
    await flow.offer(null)
    expect(flow.state().phase).toBe('idle')
  })
})
