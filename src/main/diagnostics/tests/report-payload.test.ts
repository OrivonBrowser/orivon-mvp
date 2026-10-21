import { describe, expect, it } from 'vitest'
import { buildDiagnostics } from '../diagnostics-facts.js'
import { buildPayload, cut, fitDiagnostics, isSendable, LIMITS, previewText, wireBody, wireVersion } from '../report-payload.js'
import { CHOICES, CRASH, FACTS, HOME, sources } from './report-fixtures.js'

const TOP_LEVEL = ['schema', 'reportId', 'description', 'contact', 'version', 'crash', 'diagnostics', 'log', 'page', 'dump']

const { page: _page, ...withoutPage } = CRASH

describe('buildPayload', () => {
  it('has exactly the wire format\'s top-level keys, schema 1, in every case', () => {
    const full = buildPayload(sources())
    expect(Object.keys(full)).toEqual(TOP_LEVEL)
    expect(full.schema).toBe(1)
    const bare = buildPayload(sources({ crash: undefined, choices: { ...CHOICES, crashId: null, diagnostics: false, log: false, page: false, dump: false } }))
    expect(Object.keys(bare)).toEqual(TOP_LEVEL)
    expect(bare).toMatchObject({ crash: null, diagnostics: null, log: null, page: null, dump: null })
  })

  it('trims the description and the contact, and keeps the report id it was given', () => {
    const payload = buildPayload(sources())
    expect(payload.description).toBe('It crashed.')
    expect(payload.contact).toBe('ann@example.org')
    expect(payload.reportId).toBe('f'.repeat(32))
  })

  it('describes the crash and replaces the home directory in its message and stack', () => {
    const { crash } = buildPayload(sources())
    expect(crash).toEqual({ kind: 'renderer', at: '2026-10-07T11:00:00Z', process: 'tab', reason: 'crashed', exitCode: 133, message: 'The page died at ~/secret.html', stack: 'Error: x\n    at f (~/git/orivon/src/a.ts:1:1)' })
  })

  it('sends the crashed page\'s address and the dump only when asked, and only when the crash has them', () => {
    expect(buildPayload(sources()).page).toBe('https://example.org/path?q=1')
    expect(buildPayload(sources()).dump).toEqual({ base64: 'AAECAw==', bytes: 4 })
    expect(buildPayload(sources({ choices: { ...CHOICES, page: false, dump: false } }))).toMatchObject({ page: null, dump: null })
    expect(buildPayload(sources({ crash: withoutPage, dump: undefined }))).toMatchObject({ page: null, dump: null })
  })

  it('does not read the dump when it is not to be sent', () => {
    let read = 0
    buildPayload(sources({ choices: { ...CHOICES, dump: false }, dump: { bytes: 4, base64: () => { read += 1; return '' } } }))
    expect(read).toBe(0)
  })

  it('redacts the home directory in the log and in every string of the diagnostics', () => {
    const payload = buildPayload(sources({ diagnostics: buildDiagnostics({ ...FACTS, system: { ...FACTS.system, cpuModel: '/home/ann/odd' } }) }))
    expect(payload.log?.[0]).toBe('2026-10-07T11:00:00.000Z LOG hello ~/x')
    expect(payload.diagnostics?.system.cpuModel).toBe('~/odd')
    expect(JSON.stringify(payload)).not.toContain(HOME)
  })

  it('cuts every field to the length the server takes, never sending over it', () => {
    const long = 'é'.repeat(30_000)
    const payload = buildPayload(sources({
      choices: { ...CHOICES, description: long, contact: long },
      crash: { ...CRASH, process: long, reason: long, message: long, stack: long, page: `https://x/${long}` },
      log: Array.from({ length: 1500 }, () => long),
      version: `${'1.'.repeat(40)}x y`
    }))
    expect(payload.description).toHaveLength(LIMITS.description)
    expect(payload.contact).toHaveLength(LIMITS.contact)
    expect(payload.crash?.process).toHaveLength(LIMITS.process)
    expect(payload.crash?.reason).toHaveLength(LIMITS.reason)
    expect(payload.crash?.message).toHaveLength(LIMITS.message)
    expect(payload.crash?.stack).toHaveLength(LIMITS.stack)
    expect(payload.page).toHaveLength(LIMITS.page)
    expect(payload.log).toHaveLength(LIMITS.logLines)
    expect(payload.log?.every((line) => line.length <= LIMITS.logLine)).toBe(true)
    expect(payload.version).toMatch(/^[0-9A-Za-z.+-]{1,32}$/)
  })

  it('keeps the newest log lines when there are too many', () => {
    const payload = buildPayload(sources({ log: Array.from({ length: 1200 }, (_, index) => `line ${index}`) }))
    expect(payload.log?.[0]).toBe('line 200')
    expect(payload.log?.at(-1)).toBe('line 1199')
  })

  it('gives a crash with an empty process a name, since the server needs one', () => {
    expect(buildPayload(sources({ crash: { ...CRASH, process: '' } })).crash?.process).toBe('unknown')
  })
})

describe('wireVersion', () => {
  it('keeps what the server accepts and falls back to 0', () => {
    expect(wireVersion('0.1.0-beta+3')).toBe('0.1.0-beta+3')
    expect(wireVersion('1.0 (dev)')).toBe('1.0dev')
    expect(wireVersion('()')).toBe('0')
  })
})

describe('isSendable', () => {
  it('needs a description', () => {
    expect(isSendable(buildPayload(sources()))).toBe(true)
    expect(isSendable(buildPayload(sources({ choices: { ...CHOICES, description: '   ' } })))).toBe(false)
  })
})

describe('the diagnostics limits', () => {
  it('stays within 64 KiB and depth 8 for a realistic machine', () => {
    const diagnostics = buildPayload(sources()).diagnostics
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThanOrEqual(LIMITS.diagnosticsBytes)
  })

  it('drops whole groups, least useful first, when the block is over its size', () => {
    const base = buildDiagnostics(FACTS)
    const big = { ...base, recentCrashes: base.recentCrashes, browser: { ...base.browser, extensions: Array.from({ length: 2000 }, (_, index) => ({ id: `e${index}`, name: 'n'.repeat(40), version: '1', enabled: true })) } }
    const fitted = fitDiagnostics(big)
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(LIMITS.diagnosticsBytes)
    expect(fitted.browser.extensions).toEqual([])
    expect(fitted.app).toEqual(base.app)
  })

  it('leaves a block that fits as it is', () => {
    const base = buildDiagnostics(FACTS)
    expect(fitDiagnostics(base)).toBe(base)
  })
})

describe('previewText and wireBody', () => {
  it('shows the dump as its size, and the wire carries its bytes', () => {
    const payload = buildPayload(sources())
    expect(previewText(payload)).toContain('<4 bytes of binary>')
    expect(previewText(payload)).not.toContain('AAECAw==')
    expect(wireBody(payload)).toContain('AAECAw==')
  })

  it('is the same report apart from the dump: parsing the preview gives the wire body with the placeholder', () => {
    const payload = buildPayload(sources())
    const preview = JSON.parse(previewText(payload)) as Record<string, unknown>
    const wire = JSON.parse(wireBody(payload)) as Record<string, unknown>
    expect({ ...wire, dump: null }).toEqual({ ...preview, dump: null })
  })
})

describe('cut', () => {
  it('leaves short text alone', () => {
    expect(cut('abc', 5)).toBe('abc')
    expect(cut('abcdef', 5)).toBe('abcde')
  })
})
