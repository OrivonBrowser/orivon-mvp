import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { CrashRecord } from '../crash-records.js'
import { buildDiagnostics } from '../diagnostics-facts.js'
import { reportDomain } from '../report-domain.js'
import type { ReportDeps, TestKind } from '../report-domain.js'
import type { SentReport } from '../sent-reports.js'
import { CRASH, FACTS } from './report-fixtures.js'

const caller = (id = 5): { page: 'report', contents: WebContents } => ({ page: 'report', contents: { id } as WebContents })
const DUMP = { path: '/x/a.dmp', mtimeMs: Date.parse('2026-10-07T11:00:10Z'), bytes: 4 }

interface Harness {
  deps: ReportDeps
  posts: Array<{ url: string, body: string }>
  copied: string[]
  sent: SentReport[]
  reported: Array<[string, string | undefined]>
  tests: Array<[TestKind, number]>
  ids: string[]
  status: { code: number | 'throw' }
  handle: (command: unknown, id?: number) => Promise<Record<string, unknown>>
}

function setup (overrides: Partial<ReportDeps> = {}): Harness {
  const harness = { posts: [], copied: [], sent: [], reported: [], tests: [], ids: [], status: { code: 204 } } as unknown as Harness
  let counter = 0
  const records: CrashRecord[] = [CRASH]
  harness.deps = {
    isPrivate: false,
    version: '0.1.0',
    home: '/home/ann',
    ignoreCase: false,
    crashes: {
      crashes: () => records,
      crash: (id) => records.find((record) => record.id === id),
      dumpOf: (record) => record.id === CRASH.id ? DUMP : undefined,
      markReported: (id, reportId) => { harness.reported.push([id, reportId]) }
    },
    sent: {
      all: () => [...harness.sent].reverse(),
      add: (entry) => { harness.sent.push(entry) },
      remove: (reportId) => { harness.sent = harness.sent.filter((entry) => entry.reportId !== reportId) }
    },
    diagnostics: async () => buildDiagnostics(FACTS),
    logLines: (crash) => crash === undefined ? ['line one'] : ['line one', 'crash log'],
    readDump: () => 'AAECAw==',
    newReportId: () => { counter += 1; const id = counter.toString(16).padStart(32, '0'); harness.ids.push(id); return id },
    post: async (url, body) => {
      harness.posts.push({ url, body })
      if (harness.status.code === 'throw') throw new Error('offline')
      return { status: harness.status.code }
    },
    base: () => 'http://127.0.0.1:1/v1/',
    now: () => Date.parse('2026-10-07T12:00:00Z'),
    copy: (text) => { harness.copied.push(text) },
    openNotice: vi.fn(),
    runTest: (kind, page) => { harness.tests.push([kind, page.id]) },
    ...overrides
  }
  const domain = reportDomain(harness.deps)
  harness.handle = async (command, id) => await domain.handle(command, caller(id)) as Record<string, unknown>
  return harness
}

const CHOICES = { crashId: CRASH.id, description: 'It crashed', contact: '', diagnostics: true, log: true, page: false, dump: false }

describe('the report domain', () => {
  it('is for the report page only', () => {
    expect(reportDomain(setup().deps).pages).toEqual(['report'])
  })

  it('answers its state with the crashes, what each can carry, and the sent list', async () => {
    const h = setup()
    h.sent.push({ reportId: 'a'.repeat(32), at: '2026-10-06T10:00:00Z', summary: 'before' })
    const state = await h.handle({ type: 'state' })
    expect(state).toMatchObject({ private: false, limits: { description: 10_000, contact: 254 } })
    expect(state['crashes']).toEqual([{ id: CRASH.id, kind: 'renderer', at: CRASH.at, process: 'tab', reason: 'crashed', hasPage: true, dumpBytes: 4, reported: false }])
    expect(state['sent']).toHaveLength(1)
  })

  it('previews the literal report, which is what is then sent', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    const preview = await h.handle({ type: 'preview', choices: CHOICES })
    expect(preview['sendable']).toBe(true)
    expect(JSON.parse(preview['text'] as string)).toMatchObject({ schema: 1, description: 'It crashed', crash: { kind: 'renderer' }, log: ['line one', 'crash log'], page: null, dump: null })
    const sent = await h.handle({ type: 'send', choices: CHOICES })
    expect(sent['ok']).toBe(true)
    expect(JSON.parse(h.posts[0]?.body ?? '')).toEqual(JSON.parse(preview['text'] as string))
    expect(h.posts[0]?.url).toBe('http://127.0.0.1:1/v1/report')
  })

  it('shows the dump as its size in the preview, and puts its bytes on the wire only when ticked', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    const withDump = { ...CHOICES, dump: true }
    expect((await h.handle({ type: 'preview', choices: withDump }))['text']).toContain('<4 bytes of binary>')
    await h.handle({ type: 'send', choices: withDump })
    expect(JSON.parse(h.posts[0]?.body ?? '').dump).toEqual({ base64: 'AAECAw==', bytes: 4 })
  })

  it('uses the facts and the log of the moment the page asked for its state, not later ones', async () => {
    let lines = ['first']
    const h = setup({ logLines: () => lines })
    await h.handle({ type: 'state' })
    expect(JSON.parse((await h.handle({ type: 'preview', choices: CHOICES }))['text'] as string).log).toEqual(['first'])
    lines = ['first', 'later']
    expect(JSON.parse((await h.handle({ type: 'preview', choices: CHOICES }))['text'] as string).log).toEqual(['first'])
    await h.handle({ type: 'state' })
    expect(JSON.parse((await h.handle({ type: 'preview', choices: CHOICES }))['text'] as string).log).toEqual(['first', 'later'])
  })

  it('refuses to send without a description, and sends nothing', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    expect(await h.handle({ type: 'send', choices: { ...CHOICES, description: '  ' } })).toMatchObject({ ok: false, why: 'empty' })
    expect(h.posts).toEqual([])
  })

  it('ignores a crash id it does not hold', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    const preview = await h.handle({ type: 'preview', choices: { ...CHOICES, crashId: 'ffffffffffffffff' } })
    expect(JSON.parse(preview['text'] as string).crash).toBeNull()
  })

  it('records the sent report, marks the crash as reported, and starts the next report on a new id', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    const first = await h.handle({ type: 'send', choices: CHOICES })
    expect(h.sent).toEqual([{ reportId: first['reportId'], at: '2026-10-07T12:00:00Z', crashId: CRASH.id, summary: 'It crashed' }])
    expect(h.reported).toEqual([[CRASH.id, first['reportId']]])
    await h.handle({ type: 'state' })
    const second = await h.handle({ type: 'send', choices: CHOICES })
    expect(second['reportId']).not.toBe(first['reportId'])
  })

  it('keeps the report id across a failed send of the same text, so the server counts it once', async () => {
    const h = setup()
    h.status.code = 'throw'
    await h.handle({ type: 'state' })
    expect(await h.handle({ type: 'send', choices: CHOICES })).toMatchObject({ ok: false, why: 'offline' })
    h.status.code = 204
    const retry = await h.handle({ type: 'send', choices: CHOICES })
    expect(JSON.parse(h.posts[0]?.body ?? '').reportId).toBe(JSON.parse(h.posts[1]?.body ?? '').reportId)
    expect(retry['ok']).toBe(true)
    expect(h.sent).toHaveLength(1)
  })

  it('uses a new report id when the text changed after a failure, since the server would drop the edit as a repeat', async () => {
    const h = setup()
    h.status.code = 503
    await h.handle({ type: 'state' })
    expect(await h.handle({ type: 'send', choices: CHOICES })).toMatchObject({ ok: false, why: 'server-full' })
    h.status.code = 204
    await h.handle({ type: 'send', choices: { ...CHOICES, description: 'It crashed, and then it hung' } })
    expect(JSON.parse(h.posts[0]?.body ?? '').reportId).not.toBe(JSON.parse(h.posts[1]?.body ?? '').reportId)
  })

  it('tells the person why a send failed, in words, and keeps nothing as sent', async () => {
    const h = setup()
    h.status.code = 413
    await h.handle({ type: 'state' })
    const reply = await h.handle({ type: 'send', choices: CHOICES })
    expect(reply).toMatchObject({ ok: false, why: 'too-large' })
    expect(String(reply['text'])).toContain('without the crash dump')
    expect(h.sent).toEqual([])
    expect(h.reported).toEqual([])
  })

  it('deletes a sent report from the server and from the list, and unmarks its crash', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    const sent = await h.handle({ type: 'send', choices: CHOICES })
    const reply = await h.handle({ type: 'erase', reportId: sent['reportId'] })
    expect(reply).toMatchObject({ ok: true, sent: [] })
    expect(h.posts.at(-1)?.url).toBe('http://127.0.0.1:1/v1/report-erase')
    expect(JSON.parse(h.posts.at(-1)?.body ?? '')).toEqual({ schema: 1, reportId: sent['reportId'] })
    expect(h.reported.at(-1)).toEqual([CRASH.id, undefined])
  })

  it('keeps a sent report in the list when the server could not be reached for its deletion', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    const sent = await h.handle({ type: 'send', choices: CHOICES })
    h.status.code = 'throw'
    expect(await h.handle({ type: 'erase', reportId: sent['reportId'] })).toMatchObject({ ok: false })
    expect(h.sent).toHaveLength(1)
  })

  it('refuses to erase an id that is not 32 hex characters, without a request', async () => {
    const h = setup()
    expect(await h.handle({ type: 'erase', reportId: '../x' })).toEqual({ ok: false })
    expect(h.posts).toEqual([])
  })

  it('copies the report as text to the clipboard, minus the contact', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    await h.handle({ type: 'copy', choices: { ...CHOICES, contact: 'ann@example.org' } })
    expect(h.copied).toHaveLength(1)
    expect(h.copied[0]).toContain('It crashed')
    expect(h.copied[0]).not.toContain('ann@example.org')
  })

  it('copies the ID of a report that was sent, and nothing else the page names', async () => {
    const h = setup()
    await h.handle({ type: 'state' })
    const sent = await h.handle({ type: 'send', choices: CHOICES })
    expect(await h.handle({ type: 'copyId', reportId: sent['reportId'] })).toEqual({ ok: true })
    expect(h.copied).toEqual([sent['reportId']])
    expect(await h.handle({ type: 'copyId', reportId: 'rm -rf' })).toEqual({ ok: false })
    expect(h.copied).toHaveLength(1)
  })

  it('runs only the three tests it knows, for the page that asked', async () => {
    const h = setup()
    for (const kind of ['renderer', 'main-error', 'main-native']) expect(await h.handle({ type: 'test', kind }, 9)).toEqual({ ok: true })
    expect(await h.handle({ type: 'test', kind: 'format-disk' }, 9)).toBeUndefined()
    expect(h.tests).toEqual([['renderer', 9], ['main-error', 9], ['main-native', 9]])
  })

  it('opens the notice, and answers nothing to an unknown request', async () => {
    const h = setup()
    expect(await h.handle({ type: 'notice' }, 3)).toEqual({ ok: true })
    expect(vi.mocked(h.deps.openNotice).mock.calls[0]?.[0].id).toBe(3)
    expect(await h.handle({ type: 'nope' })).toBeUndefined()
    expect(await h.handle('text')).toBeUndefined()
  })
})
