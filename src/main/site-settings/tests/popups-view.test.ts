import { describe, expect, it } from 'vitest'
import { asPopupsCommand, MAX_LISTED, popupsView } from '../popups-view.js'

describe('popupsView', () => {
  it('shows the host and the whole address of each blocked window, newest first as given', () => {
    const view = popupsView('https://news.example', ['https://ads.example/a?x=1', 'about:blank'], false, true)
    expect(view).toEqual({
      origin: 'https://news.example',
      rows: [{ host: 'ads.example', url: 'https://ads.example/a?x=1' }, { host: 'about:blank', url: 'about:blank' }],
      more: 0, allowed: false, settingsLink: true
    })
  })

  it('lists ten and counts the rest', () => {
    const urls = Array.from({ length: 14 }, (_, i) => `https://w${String(i)}.example/`)
    const view = popupsView('https://news.example', urls, true, false)
    expect(view.rows).toHaveLength(MAX_LISTED)
    expect(view.more).toBe(4)
    expect(view.allowed).toBe(true)
  })
})

describe('asPopupsCommand', () => {
  it('accepts the three shapes and nothing more', () => {
    expect(asPopupsCommand({ type: 'open', index: 0 })).toEqual({ type: 'open', index: 0 })
    expect(asPopupsCommand({ type: 'open', index: 9 })).toEqual({ type: 'open', index: 9 })
    expect(asPopupsCommand({ type: 'apply', allow: true })).toEqual({ type: 'apply', allow: true })
    expect(asPopupsCommand({ type: 'apply', allow: false })).toEqual({ type: 'apply', allow: false })
    expect(asPopupsCommand({ type: 'settings' })).toEqual({ type: 'settings' })
  })

  it.each([
    null, undefined, 'open', 3, [],
    { type: 'open' }, { type: 'open', index: -1 }, { type: 'open', index: 10 }, { type: 'open', index: 1.5 }, { type: 'open', index: '0' },
    { type: 'open', index: 0, url: 'https://evil.example/' },
    { type: 'apply' }, { type: 'apply', allow: 'yes' }, { type: 'apply', allow: true, origin: 'https://x.example' },
    { type: 'settings', extra: 1 }, { type: 'nope' }, {}
  ])('refuses %j', (command) => {
    expect(asPopupsCommand(command)).toBeUndefined()
  })
})
