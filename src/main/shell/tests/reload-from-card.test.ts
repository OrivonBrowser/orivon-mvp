import { describe, expect, it, vi } from 'vitest'
import { reloadFromCard } from '../reload-from-card.js'

describe('reloadFromCard', () => {
  it('closes the card before the tab in front reloads', () => {
    const events: string[] = []
    const card = { close: vi.fn(() => { events.push('close') }) }
    const tabs = { getState: () => ({ activeTabId: 't1' }), reload: vi.fn((id: string) => { events.push(`reload ${id}`) }) }

    reloadFromCard(card, tabs)

    expect(events).toEqual(['close', 'reload t1'])
  })

  it('closes the card and reloads nothing when no tab is in front', () => {
    const card = { close: vi.fn() }
    const tabs = { getState: () => ({ activeTabId: null }), reload: vi.fn() }

    reloadFromCard(card, tabs)

    expect(card.close).toHaveBeenCalledOnce()
    expect(tabs.reload).not.toHaveBeenCalled()
  })
})
