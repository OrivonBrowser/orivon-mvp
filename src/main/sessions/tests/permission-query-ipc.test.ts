import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_QUERY_CHANNEL } from '../../channels.js'
import { readQuery, registerPermissionQueryIpc } from '../permission-query-ipc.js'

describe('reading what the preload sends', () => {
  it('reads one permission name and nothing else', () => {
    expect(readQuery({ name: 'camera' })).toBe('camera')
    expect(readQuery({ name: 'window-management' })).toBe('window-management')
  })

  it.each([
    ['an extra key', { name: 'camera', origin: 'https://a.example' }],
    ['no name', {}],
    ['a name that is not text', { name: 7 }],
    ['an empty name', { name: '' }],
    ['a name too long to be a permission', { name: 'x'.repeat(65) }],
    ['a bare string', 'camera'],
    ['an array', ['camera']],
    ['null', null],
    ['nothing', undefined]
  ])('refuses %s', (_label, raw) => {
    expect(readQuery(raw)).toBeUndefined()
  })
})

describe('the permission-query channel', () => {
  function setup (answer: ReturnType<typeof vi.fn> = vi.fn(() => 'prompt')) {
    const channels = new Map<string, (event: never, raw: unknown) => unknown>()
    registerPermissionQueryIpc({
      ipc: { handle: (channel, listener) => { channels.set(channel, listener as never) } },
      asks: { query: answer as never }
    })
    const main = {}
    const sender = { isDestroyed: () => false, mainFrame: main }
    const reply = (frame: unknown, raw: unknown, contents: unknown = sender): unknown =>
      channels.get(PERMISSION_QUERY_CHANNEL)?.({ sender: contents, senderFrame: frame } as never, raw)
    return { reply, answer, sender, main }
  }

  it('registers one handler, on its own channel', () => {
    const channels: string[] = []
    registerPermissionQueryIpc({ ipc: { handle: (channel) => { channels.push(channel) } }, asks: { query: () => undefined } })
    expect(channels).toEqual([PERMISSION_QUERY_CHANNEL])
  })

  it('asks the registry about the sender\'s own frame origin, read from the frame and never from the message', () => {
    const { reply, answer, sender, main } = setup()
    const frame = Object.assign(main, { origin: 'https://real.example', url: 'https://real.example/page' })
    expect(reply(frame, { name: 'camera' })).toBe('prompt')
    expect(answer).toHaveBeenCalledWith(sender, 'camera', 'https://real.example')
  })

  it('gives the origin of an extension page as Electron writes it', () => {
    const { reply, answer, sender, main } = setup()
    const frame = Object.assign(main, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })
    reply(frame, { name: 'microphone' })
    expect(answer).toHaveBeenCalledWith(sender, 'microphone', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')
  })

  it('answers null, asking nobody, for a frame that is not the sender\'s top frame', () => {
    const { reply, answer } = setup()
    expect(reply({ origin: 'https://real.example' }, { name: 'camera' })).toBeNull()
    expect(answer).not.toHaveBeenCalled()
  })

  it('answers null for a frame that is gone, a destroyed sender and a message that does not read', () => {
    const { reply, answer, main } = setup()
    expect(reply(null, { name: 'camera' })).toBeNull()
    expect(reply(main, { name: 'camera' }, { isDestroyed: () => true, mainFrame: main })).toBeNull()
    expect(reply(Object.assign(main, { origin: 'https://real.example' }), { name: 7 })).toBeNull()
    expect(answer).not.toHaveBeenCalled()
  })

  it('answers null when reading the frame throws, as a frame destroyed under the call does', () => {
    const { reply, answer, main } = setup()
    Object.defineProperty(main, 'origin', { get: () => { throw new Error('Render frame was disposed') } })
    expect(reply(main, { name: 'camera' })).toBeNull()
    expect(answer).not.toHaveBeenCalled()
  })

  it('answers null for a frame that does not state an origin', () => {
    const { reply, answer, main } = setup()
    expect(reply(Object.assign(main, { origin: 7 }), { name: 'camera' })).toBeNull()
    expect(answer).not.toHaveBeenCalled()
  })

  it('answers null when nobody owns the name, and when the registry throws', () => {
    const { reply, main } = setup(vi.fn(() => undefined))
    expect(reply(Object.assign(main, { origin: 'https://real.example' }), { name: 'notifications' })).toBeNull()
    const thrown = setup(vi.fn(() => { throw new Error('boom') }))
    expect(thrown.reply(Object.assign(thrown.main, { origin: 'https://real.example' }), { name: 'camera' })).toBeNull()
  })

  it('passes all three states on, and nothing else', () => {
    for (const state of ['granted', 'denied', 'prompt']) {
      const { reply, main } = setup(vi.fn(() => state))
      expect(reply(Object.assign(main, { origin: 'https://real.example' }), { name: 'camera' })).toBe(state)
    }
    const { reply, main } = setup(vi.fn(() => 'maybe'))
    expect(reply(Object.assign(main, { origin: 'https://real.example' }), { name: 'camera' })).toBeNull()
  })
})
