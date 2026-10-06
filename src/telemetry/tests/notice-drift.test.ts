// The privacy notice lists every field the client sends. This fails when the payloads and the notice
// disagree, so neither can change alone.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fold } from '../accounting.js'
import { buildErasePayload, buildSitesPayload, buildUsagePayload } from '../disclosure.js'

const NOTICES = [
  { file: join(import.meta.dirname, '../../../docs/privacy/notice.md'), heading: 'What telemetry sends' },
  { file: join(import.meta.dirname, '../../../docs/privacy/notice.it.md'), heading: 'Cosa invia la telemetria' }
]

/** Dotted paths of every key, going into objects but treating `sites` (a map of site names) as one field. */
function fieldPaths (value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return key === 'sites' || typeof inner !== 'object' || inner === null ? [path] : fieldPaths(inner, path)
  })
}

function noticeFields (text: string, heading = 'What telemetry sends'): string[] {
  const section = text.split(/^## /m).find((part) => part.startsWith(heading))
  if (section === undefined) return []
  return section.split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => /^\|\s*`([A-Za-z0-9_.]+)`\s*\|/.exec(line)?.[1])
    .filter((field): field is string => field !== undefined)
}

describe('the privacy notice and the payloads', () => {
  const state = { ...fold([]), perSite: { '2026-10': { 'web3:a.eth': 10 } }, perApp: { shell: { '2026-10': { activeSec: 10, backgroundSec: 1 } } } }
  const usage = buildUsagePayload(state, { installId: 'ab'.repeat(16), stream: 'cd'.repeat(16), region: 'EU', version: '0.1.0', period: '2026-10' })
  const sites = buildSitesPayload(state, { installId: 'ab'.repeat(16), stream: 'cd'.repeat(16), version: '0.1.0', period: '2026-10' })
  const erase = buildErasePayload('ab'.repeat(16))

  it.each(NOTICES)('lists exactly the fields of the three payloads in $file', ({ file, heading }) => {
    const sent = new Set([usage, sites, erase].flatMap((payload) => fieldPaths(payload)))
    const listed = new Set(noticeFields(readFileSync(file, 'utf8'), heading))
    expect([...listed].filter((field) => !sent.has(field))).toEqual([])
    expect([...sent].filter((field) => !listed.has(field))).toEqual([])
  })

  it('finds the fields in a notice table, and none in a notice without one', () => {
    expect(noticeFields('## What telemetry sends\n\n| `a` | x |\n| `b.c` | y |\n\n## Next\n| `z` | no |')).toEqual(['a', 'b.c'])
    expect(noticeFields('# Notice\n')).toEqual([])
  })

  it('reads the dotted names of nested fields and keeps the site map one field', () => {
    expect(fieldPaths({ a: 1, classes: { x: 1 }, sites: { 'web3:q': 2 } })).toEqual(['a', 'classes.x', 'sites'])
  })
})
