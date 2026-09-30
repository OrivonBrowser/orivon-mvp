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
    linkText: '',
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
    expect(labels(template)).toEqual(['Copy'])
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

  it('offers a link in a split view only where a split is offered, and only for a link a tab could load', () => {
    const link = params({ linkURL: 'https://example.com/page' })
    expect(labels(contextMenuTemplate(link, actions(), false))).not.toContain('Open Link in Split View')

    const withSplit = { ...actions(), openInSplit: vi.fn() }
    const template = contextMenuTemplate(link, withSplit, false)
    expect(labels(template)).toContain('Open Link in Split View')
    click(template, 'Open Link in Split View')
    expect(withSplit.openInSplit).toHaveBeenCalledWith('https://example.com/page')

    expect(labels(contextMenuTemplate(params({ linkURL: 'javascript:alert(1)' }), withSplit, false))).not.toContain('Open Link in Split View')
  })

  it('offers Inspect Element only where developer tools are allowed', () => {
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
    showContextMenu(wc as never, params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true } }), { window: window as never, openInNewTab: vi.fn() })

    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ window }))
    const template = buildFromTemplate.mock.calls[0]?.[0] as unknown as MenuItemConstructorOptions[]
    click(template, 'Paste')
    expect(wc['paste']).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the tab closed while its menu was open', () => {
    buildFromTemplate.mockClear()
    const wc = fakeContents(true)
    showContextMenu(wc as never, params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true } }), { window: {} as never, openInNewTab: vi.fn() })
    click(buildFromTemplate.mock.calls[0]?.[0] as unknown as MenuItemConstructorOptions[], 'Paste')
    expect(wc['paste']).not.toHaveBeenCalled()
  })

  it('copies a link through the system clipboard', () => {
    buildFromTemplate.mockClear()
    showContextMenu(fakeContents() as never, params({ linkURL: 'https://example.com/' }), { window: {} as never, openInNewTab: vi.fn() })
    click(buildFromTemplate.mock.calls[0]?.[0] as unknown as MenuItemConstructorOptions[], 'Copy Link Address')
    expect(writeText).toHaveBeenCalledWith('https://example.com/')
  })

  it('shows nothing when the template is empty', () => {
    buildFromTemplate.mockClear()
    showContextMenu(fakeContents() as never, params({}), { window: {} as never, openInNewTab: vi.fn() })
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })
})

describe('showContextMenu -- a tab\'s menu against a chrome menu', () => {
  function tabContents (): Record<string, unknown> {
    const navigationHistory = { canGoBack: vi.fn(() => true), canGoForward: vi.fn(() => false), goBack: vi.fn(), goForward: vi.fn() }
    const session = { addWordToSpellCheckerDictionary: vi.fn() }
    return {
      cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), undo: vi.fn(), redo: vi.fn(), pasteAndMatchStyle: vi.fn(),
      reload: vi.fn(), downloadURL: vi.fn(), replaceMisspelling: vi.fn(), copyImageAt: vi.fn(),
      isDestroyed: vi.fn(() => false), navigationHistory, session
    }
  }
  function settings (values: Record<string, unknown>): { get: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn> } {
    return { get: vi.fn((key: string) => values[key]), set: vi.fn() }
  }
  const lastTemplate = (): MenuItemConstructorOptions[] => buildFromTemplate.mock.calls.at(-1)?.[0] as unknown as MenuItemConstructorOptions[]

  it('gives a tab the page group, wired to the tab\'s history and reload', () => {
    buildFromTemplate.mockClear()
    const wc = tabContents()
    const run = vi.fn()
    showContextMenu(wc as never, params({}), { window: {} as never, openInNewTab: vi.fn(), page: { bare: () => false }, runCommand: run })
    const template = lastTemplate()
    expect(labels(template)).toEqual(['Back', 'Forward', 'Reload', 'Save Page As…', 'Print…', 'Take a Screenshot', 'View Page Source', 'Create QR Code for This Page'])
    expect(template.find((i) => i.label === 'Back')?.enabled).toBe(true)
    expect(template.find((i) => i.label === 'Forward')?.enabled).toBe(false)
    click(template, 'Back')
    click(template, 'Reload')
    click(template, 'Print…')
    expect((wc['navigationHistory'] as { goBack: () => void }).goBack).toHaveBeenCalledTimes(1)
    expect(wc['reload']).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('page.print')
  })

  it('trims the page group to navigation on a bare page', () => {
    buildFromTemplate.mockClear()
    showContextMenu(tabContents() as never, params({}), { window: {} as never, openInNewTab: vi.fn(), page: { bare: () => true } })
    expect(labels(lastTemplate())).toEqual(['Back', 'Forward', 'Reload'])
  })

  it('saves a link through the tab\'s downloadURL', () => {
    buildFromTemplate.mockClear()
    const wc = tabContents()
    showContextMenu(wc as never, params({ linkURL: 'https://example.com/f.zip' }), { window: {} as never, openInNewTab: vi.fn(), page: { bare: () => false } })
    click(lastTemplate(), 'Save Link As…')
    expect(wc['downloadURL']).toHaveBeenCalledWith('https://example.com/f.zip')
  })

  it('searches the selection with the chosen engine, in the tab put in front', () => {
    buildFromTemplate.mockClear()
    const inFront = vi.fn()
    const background = vi.fn()
    showContextMenu(tabContents() as never, params({ selectionText: 'a b', editFlags: { ...NO_EDIT, canCopy: true } }), {
      window: {} as never,
      openInNewTab: background,
      openInFront: inFront,
      page: { bare: () => false },
      services: { settings: settings({ 'search.engine': 'brave', 'search.customUrl': '', 'spellcheck.enabled': true }) } as never
    })
    const template = lastTemplate()
    expect(labels(template)).toEqual(['Copy', 'Search Brave Search for “a b”'])
    click(template, 'Search Brave Search for “a b”')
    expect(inFront).toHaveBeenCalledWith('https://search.brave.com/search?q=a+b')
    expect(background).not.toHaveBeenCalled()
  })

  it('words a custom engine as "the Web"', () => {
    buildFromTemplate.mockClear()
    showContextMenu(tabContents() as never, params({ selectionText: 'q' }), {
      window: {} as never, openInNewTab: vi.fn(), page: { bare: () => false },
      services: { settings: settings({ 'search.engine': 'custom', 'search.customUrl': 'https://x.test/?q=%s', 'spellcheck.enabled': true }) } as never
    })
    expect(labels(lastTemplate())).toContain('Search the Web for “q”')
  })

  it('switches spell checking off from the editable menu, and hides suggestions while it is off', () => {
    buildFromTemplate.mockClear()
    const store = settings({ 'search.engine': 'duckduckgo', 'search.customUrl': '', 'spellcheck.enabled': true })
    const wc = tabContents()
    showContextMenu(wc as never, params({ isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello'] }), {
      window: {} as never, openInNewTab: vi.fn(), page: { bare: () => false }, services: { settings: store } as never
    })
    const template = lastTemplate()
    click(template, 'hello')
    click(template, 'Add to Dictionary')
    click(template, 'Check Spelling')
    expect(wc['replaceMisspelling']).toHaveBeenCalledWith('hello')
    expect((wc['session'] as { addWordToSpellCheckerDictionary: ReturnType<typeof vi.fn> }).addWordToSpellCheckerDictionary).toHaveBeenCalledWith('helo')
    expect(store.set).toHaveBeenCalledWith('spellcheck.enabled', false)

    buildFromTemplate.mockClear()
    showContextMenu(wc as never, params({ isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello'] }), {
      window: {} as never, openInNewTab: vi.fn(), page: { bare: () => false },
      services: { settings: settings({ 'search.engine': 'duckduckgo', 'search.customUrl': '', 'spellcheck.enabled': false }) } as never
    })
    expect(labels(lastTemplate())).not.toContain('hello')
    expect(lastTemplate().find((i) => i.label === 'Check Spelling')).toMatchObject({ checked: false })
  })

  it('gives the chrome only edit items and Paste and Go, never a page item', () => {
    buildFromTemplate.mockClear()
    const pasteAndGo = vi.fn()
    showContextMenu(tabContents() as never, params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true } }), { window: {} as never, openInNewTab: vi.fn(), pasteAndGo })
    const template = lastTemplate()
    expect(labels(template)).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste and Go', 'Paste as Plain Text', 'Select All'])
    click(template, 'Paste and Go')
    expect(pasteAndGo).toHaveBeenCalledTimes(1)
  })

  it('puts the full-address switch on the chrome\'s menu, ticked from the setting and flipping it', () => {
    buildFromTemplate.mockClear()
    const toggle = vi.fn()
    showContextMenu(tabContents() as never, params({ isEditable: true }), { window: {} as never, openInNewTab: vi.fn(), fullAddresses: { on: () => true, toggle } })
    const template = lastTemplate()
    expect(template.at(-1)).toMatchObject({ label: 'Always Show Full Addresses', type: 'checkbox', checked: true })
    click(template, 'Always Show Full Addresses')
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('shows the chrome nothing for a click on empty space', () => {
    buildFromTemplate.mockClear()
    showContextMenu(tabContents() as never, params({}), { window: {} as never, openInNewTab: vi.fn() })
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('does nothing when the tab is gone before the item is chosen', () => {
    buildFromTemplate.mockClear()
    const wc = tabContents()
    showContextMenu(wc as never, params({ linkURL: 'https://example.com/f.zip' }), { window: {} as never, openInNewTab: vi.fn(), page: { bare: () => false } })
    ;(wc['isDestroyed'] as ReturnType<typeof vi.fn>).mockReturnValue(true)
    click(lastTemplate(), 'Save Link As…')
    expect(wc['downloadURL']).not.toHaveBeenCalled()
  })
})
