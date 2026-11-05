import { describe, expect, it } from 'vitest'
import { topFrameOrigin } from '../top-frame-origin.js'

function sender (overrides: { destroyed?: boolean } = {}) {
  const main = {}
  return { main, contents: { isDestroyed: () => overrides.destroyed === true, mainFrame: main } }
}

describe('topFrameOrigin', () => {
  it('gives the committed origin of the top frame that sent the message', () => {
    const { main, contents } = sender()
    const frame = Object.assign(main, { origin: 'https://real.example' })
    expect(topFrameOrigin({ sender: contents, senderFrame: frame } as never)).toBe('https://real.example')
  })

  it('gives the origin of an extension page as Electron writes it', () => {
    const { main, contents } = sender()
    const frame = Object.assign(main, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })
    expect(topFrameOrigin({ sender: contents, senderFrame: frame } as never)).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop')
  })

  it('gives nothing for a frame that is not the sender\'s top frame', () => {
    const { contents } = sender()
    expect(topFrameOrigin({ sender: contents, senderFrame: { origin: 'https://real.example' } } as never)).toBeUndefined()
  })

  it('gives nothing for a frame that is gone and for a destroyed sender', () => {
    const { main, contents } = sender()
    expect(topFrameOrigin({ sender: contents, senderFrame: null } as never)).toBeUndefined()
    const dead = sender({ destroyed: true })
    expect(topFrameOrigin({ sender: dead.contents, senderFrame: Object.assign(dead.main, { origin: 'https://real.example' }) } as never)).toBeUndefined()
    void main
  })

  it('gives nothing when the origin is not text', () => {
    const { main, contents } = sender()
    expect(topFrameOrigin({ sender: contents, senderFrame: Object.assign(main, { origin: 7 }) } as never)).toBeUndefined()
    expect(topFrameOrigin({ sender: contents, senderFrame: main } as never)).toBeUndefined()
  })

  it('gives nothing when reading the frame throws, as a frame destroyed under the call does', () => {
    const { main, contents } = sender()
    Object.defineProperty(main, 'origin', { get: () => { throw new Error('Render frame was disposed') } })
    expect(topFrameOrigin({ sender: contents, senderFrame: main } as never)).toBeUndefined()
  })
})
