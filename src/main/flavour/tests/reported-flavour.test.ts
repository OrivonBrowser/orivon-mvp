import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLAVOUR_FILE } from '../first-run-flavour.js'
import { parseFlavours } from '../flavours.js'
import { reportedFlavour } from '../reported-flavour.js'

const flavours = parseFlavours({ flavours: [
  { id: 'freetube', app: 'freetube.orivonstack.eth', name: 'FreeTube', port: 'freetube' },
  { id: 'element', app: 'element.orivonstack.eth', name: 'Element', port: 'element' }
] })

describe('reportedFlavour', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-reported-flavour-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const store = (text: string): void => { writeFileSync(join(dir, FLAVOUR_FILE), text) }

  it('is the stored id when it is on the shipped list', () => {
    store(JSON.stringify({ id: 'freetube', appliedAt: '2026-10-20T10:00:00.000Z' }))
    expect(reportedFlavour(dir, flavours)).toBe('freetube')
  })

  it('is null for a profile that was never tagged', () => {
    expect(reportedFlavour(dir, flavours)).toBeNull()
  })

  it('is null for a file that was edited or damaged: free text, an id not shipped, a wrong type, bad JSON', () => {
    for (const text of [
      JSON.stringify({ id: 'Orivon-Setup-1.0.0-x64.freetube.exe' }),
      JSON.stringify({ id: 'https://example.org' }),
      JSON.stringify({ id: 'thelounge' }),
      JSON.stringify({ id: 'FREETUBE' }),
      JSON.stringify({ id: 'x'.repeat(5000) }),
      JSON.stringify({ id: 7 }),
      JSON.stringify({ id: ['freetube'] }),
      JSON.stringify(['freetube']),
      JSON.stringify({}),
      'null',
      '{',
      ''
    ]) {
      store(text)
      expect(reportedFlavour(dir, flavours), text.slice(0, 40)).toBeNull()
    }
  })

  it('is null when the shipped list is empty, as a damaged list is', () => {
    store(JSON.stringify({ id: 'freetube' }))
    expect(reportedFlavour(dir, [])).toBeNull()
  })
})
