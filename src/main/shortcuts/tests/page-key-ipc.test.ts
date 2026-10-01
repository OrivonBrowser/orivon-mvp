import { describe, expect, it, vi } from 'vitest'
import { createPageKeyListener } from '../page-key-ipc.js'
import type { PageKeyTab } from '../page-key-ipc.js'

const FRAME = { url: 'https://app.example/' }
const sender = { id: 7, mainFrame: FRAME }

function setup (tab: Partial<PageKeyTab> | null = {}, allow: (id: number) => boolean = () => true): { send: (payload: unknown, frame?: unknown) => void, run: ReturnType<typeof vi.fn> } {
  const run = vi.fn()
  const listener = createPageKeyListener({
    tabOf: () => (tab === null ? null : { active: true, isAppTab: true, suspended: false, run, ...tab })
  }, allow)
  return { run, send: (payload, frame = FRAME) => { listener({ sender, senderFrame: frame } as never, payload) } }
}

describe('a registered app asking for the browser\'s find bar', () => {
  it('opens find for the tab in front', () => {
    const { send, run } = setup()
    send({ command: 'find.open' })
    expect(run).toHaveBeenCalledWith('find.open')
  })

  it.each([
    ['a command that is not on the list', { command: 'tab.close' }],
    ['no command', {}],
    ['a payload that is not an object', 'find.open']
  ])('ignores %s', (_label, payload) => {
    const { send, run } = setup()
    send(payload)
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores a message from a subframe', () => {
    const { send, run } = setup()
    send({ command: 'find.open' }, { url: 'https://other.example/' })
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['a view in no window', null],
    ['a tab behind the one in front', { active: false }],
    ['an ordinary website, whose key the browser already took', { isAppTab: false }],
    ['a window whose page holds the screen', { suspended: true }]
  ])('ignores %s', (_label, tab) => {
    const { send, run } = setup(tab)
    send({ command: 'find.open' })
    expect(run).not.toHaveBeenCalled()
  })

  it('drops what a page sends faster than the limit allows', () => {
    const { send, run } = setup({}, () => false)
    send({ command: 'find.open' })
    expect(run).not.toHaveBeenCalled()
  })
})
