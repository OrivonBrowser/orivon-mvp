import { describe, expect, it } from 'vitest'
import { eraseReport, FAILURE_TEXT, outcomeOfStatus, REPORT_TIMEOUT_MS, sendReport } from '../report-channel.js'
import type { Post } from '../report-channel.js'
import { buildPayload } from '../report-payload.js'
import { sources } from './report-fixtures.js'

const BASE = 'http://127.0.0.1:9/v1/'

describe('outcomeOfStatus', () => {
  it.each([
    [204, { ok: true }],
    [400, { ok: false, why: 'rejected' }],
    [413, { ok: false, why: 'too-large' }],
    [429, { ok: false, why: 'too-many' }],
    [503, { ok: false, why: 'server-full' }],
    [507, { ok: false, why: 'dump-store-full' }],
    [500, { ok: false, why: 'rejected' }],
    [200, { ok: false, why: 'rejected' }]
  ])('reads %i', (status, outcome) => {
    expect(outcomeOfStatus(status)).toEqual(outcome)
  })

  it('has words for every failure', () => {
    for (const why of ['offline', 'too-large', 'too-many', 'server-full', 'dump-store-full', 'rejected'] as const) expect(FAILURE_TEXT[why].length).toBeGreaterThan(10)
  })
})

describe('sendReport', () => {
  it('posts the wire body to <base>report with the long timeout, and reads only the status', async () => {
    const calls: Array<{ url: string, body: string, timeout: number }> = []
    const send: Post = async (url, body, timeout) => { calls.push({ url, body, timeout }); return { status: 204 } }
    const payload = buildPayload(sources())
    expect(await sendReport(send, BASE, payload)).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE}report`)
    expect(calls[0]?.timeout).toBe(REPORT_TIMEOUT_MS)
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual(JSON.parse(JSON.stringify(payload)))
  })

  it('reports offline when the request throws', async () => {
    const send: Post = async () => { throw new Error('ECONNREFUSED') }
    expect(await sendReport(send, BASE, buildPayload(sources()))).toEqual({ ok: false, why: 'offline' })
  })

  it('maps the server\'s refusals', async () => {
    const send: Post = async () => ({ status: 413 })
    expect(await sendReport(send, BASE, buildPayload(sources()))).toEqual({ ok: false, why: 'too-large' })
  })
})

describe('eraseReport', () => {
  it('posts the report id to <base>report-erase and is done on a 204', async () => {
    const calls: Array<{ url: string, body: string }> = []
    const send: Post = async (url, body) => { calls.push({ url, body }); return { status: 204 } }
    expect(await eraseReport(send, BASE, 'a'.repeat(32))).toBe(true)
    expect(calls[0]?.url).toBe(`${BASE}report-erase`)
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ schema: 1, reportId: 'a'.repeat(32) })
  })

  it('is not done when offline or refused', async () => {
    expect(await eraseReport(async () => { throw new Error('x') }, BASE, 'a'.repeat(32))).toBe(false)
    expect(await eraseReport(async () => ({ status: 400 }), BASE, 'a'.repeat(32))).toBe(false)
  })
})
