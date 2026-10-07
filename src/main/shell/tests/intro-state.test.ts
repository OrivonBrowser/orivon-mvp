import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { introMode, introPageUrl, markIntroSeen, parseLeaving, planIntro, readIntroSeen, shouldShowIntro } from '../intro-state.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-intro-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('introMode -- what ORIVON_INTRO asks for', () => {
  it('reads each of the three modes', () => {
    expect(introMode('always')).toBe('always')
    expect(introMode('once')).toBe('once')
    expect(introMode('off')).toBe('off')
  })

  it('treats an unset variable as once, the mode a plain `npm run start` gets', () => {
    expect(introMode(undefined)).toBe('once')
  })

  it('treats anything else as once rather than hiding the intro on a typo', () => {
    expect(introMode('alwyas')).toBe('once')
    expect(introMode('')).toBe('once')
    expect(introMode('OFF')).toBe('once')
  })
})

describe('shouldShowIntro', () => {
  it.each([
    ['always', false, true],
    ['always', true, true],
    ['once', false, true],
    ['once', true, false],
    ['off', false, false],
    ['off', true, false]
  ] as const)('%s, already seen: %s -> shows: %s', (mode, seen, shows) => {
    expect(shouldShowIntro(mode, seen)).toBe(shows)
  })
})

describe('the seen flag on disk', () => {
  it('reads as not seen when the file is missing', async () => {
    expect(await readIntroSeen(dir)).toBe(false)
  })

  it('reads back what markIntroSeen wrote', async () => {
    await markIntroSeen(dir)
    expect(await readIntroSeen(dir)).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'intro.json'), 'utf8'))).toEqual({ seen: true })
  })

  it.each([
    ['not JSON', '{oops'],
    ['not an object', '"seen"'],
    ['null', 'null'],
    ['seen is not true', '{"seen":"yes"}'],
    ['seen is false', '{"seen":false}']
  ])('reads as not seen when the file is corrupt (%s)', async (_label, text) => {
    await writeFile(join(dir, 'intro.json'), text, 'utf8')
    expect(await readIntroSeen(dir)).toBe(false)
  })

  it('never throws when the write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(markIntroSeen(join(dir, 'no', 'such', 'dir'))).resolves.toBeUndefined()
  })
})

describe('planIntro -- decided before the window exists', () => {
  it('opens on the welcome page whenever it shows for the screen itself', async () => {
    expect((await planIntro('always', dir))?.welcome).toBe(true)
    expect((await planIntro(undefined, dir))?.welcome).toBe(true)
  })

  it('shows on a fresh profile in once mode, and remembers the click-through', async () => {
    const plan = await planIntro(undefined, dir)
    expect(plan).toBeDefined()
    expect(await readIntroSeen(dir)).toBe(false)

    await plan?.onEntered()

    expect(await readIntroSeen(dir)).toBe(true)
    expect(await planIntro(undefined, dir)).toBeUndefined()
  })

  it('does not show in once mode once it has been seen', async () => {
    await markIntroSeen(dir)
    expect(await planIntro('once', dir)).toBeUndefined()
  })

  it('shows in always mode even when seen, and never uses up the one-time showing', async () => {
    await markIntroSeen(dir)
    const plan = await planIntro('always', dir)
    expect(plan).toBeDefined()

    const fresh = await mkdtemp(join(tmpdir(), 'orivon-intro-'))
    try {
      await (await planIntro('always', fresh))?.onEntered()
      expect(await readIntroSeen(fresh)).toBe(false)
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it('does not show when off, seen or not', async () => {
    expect(await planIntro('off', dir)).toBeUndefined()
    await markIntroSeen(dir)
    expect(await planIntro('off', dir)).toBeUndefined()
  })

  it('says so on the console when the variable holds a value it does not know', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await planIntro('alwyas', dir)
    expect(warn).toHaveBeenCalledOnce()

    warn.mockClear()
    await planIntro('always', dir)
    await planIntro(undefined, dir)
    await planIntro('', dir)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('the telemetry question on the welcome screen', () => {
  it('is asked only when the screen shows and the outside says it is to be asked, and records the answer where told', async () => {
    const choose = vi.fn(async (_on: boolean) => {})
    const asked = vi.fn(async () => true)
    expect(await planIntro('off', dir, { offered: asked, choose })).toBeUndefined()
    expect(asked).not.toHaveBeenCalled()

    const plan = await planIntro('always', dir, { offered: asked, choose })
    expect(plan?.offerTelemetry).toBe(true)
    await plan?.chooseTelemetry(false)
    expect(choose).toHaveBeenCalledWith(false)

    expect((await planIntro('always', dir, { offered: async () => false, choose }))?.offerTelemetry).toBe(false)
    expect((await planIntro('always', dir))?.offerTelemetry).toBe(false)
  })
})

describe('a telemetry failure at the welcome screen', () => {
  it('costs the question and never the screen: the plan is made, without it, and the failure is logged once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const plan = await planIntro('always', dir, { offered: async () => { throw new Error('telemetry is broken') }, choose: async () => {} })
    expect(plan).toBeDefined()
    expect(plan?.offerTelemetry).toBe(false)
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('the telemetry question asked again after the notice changed', () => {
  const lines = ['The usage report names your country.']
  const question = (renewal: () => Promise<readonly string[] | undefined>, offered = async () => false): Parameters<typeof planIntro>[2] => ({ offered, choose: async () => {}, renewal })

  it('shows the popup alone on a screen already seen, with the question and the lines, and writes nothing on answering', async () => {
    await markIntroSeen(dir)
    const before = await readFile(join(dir, 'intro.json'), 'utf8')
    const plan = await planIntro('once', dir, question(async () => lines))
    expect(plan).toBeDefined()
    expect(plan?.welcome).toBe(false)
    expect(plan?.offerTelemetry).toBe(true)
    expect(plan?.changes).toEqual(lines)
    await plan?.onEntered()
    expect(await readFile(join(dir, 'intro.json'), 'utf8')).toBe(before)
  })

  it('does not show on a screen already seen when nothing is due', async () => {
    await markIntroSeen(dir)
    expect(await planIntro('once', dir, question(async () => undefined))).toBeUndefined()
    expect(await planIntro('once', dir, { offered: async () => false, choose: async () => {} })).toBeUndefined()
  })

  it('never shows in off mode, however much is due', async () => {
    await markIntroSeen(dir)
    const renewal = vi.fn(async () => lines)
    expect(await planIntro('off', dir, question(renewal))).toBeUndefined()
    expect(renewal).not.toHaveBeenCalled()
  })

  it('carries the lines on a first showing whose consent is a stale acceptance', async () => {
    const plan = await planIntro('once', dir, question(async () => lines, async () => true))
    expect(plan?.welcome).toBe(true)
    expect(plan?.offerTelemetry).toBe(true)
    expect(plan?.changes).toEqual(lines)
  })

  it('carries no lines when nothing is due, and a failure costs the question and never the window', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await planIntro('always', dir, question(async () => undefined)))?.changes).toEqual([])
    const plan = await planIntro('always', dir, question(async () => { throw new Error('broken') }, async () => true))
    expect(plan?.offerTelemetry).toBe(true)
    expect(plan?.changes).toEqual([])
    await markIntroSeen(dir)
    expect(await planIntro('once', dir, question(async () => { throw new Error('broken') }))).toBeUndefined()
    expect(error).toHaveBeenCalled()
  })
})

describe('parseLeaving and introPageUrl', () => {
  it('reads the report a page makes when it asked nothing', () => {
    expect(parseLeaving('#leaving')).toEqual({ telemetry: undefined })
  })

  it('reads the button pressed on the telemetry popup', () => {
    expect(parseLeaving('#leaving?telemetry=1')).toEqual({ telemetry: true })
    expect(parseLeaving('#leaving?telemetry=0')).toEqual({ telemetry: false })
    expect(parseLeaving('#leaving?telemetry=maybe')).toEqual({ telemetry: undefined })
  })

  it('reads nothing from any other hash, #asking and #entered included', () => {
    for (const hash of ['', '#', '#asking', '#entered', '#leaving-default', '#leaving-other', '#leaving2?telemetry=1']) expect(parseLeaving(hash)).toBeUndefined()
  })

  it('puts what main offers in the address and nothing else', () => {
    expect(introPageUrl('orivon-shell://r/intro/', { offerTelemetry: false })).toBe('orivon-shell://r/intro/')
    expect(introPageUrl('orivon-shell://r/intro/', { welcome: true, offerTelemetry: true })).toBe('orivon-shell://r/intro/?telemetry=1')
    expect(introPageUrl('orivon-shell://r/intro/', { welcome: false, offerTelemetry: true })).toBe('orivon-shell://r/intro/?welcome=0&telemetry=1')
  })

  it('carries each change line as its own parameter, which the page reads back whole', () => {
    const changes = ['Country, from your time zone & sent at start.', 'A second line: with "quotes"']
    const url = introPageUrl('orivon-shell://r/intro/', { offerTelemetry: true, changes })
    expect(new URL(url).searchParams.getAll('changed')).toEqual(changes)
    expect(introPageUrl('orivon-shell://r/intro/', { offerTelemetry: true, changes: [] })).toBe('orivon-shell://r/intro/?telemetry=1')
  })
})
