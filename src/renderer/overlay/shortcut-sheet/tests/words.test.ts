import { describe, expect, it } from 'vitest'
import { resultWords } from '../words.js'

describe('what the shortcut sheet says', () => {
  it('names where a shortcut went', () => {
    expect(resultWords({ ok: true, where: 'applications' })).toEqual({ tone: 'ok', text: 'Shortcut added to your applications menu.' })
    expect(resultWords({ ok: true, where: 'desktop' })).toEqual({ tone: 'ok', text: 'Shortcut added to your desktop.' })
  })

  it('says when shortcuts are not possible here, and when a write failed', () => {
    expect(resultWords({ ok: false, reason: 'unsupported' })).toEqual({ tone: 'error', text: 'Shortcuts are not available on this system.' })
    expect(resultWords({ ok: false, reason: 'failed' }).tone).toBe('error')
  })

  it('reads a reply that is not main\'s as a failure', () => {
    expect(resultWords(undefined).tone).toBe('error')
    expect(resultWords({ ok: 'yes' } as never).tone).toBe('error')
  })
})
