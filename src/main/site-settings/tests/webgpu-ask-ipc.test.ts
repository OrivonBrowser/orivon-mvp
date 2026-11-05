import { describe, expect, it, vi } from 'vitest'
import { WEBGPU_ASK_CHANNEL } from '../../channels.js'
import { readWebGpuAsk, registerWebGpuAskIpc } from '../webgpu-ask-ipc.js'

describe('reading what the preload sends', () => {
  it('reads whether an adapter was given and nothing else', () => {
    expect(readWebGpuAsk({ adapter: true })).toEqual({ adapter: true })
    expect(readWebGpuAsk({ adapter: false })).toEqual({ adapter: false })
  })

  it.each([
    ['an extra key', { adapter: true, origin: 'https://a.example' }],
    ['no flag', {}],
    ['a flag that is not a boolean', { adapter: 'true' }],
    ['a number', { adapter: 1 }],
    ['a bare boolean', true],
    ['an array', [true]],
    ['null', null],
    ['nothing', undefined]
  ])('refuses %s', (_label, raw) => {
    expect(readWebGpuAsk(raw)).toBeUndefined()
  })
})

describe('the WebGPU channel', () => {
  function setup (ask: ReturnType<typeof vi.fn> = vi.fn(async () => await Promise.resolve(true))) {
    const channels = new Map<string, (event: never, raw: unknown) => unknown>()
    registerWebGpuAskIpc({ ipc: { handle: (channel, listener) => { channels.set(channel, listener as never) } }, ask: ask as never })
    const main = {}
    const sender = { isDestroyed: () => false, mainFrame: main }
    const reply = async (frame: unknown, raw: unknown, contents: unknown = sender): Promise<unknown> =>
      await channels.get(WEBGPU_ASK_CHANNEL)?.({ sender: contents, senderFrame: frame } as never, raw)
    return { reply, ask, sender, main }
  }

  it('registers one handler, on its own channel', () => {
    const channels: string[] = []
    registerWebGpuAskIpc({ ipc: { handle: (channel) => { channels.push(channel) } }, ask: async () => await Promise.resolve(false) })
    expect(channels).toEqual([WEBGPU_ASK_CHANNEL])
  })

  it('asks about the sender\'s own frame origin, read from the frame and never from the message, and passes the answer on', async () => {
    const { reply, ask, sender, main } = setup()
    const frame = Object.assign(main, { origin: 'https://real.example', url: 'https://real.example/page' })
    expect(await reply(frame, { adapter: true })).toBe(true)
    expect(ask).toHaveBeenCalledWith(sender, 'https://real.example', true)
    await reply(frame, { adapter: false })
    expect(ask).toHaveBeenLastCalledWith(sender, 'https://real.example', false)
  })

  it('answers false, asking nobody, for a frame that is not the sender\'s top frame', async () => {
    const { reply, ask } = setup()
    expect(await reply({ origin: 'https://real.example' }, { adapter: true })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('answers false for a frame that is gone, a destroyed sender and a message that does not read', async () => {
    const { reply, ask, main } = setup()
    expect(await reply(null, { adapter: true })).toBe(false)
    expect(await reply(main, { adapter: true }, { isDestroyed: () => true, mainFrame: main })).toBe(false)
    expect(await reply(Object.assign(main, { origin: 'https://real.example' }), { adapter: 'yes' })).toBe(false)
    expect(await reply(Object.assign(main, { origin: 'https://real.example' }), { adapter: true, extra: 1 })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('answers false when reading the frame throws, as a frame destroyed under the call does', async () => {
    const { reply, ask, main } = setup()
    Object.defineProperty(main, 'origin', { get: () => { throw new Error('Render frame was disposed') } })
    expect(await reply(main, { adapter: true })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('answers false for a frame that does not state an origin', async () => {
    const { reply, ask, main } = setup()
    expect(await reply(Object.assign(main, { origin: 7 }), { adapter: true })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('answers false when the decision throws', async () => {
    const { reply, main } = setup(vi.fn(async () => await Promise.reject(new Error('boom'))))
    expect(await reply(Object.assign(main, { origin: 'https://real.example' }), { adapter: true })).toBe(false)
    const sync = setup(vi.fn(() => { throw new Error('boom') }))
    expect(await sync.reply(Object.assign(sync.main, { origin: 'https://real.example' }), { adapter: true })).toBe(false)
  })
})
