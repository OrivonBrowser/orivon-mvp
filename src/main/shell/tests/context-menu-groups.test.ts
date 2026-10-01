import { describe, expect, it, vi } from 'vitest'
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

vi.mock('electron', () => ({ Menu: {}, clipboard: {} }))

const { contextMenuTemplate } = await import('../context-menu.js')
const { DEFAULT_CONTEXT } = await import('../context-menu-groups.js')
type Actions = Parameters<typeof contextMenuTemplate>[1]

const NO_EDIT = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false }

function params (overrides: Partial<ContextMenuParams>): ContextMenuParams {
  return {
    x: 10, y: 20, linkURL: '', linkText: '', srcURL: '', mediaType: 'none', hasImageContents: false, isEditable: false,
    selectionText: '', misspelledWord: '', dictionarySuggestions: [], editFlags: NO_EDIT, frame: null,
    mediaFlags: { canShowPictureInPicture: false, isShowingPictureInPicture: false },
    ...overrides
  } as unknown as ContextMenuParams
}

function full (): Actions & Record<string, ReturnType<typeof vi.fn> | object> {
  return {
    cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), copyText: vi.fn(), openInNewTab: vi.fn(),
    copyImageAt: vi.fn(), inspectAt: vi.fn(), openInSplit: vi.fn(), openInWindow: vi.fn(), openInPrivate: vi.fn(),
    saveUrl: vi.fn(), search: vi.fn(), run: vi.fn(), replaceMisspelling: vi.fn(), addToDictionary: vi.fn(),
    toggleSpellcheck: vi.fn(), undo: vi.fn(), redo: vi.fn(), pasteAndMatchStyle: vi.fn(), pasteAndGo: vi.fn(),
    navigate: { canGoBack: false, canGoForward: true, back: vi.fn(), forward: vi.fn(), reload: vi.fn() }
  }
}

function withoutNavigation (): Actions {
  const { navigate: _navigate, ...rest } = full()
  return rest as unknown as Actions
}

const labels = (template: MenuItemConstructorOptions[]): string[] =>
  template.map((item) => item.type === 'separator' ? '|' : item.label ?? '')

function click (template: MenuItemConstructorOptions[], label: string): void {
  const item = template.find((i) => i.label === label)
  if (item?.click === undefined) throw new Error(`no clickable "${label}" in ${labels(template).join(', ')}`)
  ;(item.click as () => void)()
}

const ctx = { ...DEFAULT_CONTEXT, engineLabel: 'DuckDuckGo' }

describe('link group', () => {
  it('offers every way to open, save and copy a web link, in that order', () => {
    const template = contextMenuTemplate(params({ linkURL: 'https://example.com/a', linkText: 'A link' }), full(), false, ctx)
    expect(labels(template)).toEqual([
      'Open Link in New Tab', 'Open Link in New Window', 'Open Link in Private Window', 'Open Link in Split View', '|',
      'Save Link As…', 'Copy Link Address', 'Copy Link Text'
    ])
  })

  it('sends the address to the right action', () => {
    const a = full()
    const template = contextMenuTemplate(params({ linkURL: 'https://example.com/a', linkText: ' text ' }), a, false, ctx)
    click(template, 'Open Link in New Window')
    click(template, 'Open Link in Private Window')
    click(template, 'Save Link As…')
    click(template, 'Copy Link Text')
    expect(a.openInWindow).toHaveBeenCalledWith('https://example.com/a')
    expect(a.openInPrivate).toHaveBeenCalledWith('https://example.com/a')
    expect(a.saveUrl).toHaveBeenCalledWith('https://example.com/a')
    expect(a.copyText).toHaveBeenCalledWith('text')
  })

  it('shows only Copy Link Address for a javascript: or mailto: link', () => {
    for (const linkURL of ['javascript:alert(1)', 'mailto:a@b.c']) {
      expect(labels(contextMenuTemplate(params({ linkURL }), full(), false, ctx))).toEqual(['Copy Link Address'])
    }
  })

  it('has no Private item where the action is absent (inside a private window)', () => {
    const a = full()
    delete a.openInPrivate
    expect(labels(contextMenuTemplate(params({ linkURL: 'https://example.com/' }), a, false, ctx))).not.toContain('Open Link in Private Window')
  })

  it('leaves out Copy Link Text when the link holds no text', () => {
    expect(labels(contextMenuTemplate(params({ linkURL: 'https://example.com/', linkText: '  ' }), full(), false, ctx))).not.toContain('Copy Link Text')
  })
})

describe('image group', () => {
  const image = { mediaType: 'image', hasImageContents: true, srcURL: 'https://example.com/i.png' } as const

  it('offers open, save and both copies for a web image', () => {
    expect(labels(contextMenuTemplate(params(image), full(), false, ctx))).toEqual(['Open Image in New Tab', 'Save Image As…', 'Copy Image', 'Copy Image Address'])
  })

  it('keeps only Copy Image for a data: or blob: image', () => {
    for (const srcURL of ['data:image/png;base64,AAAA', 'blob:https://example.com/x']) {
      expect(labels(contextMenuTemplate(params({ ...image, srcURL }), full(), false, ctx))).toEqual(['Copy Image'])
    }
  })

  it('shows the link group, then the image group, for an image inside a link', () => {
    const template = contextMenuTemplate(params({ ...image, linkURL: 'https://example.com/go' }), full(), false, ctx)
    const all = labels(template)
    expect(all.indexOf('Open Link in New Tab')).toBeLessThan(all.indexOf('Open Image in New Tab'))
    expect(all).toContain('|')
  })
})

describe('media group', () => {
  it('offers Picture in Picture checked while it is showing, and the address items', () => {
    const video = params({ mediaType: 'video', srcURL: 'https://example.com/v.mp4', mediaFlags: { canShowPictureInPicture: true, isShowingPictureInPicture: true } } as never)
    const a = full()
    const template = contextMenuTemplate(video, a, false, ctx)
    expect(labels(template)).toEqual(['Picture in Picture', 'Open Video in New Tab', 'Save Video As…', 'Copy Video Address'])
    expect(template[0]).toMatchObject({ type: 'checkbox', checked: true })
    click(template, 'Picture in Picture')
    expect(a.run).toHaveBeenCalledWith('page.pip')
  })

  it('pops out the video that was clicked, at the place clicked, when the window can do that', () => {
    const video = params({ mediaType: 'video', srcURL: 'https://example.com/v.mp4', mediaFlags: { canShowPictureInPicture: true, isShowingPictureInPicture: false } } as never)
    const a = { ...full(), pipAt: vi.fn() }
    click(contextMenuTemplate(video, a as never, false, ctx), 'Picture in Picture')
    expect(a.pipAt).toHaveBeenCalledWith(video.x, video.y)
    expect(a.run).not.toHaveBeenCalled()
  })

  it('names audio as audio and has no Picture in Picture', () => {
    const audio = params({ mediaType: 'audio', srcURL: 'https://example.com/a.mp3' })
    expect(labels(contextMenuTemplate(audio, full(), false, ctx))).toEqual(['Open Audio in New Tab', 'Save Audio As…', 'Copy Audio Address'])
  })

  it('offers only Picture in Picture for a video with a blob: source', () => {
    const video = params({ mediaType: 'video', srcURL: 'blob:https://example.com/x', mediaFlags: { canShowPictureInPicture: true, isShowingPictureInPicture: false } } as never)
    expect(labels(contextMenuTemplate(video, full(), false, ctx))).toEqual(['Picture in Picture'])
  })
})

describe('selection group', () => {
  it('offers Copy and a search worded with the engine and the cut text', () => {
    const a = full()
    const text = `  ${'word '.repeat(20)} `
    const template = contextMenuTemplate(params({ selectionText: text, editFlags: { ...NO_EDIT, canCopy: true } }), a, false, ctx)
    const all = labels(template)
    expect(all[0]).toBe('Copy')
    expect(all[1]).toMatch(/^Search DuckDuckGo for “word word word word word word…”$/)
    click(template, all[1] as string)
    expect(a.search).toHaveBeenCalledWith(text.replace(/\s+/g, ' ').trim())
  })

  it('has no search for a blank selection', () => {
    expect(contextMenuTemplate(params({ selectionText: ' \n ' }), withoutNavigation(), false, ctx)).toEqual([])
  })

  it('shows the editable group only for a selection inside a field', () => {
    const all = labels(contextMenuTemplate(params({ isEditable: true, selectionText: 'abc', editFlags: { ...NO_EDIT, canCopy: true, canCut: true } }), full(), false, ctx))
    expect(all.some((label) => label.startsWith('Search'))).toBe(false)
    expect(all).toContain('Cut')
  })
})

describe('editable group', () => {
  it('lists undo and redo, the clipboard commands, select all and the spelling check', () => {
    const template = contextMenuTemplate(params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true, canUndo: true } }), full(), false, ctx)
    expect(labels(template)).toEqual([
      'Undo', 'Redo', '|', 'Cut', 'Copy', 'Paste', 'Paste and Go', 'Paste as Plain Text', '|', 'Select All', '|', 'Check Spelling'
    ])
    expect(template.find((i) => i.label === 'Undo')?.enabled).toBe(true)
    expect(template.find((i) => i.label === 'Redo')?.enabled).toBe(false)
    expect(template.find((i) => i.label === 'Paste and Go')?.enabled).toBe(true)
    expect(template.find((i) => i.label === 'Check Spelling')).toMatchObject({ type: 'checkbox', checked: true })
  })

  it('shows the spelling check unchecked while the setting is off, and toggles it', () => {
    const a = full()
    const template = contextMenuTemplate(params({ isEditable: true }), a, false, { ...ctx, spellcheckOn: false })
    expect(template.find((i) => i.label === 'Check Spelling')).toMatchObject({ checked: false })
    click(template, 'Check Spelling')
    expect(a.toggleSpellcheck).toHaveBeenCalledTimes(1)
  })
})

describe('spelling group', () => {
  it('offers up to five suggestions, each replacing the word, then Add to Dictionary', () => {
    const a = full()
    const template = contextMenuTemplate(params({ isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help', 'hero', 'halo', 'held', 'hell'] }), a, false, ctx)
    const all = labels(template)
    expect(all.slice(0, 7)).toEqual(['hello', 'help', 'hero', 'halo', 'held', '|', 'Add to Dictionary'])
    click(template, 'help')
    click(template, 'Add to Dictionary')
    expect(a.replaceMisspelling).toHaveBeenCalledWith('help')
    expect(a.addToDictionary).toHaveBeenCalledWith('helo')
  })

  it('says so when there are no suggestions, with a disabled row', () => {
    const template = contextMenuTemplate(params({ isEditable: true, misspelledWord: 'zzqx' }), full(), false, ctx)
    expect(template[0]).toMatchObject({ label: 'No Spelling Suggestions', enabled: false })
  })

  it('doubles an ampersand in a suggestion', () => {
    const template = contextMenuTemplate(params({ isEditable: true, misspelledWord: 'x', dictionarySuggestions: ['a&b'] }), full(), false, ctx)
    expect(template[0]?.label).toBe('a&&b')
  })

  it('is absent while spell checking is off', () => {
    const all = labels(contextMenuTemplate(params({ isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello'] }), full(), false, { ...ctx, spellcheckOn: false }))
    expect(all).not.toContain('hello')
    expect(all).not.toContain('Add to Dictionary')
  })

  it('is absent outside an editable field', () => {
    expect(labels(contextMenuTemplate(params({ misspelledWord: 'helo', dictionarySuggestions: ['hello'] }), full(), false, ctx))).not.toContain('hello')
  })
})

describe('the address bar\'s menu', () => {
  it('ends with a tick for Always Show Full Addresses, wired to the switch', () => {
    const a = { ...full(), toggleFullAddresses: vi.fn() }
    const on = contextMenuTemplate(params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true } }), a as never, false, { ...DEFAULT_CONTEXT, fullAddresses: true })
    expect(labels(on).at(-1)).toBe('Always Show Full Addresses')
    expect(on.at(-1)).toMatchObject({ type: 'checkbox', checked: true })
    click(on, 'Always Show Full Addresses')
    expect(a.toggleFullAddresses).toHaveBeenCalledTimes(1)
    const off = contextMenuTemplate(params({ isEditable: true }), a as never, false, DEFAULT_CONTEXT)
    expect(off.at(-1)).toMatchObject({ checked: false })
  })

  it('is absent from every other editable field', () => {
    const template = contextMenuTemplate(params({ isEditable: true }), full(), false, ctx)
    expect(labels(template)).not.toContain('Always Show Full Addresses')
  })
})

describe('page group', () => {
  it('shows navigation, the page tools and view source on a plain page', () => {
    const a = full()
    const template = contextMenuTemplate(params({}), a, false, ctx)
    expect(labels(template)).toEqual(['Back', 'Forward', 'Reload', '|', 'Save Page As…', 'Print…', 'Take a Screenshot', '|', 'View Page Source', 'Create QR Code for This Page'])
    expect(template.find((i) => i.label === 'Back')?.enabled).toBe(false)
    expect(template.find((i) => i.label === 'Forward')?.enabled).toBe(true)
    click(template, 'Print…')
    click(template, 'View Page Source')
    click(template, 'Save Page As…')
    click(template, 'Take a Screenshot')
    click(template, 'Create QR Code for This Page')
    expect(a.run).toHaveBeenCalledWith('page.qr')
    expect(a.run).toHaveBeenCalledWith('page.print')
    expect(a.run).toHaveBeenCalledWith('page.viewSource')
    expect(a.run).toHaveBeenCalledWith('page.save')
    expect(a.run).toHaveBeenCalledWith('page.screenshot')
  })

  it('shows only Back, Forward and Reload on an internal or new-tab page', () => {
    expect(labels(contextMenuTemplate(params({}), full(), false, { ...ctx, bare: true }))).toEqual(['Back', 'Forward', 'Reload'])
  })

  it('is not shown when anything more specific was clicked', () => {
    const all = labels(contextMenuTemplate(params({ linkURL: 'https://example.com/' }), full(), false, ctx))
    expect(all).not.toContain('Back')
  })

  it('is absent from a menu that has no navigation (the chrome\'s)', () => {
    const a = withoutNavigation()
    expect(contextMenuTemplate(params({}), a, false, ctx)).toEqual([])
  })
})

describe('whole menu', () => {
  it('puts Inspect Element last and keeps separators between items only', () => {
    const template = contextMenuTemplate(params({ linkURL: 'https://example.com/', selectionText: 'x', editFlags: { ...NO_EDIT, canCopy: true } }), full(), true, ctx)
    const all = labels(template)
    expect(all[all.length - 1]).toBe('Inspect Element')
    expect(all[0]).not.toBe('|')
    expect(all.join(',')).not.toContain('|,|')
  })
})
