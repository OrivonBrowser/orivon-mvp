import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FeaturedStore } from '../featured-store.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-featured-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('FeaturedStore', () => {
  it('keeps the pin, the hidden tiles and the removal across a restart', () => {
    const file = join(dir, 'new-tab.json')
    const first = new FeaturedStore(file)
    expect(first.setNewcomerPin('ipfs://asgardex.orivonstack.eth')).toBe(true)
    first.hide('explore')
    const second = new FeaturedStore(file)
    expect(second.get()).toMatchObject({ newcomerPin: 'asgardex', hidden: ['explore'] })
    second.unpin('asgardex')
    const third = new FeaturedStore(file)
    expect(third.get().newcomerPin).toBeNull()
    expect(third.setNewcomerPin('asgardex')).toBe(false)
    expect(third.get().newcomerPin).toBeNull()
    third.showHidden()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, hidden: [], given: true })
  })

  it('starts empty when the file is missing or damaged', () => {
    expect(new FeaturedStore(join(dir, 'none.json')).get().newcomerPin).toBeNull()
  })

  it('writes no file for a private session', () => {
    const store = new FeaturedStore(null)
    store.setNewcomerPin('explore')
    store.hide('thelounge')
    expect(store.get()).toMatchObject({ newcomerPin: 'explore', hidden: ['thelounge'] })
  })
})
