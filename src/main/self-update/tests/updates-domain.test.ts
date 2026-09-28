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
})
