import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { TabLifecycle } from '../../shell/tab-lifecycle.js'
import type { TabClosingInfo } from '../../shell/tab-lifecycle.js'
import { Recency } from '../recency.js'

const contents = (name: string): WebContents => ({ name }) as unknown as WebContents
const idOf = (wc: WebContents): string | null => (wc as unknown as { name: string }).name === 'orphan' ? null : (wc as unknown as { name: string }).name

describe('Recency', () => {
  it('orders tabs by when each was last in front, across windows', () => {
    const lifecycle = new TabLifecycle()
    const recency = new Recency(lifecycle, idOf)
    lifecycle.tabActivated(contents('a'))
    lifecycle.tabActivated(contents('b'))
    lifecycle.tabActivated(contents('a'))
    expect(recency.get('a')).toBeGreaterThan(recency.get('b') ?? Infinity)
    expect(recency.get('c')).toBeUndefined()
  })

  it('ignores a webContents that belongs to no tab', () => {
    const lifecycle = new TabLifecycle()
    const recency = new Recency(lifecycle, idOf)
    lifecycle.tabActivated(contents('orphan'))
    expect(recency.map.size).toBe(0)
  })

  it('forgets a tab that closes', () => {
    const lifecycle = new TabLifecycle()
    const recency = new Recency(lifecycle, idOf)
    lifecycle.tabActivated(contents('a'))
    lifecycle.tabClosing({ id: 'a' } as TabClosingInfo)
    expect(recency.get('a')).toBeUndefined()
  })

  it('stops listening once disposed', () => {
    const lifecycle = new TabLifecycle()
    const recency = new Recency(lifecycle, idOf)
    recency.dispose()
    lifecycle.tabActivated(contents('a'))
    expect(recency.map.size).toBe(0)
  })

  it('counts a touch as the newest', () => {
    const recency = new Recency(new TabLifecycle(), idOf)
    recency.touch('a')
    recency.touch('b')
    expect(recency.get('b')).toBeGreaterThan(recency.get('a') ?? Infinity)
  })
})
