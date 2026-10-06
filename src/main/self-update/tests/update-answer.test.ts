import { describe, expect, it } from 'vitest'
import { buildAnswer } from '../update-answer.js'

const IDLE = { phase: 'idle', percent: null, failure: null } as const
const RELEASE = { version: 'v1.2.0', url: 'https://example.test/r' }

describe('buildAnswer', () => {
  it('says there is nothing newer, and whether the source was reached', () => {
    expect(buildAnswer({ current: '1.0.0', release: null, installability: null, flow: IDLE, reached: true })).toMatchObject({ reached: true, latest: null, newer: false, canInstall: false })
    expect(buildAnswer({ current: '1.0.0', release: null, installability: null, flow: IDLE, reached: false }).reached).toBe(false)
  })

  it('offers Install only when this copy can take the release', () => {
    const file = { name: 'a', size: 1, sha256: 'a'.repeat(64) }
    expect(buildAnswer({ current: '1.0.0', release: RELEASE, installability: { ok: true, kind: 'deb', file }, flow: IDLE, reached: true })).toMatchObject({ newer: true, latest: 'v1.2.0', canInstall: true, cannotInstallWhy: null })
    expect(buildAnswer({ current: '1.0.0', release: RELEASE, installability: { ok: false, why: 'Because.' }, flow: IDLE, reached: true })).toMatchObject({ canInstall: false, cannotInstallWhy: 'Because.' })
  })

  it('carries the install\'s progress and failure', () => {
    expect(buildAnswer({ current: '1.0.0', release: RELEASE, installability: null, flow: { phase: 'downloading', percent: 40, failure: null }, reached: true })).toMatchObject({ phase: 'downloading', percent: 40 })
    expect(buildAnswer({ current: '1.0.0', release: RELEASE, installability: null, flow: { phase: 'failed', percent: null, failure: 'No.' }, reached: true })).toMatchObject({ phase: 'failed', failure: 'No.' })
  })
})
