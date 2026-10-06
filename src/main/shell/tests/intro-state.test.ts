import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { introMode, markIntroSeen, planIntro, readIntroSeen, shouldShowIntro } from '../intro-state.js'

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
  it('offers the default browser only when it is told it may, and the offer is decided without a query', async () => {
    expect((await planIntro('always', dir))?.offerDefault).toBe(false)
    expect((await planIntro('always', dir, false))?.offerDefault).toBe(false)
    expect((await planIntro('always', dir, true))?.offerDefault).toBe(true)
    expect(await planIntro('off', dir, true)).toBeUndefined()
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
