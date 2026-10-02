import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../../overlays/overlay-types.js'
import type { BookmarkNode } from '../../../browsing/bookmark-types.js'

const popups: Array<{ template: Array<{ label?: string, click?: () => void }>, options: unknown }> = []
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: never) => ({ popup: (options: unknown) => { popups.push({ template, options }) } }) },
  clipboard: { writeText: () => {} }
}))

const { bookmarkFolderOverlay } = await import('../folder-overlay.js')
const { harness } = await import('./harness.js')

const anchor = { x: 10, y: 50, width: 80, height: 28 }
const added = <T>(node: T | null): T => node as T

function attached (): { h: ReturnType<typeof harness>, handler: ReturnType<typeof bookmarkFolderOverlay.attach>, work: BookmarkNode, a: BookmarkNode, b: BookmarkNode } {
  const h = harness()
  const work = added(h.store.addFolder({ title: 'Work', parent: 'bar' }))
  const a = added(h.store.addUrl({ url: 'https://a.example/', title: 'A', parent: work.id }))
  const b = added(h.store.addUrl({ url: 'https://b.example/', title: 'B', parent: work.id }))
  const win = { ...h.ctx, send: () => {}, close: h.overlays.close } as unknown as OverlayWindow
  const handler = bookmarkFolderOverlay.attach(win)
  handler.show?.({ id: work.id, anchor })
  return { h, handler, work, a, b }
}

beforeEach(() => { popups.length = 0 })

describe('the folder overlay\'s row actions', () => {
  it('deletes a row by id and answers with the folder listed again', () => {
    const { h, handler, work, a, b } = attached()

    const reply = handler.request({ type: 'remove', id: a.id })

    expect(h.store.node(a.id)).toBeUndefined()
    expect(reply).toMatchObject({ id: work.id, rows: [{ id: b.id }] })
    expect(h.overlays.close).not.toHaveBeenCalled()
  })

  it('lists the overflow menu again from its own index after a delete', () => {
    const { h, handler } = attached()
    const first = added(h.store.addUrl({ url: 'https://c.example/', title: 'C' }))
    const second = added(h.store.addUrl({ url: 'https://d.example/', title: 'D' }))

    const reply = handler.request({ type: 'remove', id: first.id, from: 1 }) as { rows: Array<{ id: string }>, from: number }

    expect(reply.from).toBe(1)
    expect(reply.rows.map((row) => row.id)).toEqual([second.id])
  })

  it('refuses to delete a root, the reading list or an unknown id, and leaves the store alone', () => {
    const { h, handler } = attached()
    const reading = added(h.store.addUrl({ url: 'https://r.example/', title: 'R', parent: 'reading' }))
    const before = h.store.children('bar').length

    for (const id of [reading.id, 'reading', 'bar', 'other', 'nope']) expect(handler.request({ type: 'remove', id }), id).toBeUndefined()

    expect(h.store.node(reading.id)).toBeDefined()
    expect(h.store.children('bar')).toHaveLength(before)
  })

  it('pops the bar\'s own menu for a row at the pointer, and not for the reading list', () => {
    const { h, handler, a } = attached()
    const reading = added(h.store.addUrl({ url: 'https://r.example/', title: 'R', parent: 'reading' }))

    expect(handler.request({ type: 'menu', id: reading.id })).toBeUndefined()
    expect(popups).toHaveLength(0)

    expect(handler.request({ type: 'menu', id: a.id })).toBeUndefined()
    expect(popups).toHaveLength(1)
    expect(popups[0]?.options).not.toHaveProperty('x')
    const labels = popups[0]?.template.map((item) => item.label)
    expect(labels).toContain('Edit…')
    expect(labels).toContain('Delete')
    expect(labels).toContain('Move to Bookmarks Bar')
    expect(h.overlays.close).not.toHaveBeenCalled()
  })

  it('the menu\'s Move to Bookmarks Bar takes the row out of its folder and Delete removes it', () => {
    const { h, handler, a, b } = attached()
    const choose = (id: string, label: string): void => {
      popups.length = 0
      handler.request({ type: 'menu', id })
      popups[0]?.template.find((item) => item.label === label)?.click?.()
    }

    choose(a.id, 'Move to Bookmarks Bar')
    expect(h.store.node(a.id)?.parent).toBe('bar')
    choose(b.id, 'Delete')
    expect(h.store.node(b.id)).toBeUndefined()
  })
})
