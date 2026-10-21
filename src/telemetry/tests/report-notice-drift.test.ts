// The privacy notice lists every field a bug report can carry. This fails when the report payload and the
// notice disagree, so neither can change alone. `diagnostics` and `log` are listed as one field each: the notice
// describes their contents in prose, and the report page shows them in full before anything is sent.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPayload } from '../../main/diagnostics/report-payload.js'
import { sources } from '../../main/diagnostics/tests/report-fixtures.js'
import { fieldPaths, noticeFields } from './notice-fields.js'

const NOTICES = [
  { file: join(import.meta.dirname, '../../../docs/privacy/notice.md'), heading: 'Bug reports you send' },
  { file: join(import.meta.dirname, '../../../docs/privacy/notice.it.md'), heading: 'Le segnalazioni di problemi che invii' }
]

const LEAVES = ['diagnostics', 'log']

describe('the privacy notice and the bug report', () => {
  // Every branch filled: a crash, its page address and its dump, the technical details and the log.
  const payload = buildPayload(sources())

  it('has every branch filled in the payload this test builds', () => {
    expect(payload.crash).not.toBeNull()
    expect(payload.diagnostics).not.toBeNull()
    expect(payload.log).not.toBeNull()
    expect(payload.page).not.toBeNull()
    expect(payload.dump).not.toBeNull()
  })

  it.each(NOTICES)('lists exactly the fields of the report in $file', ({ file, heading }) => {
    const sent = new Set(fieldPaths(payload, LEAVES))
    const listed = new Set(noticeFields(readFileSync(file, 'utf8'), heading))
    expect([...listed].filter((field) => !sent.has(field))).toEqual([])
    expect([...sent].filter((field) => !listed.has(field))).toEqual([])
  })

  it('counts diagnostics and log as one field each, and the dump as its two', () => {
    expect(fieldPaths(payload, LEAVES)).toEqual([
      'schema', 'reportId', 'description', 'contact', 'version',
      'crash.kind', 'crash.at', 'crash.process', 'crash.reason', 'crash.exitCode', 'crash.message', 'crash.stack',
      'diagnostics', 'log', 'page', 'dump.base64', 'dump.bytes'
    ])
  })
})
