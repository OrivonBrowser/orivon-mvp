import { describe, expect, it } from 'vitest'
import { buildPayload } from '../report-payload.js'
import { reportMarkdown } from '../report-text.js'
import { CHOICES, sources } from './report-fixtures.js'

describe('reportMarkdown', () => {
  const text = reportMarkdown(buildPayload(sources()))

  it('carries the description, the crash, the stack and the diagnostics', () => {
    expect(text).toContain('**Orivon 0.1.0**')
    expect(text).toContain('## What happened\n\nIt crashed.')
    expect(text).toContain('renderer in tab at 2026-10-07T11:00:00Z: crashed, exit code 133')
    expect(text).toContain('<summary>Stack</summary>')
    expect(text).toContain('"commit": "abcdef012345"')
    expect(text).toContain('<summary>Recent log (2 lines)</summary>')
  })

  it('leaves out the contact address and the dump', () => {
    expect(text).not.toContain('ann@example.org')
    expect(text).not.toContain('AAECAw==')
    expect(text).not.toContain('bytes of binary')
  })

  it('omits what was not chosen', () => {
    const bare = reportMarkdown(buildPayload(sources({ crash: undefined, choices: { ...CHOICES, crashId: null, diagnostics: false, log: false, page: false, dump: false } })))
    expect(bare).toBe('**Orivon 0.1.0**\n\n## What happened\n\nIt crashed.\n')
  })

  it('cannot be broken out of by backticks in the text', () => {
    const tricky = reportMarkdown(buildPayload(sources({ log: ['```', 'after'] })))
    expect(tricky).toContain('````\n')
  })
})
