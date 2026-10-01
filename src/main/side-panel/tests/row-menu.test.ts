import { describe, expect, it, vi } from 'vitest'
import { rowMenuTemplate } from '../row-menu.js'

const actions = () => ({ openInTab: vi.fn(), openInWindow: vi.fn(), copyLink: vi.fn(), remove: vi.fn() })

describe('rowMenuTemplate', () => {
  it('offers the three ways to take a link, and Delete, in Title Case', () => {
    const template = rowMenuTemplate(actions())
    expect(template.map((item) => item.type === 'separator' ? '-' : item.label)).toEqual(['Open in New Tab', 'Open in New Window', '-', 'Copy Link', 'Delete'])
  })

  it('runs what each item was given', () => {
    const given = actions()
    const template = rowMenuTemplate(given)
    for (const item of template) (item.click as (() => void) | undefined)?.()
    expect(given.openInTab).toHaveBeenCalledTimes(1)
    expect(given.openInWindow).toHaveBeenCalledTimes(1)
    expect(given.copyLink).toHaveBeenCalledTimes(1)
    expect(given.remove).toHaveBeenCalledTimes(1)
  })

  it('leaves Delete out for a view that deletes nothing', () => {
    const { remove: _remove, ...rest } = actions()
    expect(rowMenuTemplate(rest).map((item) => item.label)).not.toContain('Delete')
  })
})
