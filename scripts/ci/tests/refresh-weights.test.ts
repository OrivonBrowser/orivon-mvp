import { describe, expect, it } from 'vitest'
import { weightsFromLog } from '../refresh-weights.mjs'

const line = (file: string, title: string, ms: string): string => `2026-10-05T09:31:21.7087227Z \u001b[32m✓\u001b[39m ${file} \u001b[2m>\u001b[22m ${title} \u001b[2m${ms}\u001b[22m\u001b[39m`

describe('weightsFromLog', () => {
  it('sums a file\'s tests, rounds up, and ignores timestamps and colour codes', () => {
    const log = [line('test/tabs/e2e-a.test.ts', 'one', '1500ms'), line('test/tabs/e2e-a.test.ts', 'two', '2000ms'), line('test/sites/e2e-b.test.ts', 'three', '300ms')].join('\n')
    expect(weightsFromLog(log)).toEqual({ 'test/sites/e2e-b.test.ts': 1, 'test/tabs/e2e-a.test.ts': 4 })
  })

  it('reads seconds, plain lines and failed tests, and skips skipped tests and other output', () => {
    const log = ' × test/a/e2e-x.test.ts > failing 2.5s\n ↓ test/a/e2e-y.test.ts > skipped\n[main] noise 12ms\n ✓ test/a/e2e-z.test.ts > fine 40ms'
    expect(weightsFromLog(log)).toEqual({ 'test/a/e2e-x.test.ts': 3, 'test/a/e2e-z.test.ts': 1 })
  })

  it('returns nothing for a log with no verbose lines', () => {
    expect(weightsFromLog('nothing here')).toEqual({})
  })
})
