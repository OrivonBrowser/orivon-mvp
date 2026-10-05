// The deterministic parts of qa-visual.ts, with synthetic PNGs and no
// Electron: if these lie, every visual verdict downstream lies with them.
//
// Run: npx vitest run --config test/vitest.e2e.config.ts test/qa-visual.test.ts

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pngjs from 'pngjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAllowlist, baselineDir, compareBaseline, diffPngs, distinctColours } from './support/qa-visual'

const { PNG } = pngjs

function image (width: number, height: number, paint: (x: number, y: number) => number): Buffer {
  const img = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) img.data.writeUInt32LE(paint(x, y), (y * width + x) * 4)
  }
  return PNG.sync.write(img)
}

const OPAQUE_WHITE = 0xffffffff
const OPAQUE_BLACK = 0xff000000
const flat = (w = 40, h = 40): Buffer => image(w, h, () => OPAQUE_WHITE)
/** White with a black square at x,y..x+size. */
const withSquare = (x0: number, y0: number, size: number): Buffer =>
  image(40, 40, (x, y) => (x >= x0 && x < x0 + size && y >= y0 && y < y0 + size ? OPAQUE_BLACK : OPAQUE_WHITE))

describe('applyAllowlist', () => {
  const findings = [
    { rule: 'clipped-text', selector: 'span.title "Long name"', detail: 'scrollWidth 90 > 80' },
    { rule: 'overlapped-control', selector: 'button "Save"', detail: 'covered by div.toast' }
  ]

  it('keeps every finding when nothing is allowed', () => {
    expect(applyAllowlist(findings).findings).toEqual(findings)
  })

  it('removes only the finding whose rule and selector match, and records its reason', () => {
    const r = applyAllowlist(findings, [{ rule: 'clipped-text', selector: 'span.title', reason: 'tab titles are cut on purpose' }])
    expect(r.findings.map((f) => f.rule)).toEqual(['overlapped-control'])
    expect(r.allowed).toEqual([{ ...findings[0], reason: 'tab titles are cut on purpose' }])
  })

  it('does not let a matching selector on a different rule hide a finding', () => {
    const r = applyAllowlist(findings, [{ rule: 'modal-placement', selector: 'span.title', reason: 'n/a' }])
    expect(r.findings).toHaveLength(2)
  })

  it('refuses an exemption with no reason', () => {
    expect(() => applyAllowlist(findings, [{ rule: 'clipped-text', reason: '  ' }])).toThrow(/needs a reason/)
  })
})

describe('diffPngs', () => {
  it('reports zero difference for identical images', () => {
    const d = diffPngs(withSquare(5, 5, 10), withSquare(5, 5, 10))
    expect(d.sizeMismatch).toBe(false)
    if (!d.sizeMismatch) expect(d.diffPixels).toBe(0)
  })

  it('counts a moved square as a real difference', () => {
    const d = diffPngs(withSquare(5, 5, 10), withSquare(20, 20, 10))
    expect(d.sizeMismatch).toBe(false)
    if (!d.sizeMismatch) {
      expect(d.diffPixels).toBe(200)
      expect(d.ratio).toBeCloseTo(200 / 1600, 6)
    }
  })

  it('ignores a difference inside an ignore rectangle but not one outside it', () => {
    const base = withSquare(5, 5, 10)
    const moved = withSquare(20, 20, 10)
    const covering = diffPngs(base, moved, { ignore: [{ x: 0, y: 0, width: 40, height: 40 }] })
    expect(covering.sizeMismatch === false && covering.diffPixels).toBe(0)
    const partial = diffPngs(base, moved, { ignore: [{ x: 0, y: 0, width: 15, height: 15 }] })
    expect(partial.sizeMismatch === false && partial.diffPixels).toBeGreaterThan(0)
  })

  it('refuses to compare images of different sizes instead of resizing one', () => {
    const d = diffPngs(flat(40, 40), flat(40, 41))
    expect(d).toEqual({ sizeMismatch: true, expected: '40x40', actual: '40x41' })
  })
})

describe('distinctColours', () => {
  it('counts a flat image as one colour, so a blank view is detectable', () => {
    expect(distinctColours(flat())).toBe(1)
  })

  it('counts a varied image as many', () => {
    expect(distinctColours(image(60, 60, (x, y) => (0xff000000 | (x * 4) | ((y * 4) << 8)) >>> 0), 1)).toBeGreaterThan(100)
  })
})

describe('compareBaseline', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-qa-baseline-test-'))
    vi.stubEnv('ORIVON_QA_BASELINES', join(dir, 'baselines'))
    vi.stubEnv('CI', '')
    vi.stubEnv('ORIVON_QA_PIXELS', '1')
    vi.stubEnv('ORIVON_QA_UPDATE_BASELINES', '')
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })
  const opts = (): { outDir: string } => ({ outDir: join(dir, 'out') })

  it('records the first run, then matches an unchanged image', async () => {
    const first = await compareBaseline('State One', withSquare(5, 5, 10), opts())
    expect(first.status).toBe('recorded')
    expect(first.baselinePath).toBe(join(baselineDir(), 'State-One.png'))
    expect((await compareBaseline('State One', withSquare(5, 5, 10), opts())).status).toBe('match')
  })

  it('fails a changed image and leaves a diff image next to the baseline copy', async () => {
    await compareBaseline('s', withSquare(5, 5, 10), opts())
    const r = await compareBaseline('s', withSquare(20, 20, 10), opts())
    expect(r.status).toBe('mismatch')
    expect(r.ratio).toBeGreaterThan(r.maxDiffRatio)
    expect((await stat(r.diffPath ?? '')).size).toBeGreaterThan(0)
    expect((await stat(join(dir, 'out', 's.baseline.png'))).size).toBeGreaterThan(0)
  })

  it('tolerates a difference under the configured ratio', async () => {
    await compareBaseline('s', withSquare(5, 5, 10), opts())
    const r = await compareBaseline('s', withSquare(20, 20, 10), { ...opts(), maxDiffRatio: 0.2 })
    expect(r.status).toBe('match')
  })

  it('reports a size change as its own failure', async () => {
    await compareBaseline('s', flat(40, 40), opts())
    expect((await compareBaseline('s', flat(50, 40), opts())).status).toBe('size-mismatch')
  })

  it('re-records when asked to update, and then matches the new image', async () => {
    await compareBaseline('s', withSquare(5, 5, 10), opts())
    vi.stubEnv('ORIVON_QA_UPDATE_BASELINES', '1')
    expect((await compareBaseline('s', withSquare(20, 20, 10), opts())).status).toBe('recorded')
    vi.stubEnv('ORIVON_QA_UPDATE_BASELINES', '')
    expect((await compareBaseline('s', withSquare(20, 20, 10), opts())).status).toBe('match')
  })

  it('does nothing unless the qa scripts asked for pixels: no comparison, no baseline written', async () => {
    vi.stubEnv('ORIVON_QA_PIXELS', '')
    const r = await compareBaseline('s', flat(), opts())
    expect(r.status).toBe('skipped')
    await expect(readFile(join(baselineDir(), 's.png'))).rejects.toThrow()
  })

  it('does nothing under CI=true: no comparison, no baseline written', async () => {
    vi.stubEnv('CI', 'true')
    const r = await compareBaseline('s', flat(), opts())
    expect(r.status).toBe('skipped')
    await expect(readFile(join(baselineDir(), 's.png'))).rejects.toThrow()
  })
})
