import { describe, expect, it } from 'vitest'
import { isPopupsView, moreText, withoutScheme } from '../view.js'

const row = { host: 'ads.example', url: 'https://ads.example/' }
const view = { origin: 'https://news.example', rows: [row], more: 0, allowed: false, settingsLink: true }

describe('isPopupsView', () => {
  it('accepts what main sends', () => {
    expect(isPopupsView(view)).toBe(true)
    expect(isPopupsView({ ...view, more: 4, allowed: true, settingsLink: false })).toBe(true)
  })

  it.each([
    null, undefined, 'x', [], {},
    { ...view, rows: [] }, { ...view, rows: [{ host: 'a' }] }, { ...view, rows: 'x' },
    { ...view, origin: 3 }, { ...view, allowed: 'no' }, { ...view, more: '2' }, { ...view, settingsLink: undefined }
  ])('refuses %j, so the bubble closes instead of drawing half a list', (value) => {
    expect(isPopupsView(value)).toBe(false)
  })
})

describe('moreText', () => {
  it('counts the addresses past the listed ones', () => {
    expect(moreText(4)).toBe('and 4 more')
  })
})

describe('withoutScheme', () => {
  it('shows the host and what follows it on one line', () => {
    expect(withoutScheme('http://127.0.0.1:35425/target?b')).toBe('127.0.0.1:35425/target?b')
    expect(withoutScheme('https://ads.example/')).toBe('ads.example/')
  })
})
