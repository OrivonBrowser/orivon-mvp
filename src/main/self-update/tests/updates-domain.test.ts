import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { updatesDomain } from '../updates-domain.js'

const CALLER = {} as InternalCaller
const ANSWER = { reached: true, current: '1.0.0', latest: 'v1.1.0', newer: true, url: 'https://github.com/x/y/releases/tag/v1.1.0' }

describe('the updates domain', () => {
  it('looks when asked and says what it found', async () => {
    const check = vi.fn(async () => ANSWER)
    expect(await updatesDomain(check, false).handle({ type: 'check' }, CALLER)).toEqual({ ok: true, answer: ANSWER })
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('looks at nothing in a private session', async () => {
    const check = vi.fn(async () => ANSWER)
    expect(await updatesDomain(check, true).handle({ type: 'check' }, CALLER)).toEqual({ ok: false, reason: 'private' })
    expect(check).not.toHaveBeenCalled()
  })

  it('is for Settings only, and answers nothing else', async () => {
    const domain = updatesDomain(async () => ANSWER, false)
    expect(domain.pages).toEqual(['settings'])
    expect(await domain.handle({ type: 'install' }, CALLER)).toBeUndefined()
    expect(await domain.handle(null, CALLER)).toBeUndefined()
  })

  it('opens the page of the release the last check found, in the window that asked', async () => {
    const open = vi.fn()
    const domain = updatesDomain(async () => ANSWER, false, () => {}, open)
    await domain.handle({ type: 'check' }, CALLER)
    expect(await domain.handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(CALLER, 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v1.1.0')
  })

  it('opens nothing before a check found a newer release, or after one found none', async () => {
    const open = vi.fn()
    let newer = true
    const domain = updatesDomain(async () => ({ ...ANSWER, newer }), false, () => {}, open)
    expect(await domain.handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: false, reason: 'none' })
    await domain.handle({ type: 'check' }, CALLER)
    newer = false
    await domain.handle({ type: 'check' }, CALLER)
    expect(await domain.handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: false, reason: 'none' })
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the list of releases, never an address taken from the answer, when the tag is not a version', async () => {
    const open = vi.fn()
    const domain = updatesDomain(async () => ({ ...ANSWER, latest: 'https://evil.example/', url: 'https://evil.example/' }), false, () => {}, open)
    await domain.handle({ type: 'check' }, CALLER)
    await domain.handle({ type: 'openRelease' }, CALLER)
    expect(open).toHaveBeenCalledWith(CALLER, 'https://github.com/OrivonBrowser/orivon-mvp/releases')
  })

  it('opens nothing in a private session', async () => {
    const open = vi.fn()
    expect(await updatesDomain(async () => ANSWER, true, () => {}, open).handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: false, reason: 'private' })
    expect(open).not.toHaveBeenCalled()
  })
})
