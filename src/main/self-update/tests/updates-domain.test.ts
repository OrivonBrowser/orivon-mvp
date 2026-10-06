import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { UpdateAnswer } from '../update-answer.js'
import { updatesDomain } from '../updates-domain.js'

const CALLER = {} as InternalCaller
const WINDOW = { id: 'w' } as unknown as ShellWindow
const NONE: UpdateAnswer = { reached: true, current: '1.0.0', latest: null, newer: false, url: null, canInstall: false, cannotInstallWhy: null, phase: 'idle', percent: null, failure: null }
const NEWER: UpdateAnswer = { ...NONE, latest: 'v1.1.0', newer: true, url: 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v1.1.0', canInstall: true }

function updates (answer: UpdateAnswer = NEWER, tag: string | null = answer.latest): { api: Parameters<typeof updatesDomain>[0], install: ReturnType<typeof vi.fn>, set: (next: UpdateAnswer) => void } {
  let current = answer
  const install = vi.fn(async () => ({ ok: true as const }))
  return {
    install,
    set: (next) => { current = next },
    api: { checkNow: vi.fn(async () => current), install, answer: () => current, foundTag: () => current === answer ? tag : current.latest }
  }
}

describe('the updates domain', () => {
  it('looks when asked and says what it found', async () => {
    const { api } = updates()
    expect(await updatesDomain(api, false).handle({ type: 'check' }, CALLER)).toEqual({ ok: true, answer: NEWER })
    expect(api.checkNow).toHaveBeenCalledTimes(1)
  })

  it('looks at nothing, and installs nothing, in a private session', async () => {
    const { api, install } = updates()
    const domain = updatesDomain(api, true)
    expect(await domain.handle({ type: 'check' }, CALLER)).toEqual({ ok: false, reason: 'private' })
    expect(await domain.handle({ type: 'install' }, CALLER)).toEqual({ ok: false, reason: 'private' })
    expect(api.checkNow).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('is for Settings only, and answers nothing else', async () => {
    const domain = updatesDomain(updates().api, false)
    expect(domain.pages).toEqual(['settings'])
    expect(await domain.handle({ type: 'download' }, CALLER)).toBeUndefined()
    expect(await domain.handle(null, CALLER)).toBeUndefined()
  })

  it('opens the page of the release main found, in the window that asked, naming no address', async () => {
    const open = vi.fn()
    const domain = updatesDomain(updates().api, false, open)
    expect(await domain.handle({ type: 'openRelease', url: 'https://evil.example/' }, CALLER)).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(CALLER, 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v1.1.0')
  })

  it('opens nothing before a release was found', async () => {
    const open = vi.fn()
    const { api } = updates(NONE, null)
    expect(await updatesDomain(api, false, open).handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: false, reason: 'none' })
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the list of releases, never an address taken from the answer, when the tag is not a version', async () => {
    const open = vi.fn()
    await updatesDomain(updates(NEWER, 'https://evil.example/').api, false, open).handle({ type: 'openRelease' }, CALLER)
    expect(open).toHaveBeenCalledWith(CALLER, 'https://github.com/OrivonBrowser/orivon-mvp/releases')
  })

  it('starts the install of the release main found, in the window that asked, whatever the page sends', async () => {
    const { api, install } = updates()
    const domain = updatesDomain(api, false, () => {}, () => WINDOW)
    expect(await domain.handle({ type: 'install', version: 'v9.9.9', url: 'https://evil.example/p' }, CALLER)).toEqual({ ok: true })
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith(WINDOW)
  })

  it('installs nothing when no release is on offer, or this copy cannot take it', async () => {
    const none = updates(NONE)
    expect(await updatesDomain(none.api, false).handle({ type: 'install' }, CALLER)).toEqual({ ok: false, reason: 'none' })
    const manual = updates({ ...NEWER, canInstall: false, cannotInstallWhy: 'source' })
    expect(await updatesDomain(manual.api, false).handle({ type: 'install' }, CALLER)).toEqual({ ok: false, reason: 'unavailable' })
    expect(none.install).not.toHaveBeenCalled()
    expect(manual.install).not.toHaveBeenCalled()
  })

  it('does not start a second install while one runs', async () => {
    const { api, install } = updates({ ...NEWER, phase: 'downloading', percent: 3 })
    expect(await updatesDomain(api, false).handle({ type: 'install' }, CALLER)).toEqual({ ok: true })
    expect(install).not.toHaveBeenCalled()
  })
})
