import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { featuredProblems, featuredRow, heldEntries, NO_PREFS, readPrefs, tileForOutsider, type FeaturedEntry } from '../featured-model.js'

const FOLDER = join(import.meta.dirname, '../featured')
const shipped = JSON.parse(readFileSync(join(FOLDER, 'featured.json'), 'utf8')) as FeaturedEntry[]

const entry = (id: string, order: number, pinned = false): FeaturedEntry => ({ id, name: id.toUpperCase(), url: `ipfs://${id}.orivonstack.eth`, icon: null, pinned, order })
const ids = (tiles: ReadonlyArray<{ id: string }>): string[] => tiles.map((tile) => tile.id)

describe('featuredRow', () => {
  const entries = [entry('c', 30), entry('a', 10), entry('d', 40, true), entry('b', 20), entry('e', 5, true)]

  it('puts pinned entries first by their order, then the rest by theirs', () => {
    expect(ids(featuredRow(entries, NO_PREFS).tiles)).toEqual(['e', 'd', 'a', 'b', 'c'])
  })

  it('shows the newcomer pin first, adding a tile for an app outside the set', () => {
    const { tiles } = featuredRow(entries, { ...NO_PREFS, newcomerPin: 'ledger' })
    expect(tiles[0]).toMatchObject({ id: 'ledger', name: 'ledger', url: 'ipfs://ledger.orivonstack.eth', icon: null, pinned: true })
    expect(ids(tiles).slice(1)).toEqual(['e', 'd', 'a', 'b', 'c'])
  })

  it('moves a newcomer pin that is in the set to the front, once', () => {
    const { tiles } = featuredRow(entries, { ...NO_PREFS, newcomerPin: 'b' })
    expect(ids(tiles)).toEqual(['b', 'e', 'd', 'a', 'c'])
    expect(tiles[0]?.pinned).toBe(true)
  })

  it('finds a pin given by address', () => {
    expect(ids(featuredRow(entries, { ...NO_PREFS, newcomerPin: 'ipfs://c.orivonstack.eth' }).tiles)[0]).toBe('c')
  })

  it('leaves a removed pin out of the front: back among the rest, or gone if it was never in the set', () => {
    expect(ids(featuredRow(entries, { ...NO_PREFS, unpinned: ['d'] }).tiles)).toEqual(['e', 'a', 'b', 'c', 'd'])
    expect(ids(featuredRow(entries, NO_PREFS).tiles)).not.toContain('ledger')
  })

  it('leaves hidden tiles out and counts the shipped ones', () => {
    const row = featuredRow(entries, { ...NO_PREFS, hidden: ['a', 'e', 'elsewhere'] })
    expect(ids(row.tiles)).toEqual(['d', 'b', 'c'])
    expect(row.hiddenCount).toBe(2)
  })

  it('names an outsider by its address when it has no Orivon name', () => {
    expect(tileForOutsider('https://app.example/')).toMatchObject({ name: 'app.example', url: 'https://app.example/' })
    expect(tileForOutsider('not an app')).toBeNull()
  })
})

describe('readPrefs', () => {
  it('reads what main answers and falls back to none for anything else', () => {
    expect(readPrefs({ newcomerPin: 'a', unpinned: ['b'], hidden: ['c', 4] })).toEqual({ newcomerPin: 'a', unpinned: ['b'], hidden: ['c'] })
    expect(readPrefs(undefined)).toEqual(NO_PREFS)
    expect(readPrefs({ newcomerPin: 3, unpinned: 'x' })).toEqual(NO_PREFS)
  })
})

describe('the shipped Featured data', () => {
  it('is sound: unique slugs, Orivon addresses named by the id, icons that exist', () => {
    expect(featuredProblems(shipped, (file) => existsSync(join(FOLDER, file)))).toEqual([])
  })

  it('names the five apps, in this order', () => {
    expect(ids(featuredRow(shipped, NO_PREFS).tiles)).toEqual(['explore', 'webtorrent', 'asgardex', 'ledgerwallet', 'thelounge'])
  })

  it('has no entry held back for lagging a security or funds fix', () => {
    expect(heldEntries(shipped), 'remove the entry or clear its "hold" once the port has caught up').toEqual([])
  })

  it('reports each kind of problem', () => {
    const bad: FeaturedEntry[] = [
      { ...entry('x', 1), url: 'https://x.example' },
      entry('x', 2),
      { ...entry('Y', 3), icon: 'missing.png' }
    ]
    expect(featuredProblems(bad, () => false)).toEqual([
      'x: the url is not ipfs://x.orivonstack.eth',
      'x: the id is used twice',
      'Y: the id is not a lowercase slug',
      'Y: the url is not ipfs://Y.orivonstack.eth',
      'Y: the icon missing.png is not in featured/'
    ])
  })

  it('reports a held entry', () => {
    expect(heldEntries([{ ...entry('x', 1), hold: { reason: 'lags a funds fix' } }, entry('y', 2)])).toEqual(['x: lags a funds fix'])
  })
})
