import { afterEach, describe, expect, it } from 'vitest'
import { bindDisplayChooser, chooseDisplaySource } from '../../display-capture/bindings.js'
import { createDevChooser, exposeDisplayChooserForTests } from '../dev-display-chooser.js'

const TAB = { getTitle: () => 'A page' } as never
const REQUEST = { tab: {} as never, origin: 'https://a.example', isApp: false, audio: true, hints: { displaySurface: 'browser' as const } }

function setup (): ReturnType<typeof createDevChooser> {
  return createDevChooser({
    firstScreen: async () => await Promise.resolve({ id: 'screen:0:0', name: 'Entire screen' }),
    findTab: (url) => url === 'present' ? TAB : undefined
  })
}

afterEach(() => { bindDisplayChooser(undefined) })

describe('the test-only display chooser', () => {
  it('cancels until told otherwise, and records every call', async () => {
    const dev = setup()
    expect(await dev.chooser(REQUEST, new AbortController().signal)).toBeNull()
    expect(dev.calls).toEqual([{ origin: 'https://a.example', isApp: false, audio: true, hints: { displaySurface: 'browser' } }])
  })

  it('picks the first screen, or a tab by address', async () => {
    const dev = setup()
    dev.use({ kind: 'screen' })
    expect(await dev.chooser(REQUEST, new AbortController().signal)).toMatchObject({ kind: 'screen', source: { id: 'screen:0:0' } })
    dev.use({ kind: 'tab', url: 'present', audio: false })
    expect(await dev.chooser(REQUEST, new AbortController().signal)).toMatchObject({ kind: 'tab', tab: TAB, audio: false, label: 'A page' })
    dev.use({ kind: 'tab', url: 'missing' })
    expect(await dev.chooser(REQUEST, new AbortController().signal)).toBeNull()
  })

  it('binds itself over the gate\'s chooser when told what to pick', async () => {
    const dev = setup()
    dev.use({ kind: 'screen' })
    expect(await chooseDisplaySource(REQUEST, new AbortController().signal)).toMatchObject({ kind: 'screen' })
    expect(dev.calls).toHaveLength(1)
  })

  it('holds its answer for the delay, and gives up when the signal aborts', async () => {
    const dev = setup()
    dev.use({ kind: 'screen', delayMs: 10_000 })
    const controller = new AbortController()
    const pending = dev.chooser(REQUEST, controller.signal)
    controller.abort()
    expect(await pending).toBeNull()
  })

  it('forgets its calls and goes back to cancelling on reset', async () => {
    const dev = setup()
    dev.use({ kind: 'screen' })
    await dev.chooser(REQUEST, new AbortController().signal)
    dev.reset()
    expect(dev.calls).toEqual([])
    expect(await dev.chooser(REQUEST, new AbortController().signal)).toBeNull()
  })

  it('is not exposed on globalThis outside a build that carries the seam', () => {
    exposeDisplayChooserForTests({ firstScreen: async () => await Promise.resolve(undefined), findTab: () => undefined })
    expect(globalThis.__orivonDevDisplayChooser).toBeUndefined()
  })
})
