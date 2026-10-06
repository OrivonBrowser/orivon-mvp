import { describe, expect, it, vi } from 'vitest'
import { onPageReturn, OsPart } from '../settings/os-part.js'
import { SETTINGS_PARTS } from '../settings/settings-parts.js'
import type { OrivonInternal } from '../shared/bridge.js'

type Listener = Parameters<NonNullable<ConstructorParameters<typeof OsPart>[2]>>[0]

function part (replies: unknown[], onReturn: (listener: Listener) => void = () => {}): { part: OsPart, request: ReturnType<typeof vi.fn>, redraws: () => number } {
  let redraws = 0
  const request = vi.fn(async () => replies.shift())
  const bridge = { request } as unknown as OrivonInternal
  return { part: new OsPart(bridge, () => { redraws += 1 }, onReturn), request, redraws: () => redraws }
}

describe('the os Settings part', () => {
  it('is registered under its name', () => {
    expect(SETTINGS_PARTS.map((def) => def.name)).toContain('os')
  })

  it('asks for the default-browser state once, and shows it', async () => {
    const { part: p, request } = part([{ state: 'can-set' }])
    expect(p.view).toBe('loading')
    await p.load()
    expect(p.view).toBe('can-set')
    expect(request).toHaveBeenCalledWith('os', { type: 'defaultBrowser' })
  })

  it('reads an answer that is not one of main\'s as "unavailable", so no button offers a change that cannot happen', async () => {
    for (const reply of [undefined, null, {}, { state: 'maybe' }, 'default']) {
      const { part: p } = part([reply])
      await p.load()
      expect(p.view, JSON.stringify(reply)).toBe('unavailable')
    }
  })

  it('becomes the default after a press that worked, redrawing while it waits and when it is done', async () => {
    const { part: p, request, redraws } = part([{ state: 'can-set' }, { state: 'default', ok: true }])
    await p.load()
    const pressed = p.makeDefault()
    expect(p.busy).toBe(true)
    await pressed
    expect(p.busy).toBe(false)
    expect(p.view).toBe('default')
    expect(p.declined).toBe(false)
    expect(request).toHaveBeenLastCalledWith('os', { type: 'makeDefault' })
    expect(redraws()).toBe(2)
  })

  it('stops waiting and says it did not happen when main fails to answer', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }) => {
      if (command.type === 'makeDefault') throw new Error('main failed')
      return await Promise.resolve({ state: 'can-set' })
    })
    const p = new OsPart({ request } as unknown as OrivonInternal, () => {})
    await p.load()
    await p.makeDefault()
    expect(p.busy).toBe(false)
    expect(p.declined).toBe(true)
    expect(p.view).toBe('can-set')
  })

  it('says the system declined when it is still not the default afterwards', async () => {
    const { part: p } = part([{ state: 'can-set' }, { state: 'can-set', ok: false }])
    await p.load()
    await p.makeDefault()
    expect(p.view).toBe('can-set')
    expect(p.declined).toBe(true)
  })

  it('takes one press at a time', async () => {
    const { part: p, request } = part([{ state: 'can-set' }, { state: 'default' }])
    await p.load()
    const first = p.makeDefault()
    await p.makeDefault()
    await first
    expect(request.mock.calls.filter((call) => (call[1] as { type: string }).type === 'makeDefault')).toHaveLength(1)
  })
})

describe('why it is unavailable', () => {
  it('keeps the reason main gave, and drops one it does not know', async () => {
    for (const [reply, reason] of [[{ state: 'unavailable', reason: 'source' }, 'source'], [{ state: 'unavailable', reason: 'appimage' }, 'appimage'], [{ state: 'unavailable', reason: 'platform' }, 'platform'], [{ state: 'unavailable', reason: 'private' }, 'private'], [{ state: 'unavailable', reason: 'because' }, undefined], [{ state: 'can-set', reason: 'source' }, undefined]] as const) {
      const { part: p } = part([reply])
      await p.load()
      expect(p.reason, JSON.stringify(reply)).toBe(reason)
    }
  })
})

describe('the desktop entry a choice names', () => {
  it('keeps a desktop file name main gave, and drops anything else, since it is shown in a command to paste', async () => {
    for (const [reply, entry] of [[{ state: 'can-set', entry: 'orivon-source.desktop' }, 'orivon-source.desktop'], [{ state: 'can-set', entry: 'x; rm -rf ~/.desktop' }, undefined], [{ state: 'can-set', entry: 7 }, undefined], [{ state: 'can-set' }, undefined]] as const) {
      const { part: p } = part([reply])
      await p.load()
      expect(p.entry, JSON.stringify(reply)).toBe(entry)
    }
  })
})

describe('a hand-over to the system\'s own settings', () => {
  it('is not a declined change: the row says to finish there', async () => {
    const { part: p } = part([{ state: 'can-set' }, { state: 'can-set', ok: false, handedOff: true }])
    await p.load()
    await p.makeDefault()
    expect(p.handedOff).toBe(true)
    expect(p.declined).toBe(false)
    expect(p.view).toBe('can-set')
  })

  it('is forgotten once Orivon turns out to be the default', async () => {
    let returned: Listener = () => {}
    const { part: p, redraws } = part([{ state: 'can-set' }, { state: 'can-set', handedOff: true }, { state: 'default' }], (listener) => { returned = listener })
    await p.load()
    await p.makeDefault()
    const drawn = redraws()
    returned('focus')
    await vi.waitFor(() => { expect(p.view).toBe('default') })
    expect(p.handedOff).toBe(false)
    expect(redraws()).toBe(drawn + 1)
  })
})

describe('coming back to the page', () => {
  it('reads on a focus alone only while a hand-over waits on the person, since focus comes with every click from the address bar', async () => {
    let returned: Listener = () => {}
    const { part: p, request } = part([{ state: 'can-set' }, { state: 'default' }], (listener) => { returned = listener })
    await p.load()
    returned('focus')
    returned('focus')
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    expect(p.view).toBe('can-set')
  })

  it('reads the answer again when the page is shown again, and redraws only when it changed', async () => {
    let returned: Listener = () => {}
    const { part: p, request, redraws } = part([{ state: 'can-set' }, { state: 'can-set' }, { state: 'default' }], (listener) => { returned = listener })
    await p.load()
    returned('shown')
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    expect(redraws()).toBe(0)
    returned('shown')
    await vi.waitFor(() => { expect(p.view).toBe('default') })
    expect(redraws()).toBe(1)
  })

  it('after a hand-over reads the answer again, and redraws each time it changed', async () => {
    let returned: Listener = () => {}
    const { part: p, request, redraws } = part([{ state: 'can-set' }, { state: 'can-set', handedOff: true }, { state: 'can-set' }, { state: 'default' }], (listener) => { returned = listener })
    await p.load()
    await p.makeDefault()
    returned('focus')
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => { expect(p.returnedUndecided).toBe(true) })
    const afterFirst = redraws()
    returned('focus')
    await vi.waitFor(() => { expect(p.view).toBe('default') })
    expect(redraws()).toBe(afterFirst + 1)
  })

  it('answers one read for the focus and the page shown that a single return sends', async () => {
    let returned: Listener = () => {}
    const { part: p, request } = part([{ state: 'can-set' }, { state: 'can-set', handedOff: true }, { state: 'can-set' }, { state: 'can-set' }], (listener) => { returned = listener })
    await p.load()
    await p.makeDefault()
    returned('shown')
    returned('focus')
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('notes that the person came back with the choice still not made, so a prompt that is gone is not still described', async () => {
    let returned: Listener = () => {}
    const { part: p, request } = part([{ state: 'can-set' }, { state: 'can-set', handedOff: true }, { state: 'can-set' }], (listener) => { returned = listener })
    await p.load()
    await p.makeDefault()
    expect(p.returnedUndecided).toBe(false)
    returned('focus')
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => { expect(p.returnedUndecided).toBe(true) })
    expect(p.handedOff).toBe(true)
  })

  it('registers once, however often it loads', async () => {
    const onReturn = vi.fn()
    const { part: p } = part([{ state: 'can-set' }, { state: 'can-set' }], onReturn)
    await p.load()
    await p.load()
    expect(onReturn).toHaveBeenCalledTimes(1)
  })
})

describe('onPageReturn', () => {
  function sources (hidden: boolean): { sources: Parameters<typeof onPageReturn>[1], fire: (target: 'document' | 'window', type: string) => void } {
    const handlers: Record<string, Array<() => void>> = {}
    const target = (name: string): { addEventListener: (type: string, handler: () => void) => void } => ({
      addEventListener: (type, handler) => { (handlers[`${name}:${type}`] ??= []).push(handler) }
    })
    const doc = { ...target('document'), hidden }
    return {
      sources: { document: doc as never, window: target('window') as never },
      fire: (name, type) => { for (const handler of handlers[`${name}:${type}`] ?? []) handler() }
    }
  }

  it('calls back when the page is shown again, and not when it is hidden', () => {
    const calls = vi.fn()
    const shown = sources(false)
    onPageReturn(calls, shown.sources)
    shown.fire('document', 'visibilitychange')
    expect(calls).toHaveBeenCalledTimes(1)
    const hidden = sources(true)
    const none = vi.fn()
    onPageReturn(none, hidden.sources)
    hidden.fire('document', 'visibilitychange')
    expect(none).not.toHaveBeenCalled()
  })

  it('calls back when the window is focused again, which is how a return from the system\'s settings or a confirmation alert shows', () => {
    const calls = vi.fn()
    const s = sources(false)
    onPageReturn(calls, s.sources)
    s.fire('window', 'focus')
    expect(calls).toHaveBeenCalledTimes(1)
  })
})
