import { describe, expect, it } from 'vitest'
import { planTestRun } from '../test-changed.mjs'

const nobody = (): string[] => []

describe('planTestRun', () => {
  it('runs the tests related to changed code and test files', () => {
    expect(planTestRun(['src/telemetry/consent.ts', 'src/telemetry/tests/consent.test.ts'], nobody))
      .toEqual({ mode: 'related', files: ['src/telemetry/consent.ts', 'src/telemetry/tests/consent.test.ts'] })
  })

  it('adds the tests that name a changed document, which they read from disk rather than import', () => {
    const named = (name: string): string[] => name === 'notice.md' ? ['src/telemetry/tests/notice-drift.test.ts'] : []
    expect(planTestRun(['docs/privacy/notice.md', 'docs/decisions/decision-log.md'], named))
      .toEqual({ mode: 'related', files: ['src/telemetry/tests/notice-drift.test.ts'] })
  })

  it('runs everything when what all tests run under changed', () => {
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'vitest.config.ts']) {
      expect(planTestRun(['src/a.ts', path], nobody)).toEqual({ mode: 'full', reason: `${path} changed` })
    }
  })

  it('runs nothing when no unit test covers what changed', () => {
    expect(planTestRun(['docs/README.md', 'devlog/journal.md'], nobody)).toEqual({ mode: 'none' })
  })
})
