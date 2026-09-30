import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const kit = read('kit.css')

/** Custom properties a stylesheet declares (`--name:` at the start of a declaration). */
const declared = (css: string): Set<string> => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string))

describe('the shared UI kit stylesheet', () => {
  it('is imported by the first line of controls.css, so the pages and overlays that load one load both', () => {
    expect(read('controls.css').split('\n')[0]).toBe("@import './kit.css';")
  })

  it('reads only tokens tokens.css declares, or custom properties it sets itself', () => {
    // `--value` (progress) and `--level` (tree depth) are set by the page that draws the component, in a style attribute.
    const known = new Set([...declared(read('tokens.css')), ...declared(kit), '--value', '--level'])
    const used = [...kit.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1] as string)
    expect(used.length).toBeGreaterThan(50)
    expect(used.filter((name) => !known.has(name))).toEqual([])
  })

  it('carries no colour literal of its own outside the one masked chevron', () => {
    const withoutMask = kit.replace(/--tree-chevron:[^;]*;/, '')
    expect(withoutMask.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([])
  })

  it('uses only the radii and font sizes the pages already use', () => {
    const radii = [...kit.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => (match[1] as string).trim())
    const allowed = new Set(['4px', '6px', '8px', '999px', '50%', 'inherit', 'var(--wradius)', '6px 6px 0 0'])
    expect(radii.filter((value) => !allowed.has(value))).toEqual([])
    const sizes = [...kit.matchAll(/font-size:\s*([^;]+);/g)].map((match) => (match[1] as string).trim())
    expect(sizes.filter((value) => !['12px', '12.5px', '13px', '15px'].includes(value))).toEqual([])
  })

  it('switches every animation off under reduced motion', () => {
    const animated = [...kit.matchAll(/animation:\s*(?!none)([a-z-]+)/g)].map((match) => match[1] as string)
    expect(animated.sort()).toEqual(['kit-spin', 'progress-slide', 'skeleton-pulse'])
    const reduced = kit.slice(kit.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.spinner, .skeleton, .progress.indeterminate .progress-bar { animation: none; }')
  })
})
