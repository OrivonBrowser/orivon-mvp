import { describe, expect, it, vi } from 'vitest'
import { inlineSegments } from '../about/inline-markdown.js'
import { about } from '../settings/sections/about.js'
import type { Row } from '../settings/model.js'
import type { SettingsState } from '../settings/state.js'

describe('a changelog line', () => {
  it('is cut into text, bold and code', () => {
    expect(inlineSegments('**Secure DNS**: site names go to `Quad9` first.')).toEqual([
      { kind: 'bold', text: 'Secure DNS' },
      { kind: 'text', text: ': site names go to ' },
      { kind: 'code', text: 'Quad9' },
      { kind: 'text', text: ' first.' }
    ])
  })

  it('keeps a link as its words and drops its address', () => {
    expect(inlineSegments('See [the guide](docs/guide.md) now')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'text', text: 'the guide' },
      { kind: 'text', text: ' now' }
    ])
  })

  it('leaves markup it does not know, and HTML, as plain text', () => {
    expect(inlineSegments('a <b>x</b> *y* **open')).toEqual([{ kind: 'text', text: 'a <b>x</b> *y* **open' }])
  })
})

describe('the Settings row for what is new', () => {
  const row = about.rows.find((candidate) => candidate.id === 'about-whats-new') as Row

  it('opens the About page at its What is new tab', async () => {
    const openPage = vi.fn(async () => {})
    if (row.control.type !== 'action') throw new Error('the row is an action')
    await row.control.run({ openPage } as unknown as SettingsState)
    expect(openPage).toHaveBeenCalledWith('about', '/whats-new')
  })
})
