import { describe, expect, it, vi } from 'vitest'
import { actionMenuTemplate } from '../action-context-menu.js'

const input = (over: Partial<Parameters<typeof actionMenuTemplate>[0]> = {}): Parameters<typeof actionMenuTemplate>[0] => ({
  name: 'Alpha', hasOptions: true, pinned: true, extensionItems: [], openOptions: vi.fn(), togglePin: vi.fn(), manage: vi.fn(), remove: vi.fn(), ...over
})

describe('actionMenuTemplate', () => {
  it('names the extension, then Options, the pin, Manage and Remove, in Title Case', () => {
    const template = actionMenuTemplate(input())
    expect(template).toEqual([
      { label: 'Alpha', enabled: false },
      { type: 'separator' },
      expect.objectContaining({ label: 'Options', enabled: true }),
      expect.objectContaining({ label: 'Unpin from Toolbar' }),
      expect.objectContaining({ label: 'Manage Extension' }),
      expect.objectContaining({ label: 'Remove from Orivon…' })
    ])
  })

  it('offers to pin an unpinned extension and greys Options when there is none', () => {
    const template = actionMenuTemplate(input({ pinned: false, hasOptions: false }))
    expect(template[2]).toMatchObject({ label: 'Options', enabled: false })
    expect(template[3]).toMatchObject({ label: 'Pin to Toolbar' })
  })

  it('places what the extension added between its name and Orivon\'s entries', () => {
    const own = { label: 'Do the thing' }
    const template = actionMenuTemplate(input({ extensionItems: [own] }))
    expect(template.map((item) => ('label' in item ? item.label : item.type))).toEqual(['Alpha', 'separator', 'Do the thing', 'separator', 'Options', 'Unpin from Toolbar', 'Manage Extension', 'Remove from Orivon…'])
  })

  it('offers Open Side Panel first among Orivon\'s entries only when the extension has a panel, and runs it', () => {
    expect(actionMenuTemplate(input()).some((item) => 'label' in item && item.label === 'Open Side Panel')).toBe(false)
    const openSidePanel = vi.fn()
    const template = actionMenuTemplate(input({ openSidePanel }))
    expect(template.map((item) => ('label' in item ? item.label : item.type))).toEqual(['Alpha', 'separator', 'Open Side Panel', 'Options', 'Unpin from Toolbar', 'Manage Extension', 'Remove from Orivon…'])
    ;(template[2] as { click: () => void }).click()
    expect(openSidePanel).toHaveBeenCalledTimes(1)
  })

  it('runs the effect each entry was given', () => {
    const effects = { openOptions: vi.fn(), togglePin: vi.fn(), manage: vi.fn(), remove: vi.fn() }
    const template = actionMenuTemplate(input(effects))
    for (const item of template) (item as { click?: () => void }).click?.()
    for (const effect of Object.values(effects)) expect(effect).toHaveBeenCalledTimes(1)
  })
})
