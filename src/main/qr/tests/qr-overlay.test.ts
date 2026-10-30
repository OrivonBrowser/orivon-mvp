import { describe, expect, it, vi } from 'vitest'
import { CLOSE_LIKE_POPUP } from '../../overlays/overlay-types.js'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { qrOverlayFor } from '../qr-overlay.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')

function setup (over: { writeClipboard?: (text: string) => Promise<void> } = {}): { handler: OverlayHandler, writeClipboard: ReturnType<typeof vi.fn>, writeFile: ReturnType<typeof vi.fn> } {
  const writeClipboard = vi.fn(over.writeClipboard ?? (async () => {}))
  const writeFile = vi.fn(async () => undefined)
  const def = qrOverlayFor({ writeClipboard, downloadsDir: () => '/d', exists: () => false, writeFile })
  const handler = def.attach({ window: {}, services: {}, send: vi.fn(), close: vi.fn() } as unknown as OverlayWindow)
  return { handler, writeClipboard, writeFile }
}

describe('the QR overlay', () => {
  it('is a sheet at the top right that goes with the tab or the navigation', () => {
    const def = qrOverlayFor({ writeClipboard: vi.fn(async () => {}), downloadsDir: () => '', exists: () => false, writeFile: vi.fn() })
    expect(def).toMatchObject({ name: 'qr', placement: { kind: 'area', at: 'top-right', width: 300 }, focus: 'take', keep: 'fresh' })
    expect(def.closeOn).toEqual({ ...CLOSE_LIKE_POPUP, navigation: true, layout: false })
  })

  it('hands the page the address main gave it, and only that', () => {
    const { handler } = setup()
    expect(handler.show?.({ url: 'https://example.com/a', extra: 1 })).toEqual({ url: 'https://example.com/a' })
    for (const bad of [undefined, null, 'x', {}, { url: 3 }, { url: '' }, { url: 'x'.repeat(40000) }]) expect(handler.show?.(bad), JSON.stringify(bad)?.slice(0, 30)).toBeUndefined()
  })

  it('copies the stored address, never a field the page sends', async () => {
    const { handler, writeClipboard } = setup()
    handler.show?.({ url: 'https://example.com/a' })
    expect(await handler.request({ type: 'copy' })).toEqual({ ok: true })
    expect(writeClipboard).toHaveBeenCalledWith('https://example.com/a')
    expect(await handler.request({ type: 'copy', text: 'https://evil.example/' })).toBeUndefined()
    expect(writeClipboard).toHaveBeenCalledTimes(1)
  })

  it('reports a clipboard that refuses, and one that throws at the call', async () => {
    for (const writeClipboard of [async () => { throw new Error('no clipboard') }, () => { throw new Error('no clipboard') }]) {
      const { handler } = setup({ writeClipboard })
      handler.show?.({ url: 'https://example.com/a' })
      expect(await handler.request({ type: 'copy' })).toEqual({ ok: false })
    }
  })

  it('answers a copy only once the write is done', async () => {
    let finish: () => void = () => {}
    const { handler } = setup({ writeClipboard: async () => await new Promise<void>((resolve) => { finish = resolve }) })
    handler.show?.({ url: 'https://example.com/a' })
    let answered = false
    const answer = Promise.resolve(handler.request({ type: 'copy' })).then((value) => { answered = true; return value })
    await Promise.resolve()
    expect(answered).toBe(false)
    finish()
    expect(await answer).toEqual({ ok: true })
  })

  it('saves a PNG named for the stored address', async () => {
    const { handler, writeFile } = setup()
    handler.show?.({ url: 'https://example.com/a' })
    expect(await handler.request({ type: 'download', png: PNG })).toEqual({ ok: true })
    expect(writeFile).toHaveBeenCalledWith('/d/qr-example.com.png', expect.any(Uint8Array))
  })

  it('refuses an oversize picture, a non-PNG, and a picture with no text', async () => {
    const { handler, writeFile } = setup()
    handler.show?.({ url: 'https://example.com/a' })
    expect(await handler.request({ type: 'download', png: Buffer.alloc(300 * 1024, 7).toString('base64') })).toEqual({ ok: false })
    expect(await handler.request({ type: 'download', png: Buffer.from('plain text, not a picture').toString('base64') })).toEqual({ ok: false })
    expect(await handler.request({ type: 'download' })).toBeUndefined()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('refuses every other command, extra fields, and anything before a show', async () => {
    const { handler } = setup()
    expect(await handler.request({ type: 'copy' })).toBeUndefined()
    handler.show?.({ url: 'https://example.com/a' })
    for (const bad of [undefined, null, 'copy', 3, {}, { type: 'open' }, { type: 'copy', png: PNG }, { type: 'download', png: PNG, path: '/etc/x' }, { type: 'download', png: 3 }]) {
      expect(await handler.request(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})
