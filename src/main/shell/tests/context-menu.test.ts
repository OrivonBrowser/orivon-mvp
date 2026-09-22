import { describe, expect, it, vi } from 'vitest'
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

const { buildFromTemplate, popup, writeText } = vi.hoisted(() => {
  const popup = vi.fn()
  return { popup, buildFromTemplate: vi.fn((_template: unknown) => ({ popup })), writeText: vi.fn() }
})
vi.mock('electron', () => ({
  Menu: { buildFromTemplate },
  clipboard: { writeText }
}))

const { contextMenuTemplate, showContextMenu } = await import('../context-menu.js')

const NO_EDIT = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false }

function params (overrides: Partial<ContextMenuParams>): ContextMenuParams {
  return {
    x: 10,
    y: 20,
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    editFlags: NO_EDIT,
    frame: null,
    ...overrides
  } as unknown as ContextMenuParams
}

function actions (): Parameters<typeof contextMenuTemplate>[1] & Record<string, ReturnType<typeof vi.fn>> {
  return {
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    copyText: vi.fn(),
    openInNewTab: vi.fn(),
    copyImageAt: vi.fn(),
    inspectAt: vi.fn()
  }
}

const labels = (template: MenuItemConstructorOptions[]): string[] =>
  template.filter((item) => item.type !== 'separator').map((item) => item.label ?? '')

function click (template: MenuItemConstructorOptions[], label: string): void {
  const item = template.find((i) => i.label === label)
  if (item?.click === undefined) throw new Error(`no clickable "${label}"`)
  ;(item.click as () => void)()
}

describe('contextMenuTemplate -- what a right-click in a tab offers', () => {
  it('offers the edit commands in an editable field, each enabled only when the page says it can', () => {
    const template = contextMenuTemplate(params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true, canSelectAll: true } }), actions(), false)
    expect(labels(template)).toEqual(['Cut', 'Copy', 'Paste', 'Select All'])
    const enabled = Object.fromEntries(template.filter((i) => i.label !== undefined).map((i) => [i.label, i.enabled]))
    expect(enabled).toEqual({ Cut: false, Copy: false, Paste: true, 'Select All': true })
  })

  it('offers Copy for selected text outside a field', () => {
    const a = actions()
    const template = contextMenuTemplate(params({ selectionText: 'hello', editFlags: { ...NO_EDIT, canCopy: true, canSelectAll: true } }), a, false)
    expect(labels(template)).toEqual(['Copy', 'Select All'])
    click(template, 'Copy')
    expect(a.copy).toHaveBeenCalledTimes(1)
  })

  it('offers opening and copying a web link', () => {
    const a = actions()
    const template = contextMenuTemplate(params({ linkURL: 'https://example.com/a' }), a, false)
    expect(labels(template)).toContain('Open Link in New Tab')
    expect(labels(template)).toContain('Copy Link Address')
    click(template, 'Open Link in New Tab')
    click(template, 'Copy Link Address')
    expect(a.openInNewTab).toHaveBeenCalledWith('https://example.com/a')
    expect(a.copyText).toHaveBeenCalledWith('https://example.com/a')
  })

  it('copies but never opens a link a new tab could not load (mailto:, javascript:)', () => {
    for (const linkURL of ['mailto:someone@example.com', 'javascript:alert(1)']) {
      const template = contextMenuTemplate(params({ linkURL }), actions(), false)
      expect(labels(template)).not.toContain('Open Link in New Tab')
      expect(labels(template)).toContain('Copy Link Address')
    }
  })

  it('copies an image from where the person clicked', () => {
    const a = actions()
    const template = contextMenuTemplate(params({ mediaType: 'image', hasImageContents: true, srcURL: 'https://example.com/i.png' }), a, false)
    click(template, 'Copy Image')
    expect(a.copyImageAt).toHaveBeenCalledWith(10, 20)
  })

  it('offers Inspect Element only in developer mode', () => {
    const plain = params({ editFlags: { ...NO_EDIT, canSelectAll: true } })
    expect(labels(contextMenuTemplate(plain, actions(), false))).not.toContain('Inspect Element')
    const a = actions()
    const dev = contextMenuTemplate(plain, a, true)
    expect(labels(dev)).toContain('Inspect Element')
    click(dev, 'Inspect Element')
    expect(a.inspectAt).toHaveBeenCalledWith(10, 20)
  })

  it('never opens with a separator first or last, or two in a row', () => {
    const template = contextMenuTemplate(params({ linkURL: 'https://example.com/', mediaType: 'image', hasImageContents: true, isEditable: true, editFlags: NO_EDIT }), actions(), true)
    const kinds = template.map((i) => i.type === 'separator' ? '|' : 'x').join('')
    expect(kinds).not.toMatch(/^\||\|$|\|\|/)
  })

  it('is empty when there is nothing to offer, so no menu opens', () => {
    expect(contextMenuTemplate(params({}), actions(), false)).toEqual([])
  })
})

describe('showContextMenu', () => {
  function fakeContents (destroyed = false): Record<string, ReturnType<typeof vi.fn>> {
    return { cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), copyImageAt: vi.fn(), inspectElement: vi.fn(), isDestroyed: vi.fn(() => destroyed) }
  }

  it('pops the menu up over the given window, and its items act on the tab that was clicked', () => {
    buildFromTemplate.mockClear()
    popup.mockClear()
    const wc = fakeContents()
    const window = {}
    showContextMenu(wc as never, params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true } }), { window: window as never, openInNewTab: vi.fn(), developerMode: false })

    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ window }))
    const template = buildFromTemplate.mock.calls[0]?.[0] as unknown as MenuItemConstructorOptions[]
    click(template, 'Paste')
    expect(wc['paste']).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the tab closed while its menu was open', () => {
    buildFromTemplate.mockClear()
    const wc = fakeContents(true)
    showContextMenu(wc as never, params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true } }), { window: {} as never, openInNewTab: vi.fn(), developerMode: false })
    click(buildFromTemplate.mock.calls[0]?.[0] as unknown as MenuItemConstructorOptions[], 'Paste')
    expect(wc['paste']).not.toHaveBeenCalled()
  })

  it('copies a link through the system clipboard', () => {
    buildFromTemplate.mockClear()
    showContextMenu(fakeContents() as never, params({ linkURL: 'https://example.com/' }), { window: {} as never, openInNewTab: vi.fn(), developerMode: false })
    click(buildFromTemplate.mock.calls[0]?.[0] as unknown as MenuItemConstructorOptions[], 'Copy Link Address')
    expect(writeText).toHaveBeenCalledWith('https://example.com/')
  })

  it('shows nothing when the template is empty', () => {
    buildFromTemplate.mockClear()
    showContextMenu(fakeContents() as never, params({}), { window: {} as never, openInNewTab: vi.fn(), developerMode: false })
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })
})
