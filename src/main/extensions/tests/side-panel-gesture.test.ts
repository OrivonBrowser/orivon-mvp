import { describe, expect, it } from 'vitest'
import { createGestureLedger, createTabGesture, GESTURE_WINDOW_MS } from '../side-panel-gesture.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function make () {
  let now = 1_000_000
  const ledger = createGestureLedger(() => now)
  return { ledger, advance: (ms: number) => { now += ms } }
}

describe('the gesture ledger', () => {
  it('is empty until the browser saw input', () => {
    expect(make().ledger.available(ID)).toBe(false)
  })

  it('counts input for five seconds and not after', () => {
    expect(GESTURE_WINDOW_MS).toBe(5000)
    const { ledger, advance } = make()
    ledger.record(ID)
    advance(4999)
    expect(ledger.available(ID)).toBe(true)
    advance(2)
    expect(ledger.available(ID)).toBe(false)
  })

  it('belongs to the extension the input was made on', () => {
    const { ledger } = make()
    ledger.record(ID)
    expect(ledger.available(OTHER)).toBe(false)
  })

  it('is used up by one spend', () => {
    const { ledger } = make()
    ledger.record(ID)
    ledger.spend(ID)
    expect(ledger.available(ID)).toBe(false)
  })

  it('is cleared when the extension unloads', () => {
    const { ledger } = make()
    ledger.record(ID)
    ledger.clear(ID)
    expect(ledger.available(ID)).toBe(false)
  })

  it('takes new input after a spend', () => {
    const { ledger } = make()
    ledger.record(ID)
    ledger.spend(ID)
    ledger.record(ID)
    expect(ledger.available(ID)).toBe(true)
  })
})

type Listener = (event: unknown, input: { type: string }) => void
function fakeTab () {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {}
  return {
    on: (event: string, listener: (...args: never[]) => void) => { (listeners[event] ??= []).push(listener) },
    press: (type: string) => { for (const l of listeners['input-event'] ?? []) (l as Listener)({}, { type }) },
    navigate: () => { for (const l of listeners['did-navigate'] ?? []) l() }
  }
}

describe('the gesture a click in a page gives', () => {
  function tabSetup () {
    let now = 1_000_000
    const gesture = createTabGesture(() => now)
    const tab = fakeTab()
    gesture.watch(tab as never)
    return { gesture, tab, advance: (ms: number) => { now += ms } }
  }

  it('is absent until the browser saw input in the tab', () => {
    const { gesture, tab } = tabSetup()
    expect(gesture.available(tab as never, true, ID)).toBe(false)
  })

  it.each(['mouseDown', 'pointerDown', 'touchStart', 'keyDown', 'rawKeyDown'])('is given by %s', (type) => {
    const { gesture, tab } = tabSetup()
    tab.press(type)
    expect(gesture.available(tab as never, true, ID)).toBe(true)
  })

  it.each(['mouseMove', 'mouseUp', 'mouseWheel', 'keyUp', 'char'])('is not given by %s', (type) => {
    const { gesture, tab } = tabSetup()
    tab.press(type)
    expect(gesture.available(tab as never, true, ID)).toBe(false)
  })

  it('lasts as long as the ledger\'s window and not after', () => {
    const { gesture, tab, advance } = tabSetup()
    tab.press('mouseDown')
    advance(GESTURE_WINDOW_MS)
    expect(gesture.available(tab as never, true, ID)).toBe(true)
    advance(1)
    expect(gesture.available(tab as never, true, ID)).toBe(false)
  })

  it('needs the extension to reach the page, whatever the input', () => {
    const { gesture, tab } = tabSetup()
    tab.press('mouseDown')
    expect(gesture.available(tab as never, false, ID)).toBe(false)
    expect(gesture.available(tab as never, true, ID)).toBe(true)
  })

  it('is spent by one extension, and the next input is new', () => {
    const { gesture, tab } = tabSetup()
    tab.press('mouseDown')
    gesture.spend(tab as never, ID)
    expect(gesture.available(tab as never, true, OTHER)).toBe(false)
    tab.press('keyDown')
    expect(gesture.available(tab as never, true, ID)).toBe(true)
  })

  it('is forgotten when the tab goes to another document', () => {
    const { gesture, tab } = tabSetup()
    tab.press('mouseDown')
    tab.navigate()
    expect(gesture.available(tab as never, true, ID)).toBe(false)
  })

  it('belongs to the tab the input was made in', () => {
    const { gesture, tab } = tabSetup()
    const other = fakeTab()
    gesture.watch(other as never)
    tab.press('mouseDown')
    expect(gesture.available(other as never, true, ID)).toBe(false)
  })

  it('is absent in a tab nobody watches', () => {
    const { gesture } = tabSetup()
    expect(gesture.available(fakeTab() as never, true, ID)).toBe(false)
  })
})

describe('the gesture of a click, spent per extension', () => {
  const A = 'a'.repeat(32)
  const B = 'b'.repeat(32)
  function setup () {
    let now = 1_000_000
    const gesture = createTabGesture(() => now)
    const tab = fakeTab()
    gesture.watch(tab as never)
    return { gesture, tab, advance: (ms: number) => { now += ms } }
  }

  it('lets the extension that spent it use it again, for a second request from the same click', () => {
    const { gesture, tab } = setup()
    tab.press('mouseDown')
    gesture.spend(tab as never, A)
    expect(gesture.available(tab as never, true, A)).toBe(true)
  })

  it('does not lend it to another extension once one has spent it', () => {
    const { gesture, tab } = setup()
    tab.press('mouseDown')
    gesture.spend(tab as never, A)
    expect(gesture.available(tab as never, true, B)).toBe(false)
  })

  it('is new input that every extension can use again', () => {
    const { gesture, tab } = setup()
    tab.press('mouseDown')
    gesture.spend(tab as never, A)
    tab.press('keyDown')
    expect(gesture.available(tab as never, true, B)).toBe(true)
  })

  it('still ends with the window and at a navigation for the extension that spent it', () => {
    const { gesture, tab, advance } = setup()
    tab.press('mouseDown')
    gesture.spend(tab as never, A)
    advance(GESTURE_WINDOW_MS + 1)
    expect(gesture.available(tab as never, true, A)).toBe(false)
    tab.press('mouseDown')
    gesture.spend(tab as never, A)
    tab.navigate()
    expect(gesture.available(tab as never, true, A)).toBe(false)
  })
})
