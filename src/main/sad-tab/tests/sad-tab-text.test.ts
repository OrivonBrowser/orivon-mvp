import { describe, expect, it } from 'vitest'
import { textFor, UNRESPONSIVE_TEXT } from '../sad-tab-text.js'

const DEFAULT = 'Something went wrong while showing this page. Reloading usually fixes it.'
const MEMORY = 'This page ran out of memory. Closing other tabs may help.'

describe('what the card says', () => {
  it('gives every reason of render-process-gone its line', () => {
    const bodies: Record<string, string> = {
      crashed: DEFAULT,
      'abnormal-exit': DEFAULT,
      'launch-failed': DEFAULT,
      'integrity-failure': DEFAULT,
      oom: MEMORY,
      'memory-eviction': MEMORY,
      killed: "This page's process was ended."
    }
    for (const [reason, body] of Object.entries(bodies)) {
      expect(textFor(reason)).toEqual({ title: 'This page stopped working', body })
    }
  })

  it('falls back to the default for a reason it does not know, or none', () => {
    expect(textFor('a-reason-added-later').body).toBe(DEFAULT)
    expect(textFor(null).body).toBe(DEFAULT)
  })

  it('does not take an inherited property for a reason', () => {
    expect(textFor('constructor').body).toBe(DEFAULT)
    expect(textFor('__proto__').body).toBe(DEFAULT)
  })

  it('says a page that stopped answering can be waited for', () => {
    expect(UNRESPONSIVE_TEXT).toEqual({ title: "This page isn't responding", body: 'You can wait for it or reload it.' })
  })
})
