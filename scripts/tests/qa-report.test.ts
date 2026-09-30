import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QA_SPECS, specsFor, VISUAL_SPECS } from '../qa.mjs'
import { readReports, renderInspectSheet, VERDICTS } from '../qa-report.mjs'

const state = {
  name: 'menu-popup',
  expected: 'The main menu is open under the menu button.',
  action: 'Clicked the menu button.',
  views: [{ url: 'file:///x/index.html', title: 'Orivon', shown: true }, { url: 'file:///x/menu.html', title: 'Menu', shown: false }],
  audit: { findings: [{ rule: 'clipped-text', selector: 'span.title', detail: 'scrollHeight 14 > clientHeight 12' }], allowed: [{ rule: 'modal-placement', selector: 'div', detail: 'off centre', reason: 'on purpose' }] },
  errors: [{ kind: 'pageerror', url: 'file:///x/index.html', text: 'boom' }],
  blank: false,
  baseline: { status: 'mismatch', ratio: 0.0002, maxDiffRatio: 0.00005, diffPath: '/tmp/menu.diff.png' },
  png: '/tmp/menu.png'
}

describe('renderInspectSheet', () => {
  it('says so when there are no state records, instead of an empty sheet', () => {
    expect(renderInspectSheet([])).toContain('No state records were found')
  })

  it('gives a state its expectation, findings, errors, baseline and a blank verdict', () => {
    const sheet = renderInspectSheet([state])
    expect(sheet).toContain('## 1. menu-popup')
    expect(sheet).toContain('- Expected: The main menu is open under the menu button.')
    expect(sheet).toContain('clipped-text span.title: scrollHeight 14 > clientHeight 12')
    expect(sheet).toContain('modal-placement div: off centre (allowed: on purpose)')
    expect(sheet).toContain('pageerror file:///x/index.html: boom')
    expect(sheet).toContain('mismatch, 0.0200% of pixels differ (limit 0.0050%), diff at /tmp/menu.diff.png')
    expect(sheet).toMatch(/^- Verdict: $/m)
  })

  it('marks a hidden view and a window that painted nothing', () => {
    const sheet = renderInspectSheet([{ ...state, blank: true }])
    expect(sheet).toContain('file:///x/menu.html "Menu" (hidden)')
    expect(sheet).toContain('Window painted: NO')
  })

  it('reports a clean state as clean, not as an empty list', () => {
    const sheet = renderInspectSheet([{ ...state, audit: { findings: [], allowed: [] }, errors: [] }])
    expect(sheet).toContain('- Layout audit: clean')
    expect(sheet).toContain('- Shell errors since the last state: none')
  })

  it('appends the failure index, or says nothing failed', () => {
    expect(renderInspectSheet([state], '- [a test](x/summary.md): AssertionError')).toContain('- [a test](x/summary.md): AssertionError')
    expect(renderInspectSheet([state])).toContain('No spec failed in this run.')
  })

  it('lists every verdict a reader may give', () => {
    expect(VERDICTS).toEqual(['expected-variation', 'harmless', 'defect', 'functional-bug', 'needs-human-review'])
    for (const verdict of VERDICTS) expect(renderInspectSheet([])).toContain(verdict)
  })
})

describe('readReports', () => {
  it('reads every state record in name order and ignores other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-qa-report-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ name: 'b' }))
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ name: 'a' }))
    writeFileSync(join(dir, 'a.png'), 'not json')
    expect((await readReports(dir)).map((r: { name: string }) => r.name)).toEqual(['a', 'b'])
  })

  it('returns nothing for a directory that does not exist', async () => {
    expect(await readReports(join(tmpdir(), 'orivon-qa-no-such-dir'))).toEqual([])
  })
})

describe('the spec lists behind npm run qa', () => {
  it('name only files that exist, so a renamed spec fails here and not silently in a run', () => {
    for (const spec of QA_SPECS) expect(existsSync(join(process.cwd(), spec)), spec).toBe(true)
  })

  it('are chosen by an exact mode, and a typo is an error instead of the whole suite', () => {
    expect(specsFor('all')).toBe(QA_SPECS)
    expect(specsFor('visual')).toBe(VISUAL_SPECS)
    expect(() => specsFor('vsual')).toThrow(/unknown qa mode "vsual"/)
    expect(() => specsFor(undefined)).toThrow(/unknown qa mode/)
  })

  it('keep the visual list inside the full list', () => {
    for (const spec of VISUAL_SPECS) expect(QA_SPECS).toContain(spec)
  })
})
