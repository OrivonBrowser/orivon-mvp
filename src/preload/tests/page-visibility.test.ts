import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContext, runInContext } from 'node:vm'

// The page-side half runs as source text in the page's own realm (a vm context here), exactly as
// contextBridge.executeInMainWorld runs it: a closure variable would be a ReferenceError.
let page: any
let handler: ((event: unknown, hidden: unknown) => void) | undefined
const failing = vi.hoisted(() => ({ install: false }))

vi.mock('electron', () => ({
  ipcRenderer: { on: (_channel: string, listener: typeof handler) => { handler = listener } },
  contextBridge: {
    executeInMainWorld: ({ func, args = [] }: { func: (...args: never[]) => unknown, args?: unknown[] }) => {
      if (failing.install) throw new Error('executeInMainWorld is gone')
      return runInContext(`(${func.toString()})(...${JSON.stringify(args)})`, page)
    }
  }
}))

const { installPageVisibility } = await import('../page-visibility.js')

const SETUP = `
  globalThis.Document = class Document extends EventTarget {}
  const proto = Document.prototype
  const nativeGet = (name, value) => Object.getOwnPropertyDescriptor({ get [name] () { return value } }, name).get
  Object.defineProperty(proto, 'visibilityState', { get: nativeGet('visibilityState', 'visible'), set: undefined, enumerable: true, configurable: true })
  Object.defineProperty(proto, 'hidden', { get: nativeGet('hidden', false), set: undefined, enumerable: true, configurable: true })
  Object.defineProperty(proto, 'webkitVisibilityState', { get: nativeGet('webkitVisibilityState', 'visible'), set: undefined, enumerable: true, configurable: true })
  Object.defineProperty(proto, 'webkitHidden', { get: nativeGet('webkitHidden', false), set: undefined, enumerable: true, configurable: true })
  globalThis.document = new Document()
  globalThis.seen = []
  document.addEventListener('visibilitychange', (event) => { seen.push([document.visibilityState, document.hidden, event.bubbles]) })
`

function send (hidden: unknown): void {
  handler?.({}, hidden)
}

beforeEach(() => {
  failing.install = false
  handler = undefined
  page = createContext({ EventTarget, Event, CustomEvent, Object, Array, Math, console })
  runInContext(SETUP, page)
})

const read = (code: string): any => runInContext(code, page)

describe('installPageVisibility', () => {
  it('leaves a visible tab answering what the browser answers', () => {
    installPageVisibility()
    expect(read('[document.visibilityState, document.hidden, document.webkitVisibilityState, document.webkitHidden]')).toEqual(['visible', false, 'visible', false])
    expect(read('seen.length')).toBe(0)
  })

  it('answers hidden on all four properties once the shell says the tab is hidden', () => {
    installPageVisibility()
    send(true)
    expect(read('[document.visibilityState, document.hidden, document.webkitVisibilityState, document.webkitHidden]')).toEqual(['hidden', true, 'hidden', true])
  })

  it('falls back to the browser\'s own answer when the tab is shown again', () => {
    installPageVisibility()
    send(true)
    send(false)
    expect(read('[document.visibilityState, document.hidden, document.webkitVisibilityState, document.webkitHidden]')).toEqual(['visible', false, 'visible', false])
  })

  it('fires one bubbling visibilitychange per change, seeing the new answer, and none when nothing changed', () => {
    installPageVisibility()
    send(true)
    send(true)
    send(false)
    send(false)
    expect(read('seen')).toEqual([['hidden', true, true], ['visible', false, true]])
  })

  it('ignores a message that is not a boolean', () => {
    installPageVisibility()
    send('hidden')
    send(undefined)
    send(1)
    expect(read('document.hidden')).toBe(false)
    expect(read('seen.length')).toBe(0)
  })

  it('answers natively for any document other than the page\'s own', () => {
    installPageVisibility()
    send(true)
    expect(read('new Document().visibilityState')).toBe('visible')
    expect(read('new Document().hidden')).toBe(false)
  })

  it('keeps each property\'s descriptor shape and names the getter as the browser does', () => {
    const shape = (): unknown => read(`['visibilityState', 'hidden', 'webkitVisibilityState', 'webkitHidden'].map((name) => {
      const d = Object.getOwnPropertyDescriptor(Document.prototype, name)
      return [name, d.enumerable, d.configurable, d.set, typeof d.get, d.get.name]
    })`)
    const before = shape()
    installPageVisibility()
    const after = shape() as unknown[][]
    expect(after.map((row) => row.slice(0, 5))).toEqual((before as unknown[][]).map((row) => row.slice(0, 5)))
    expect(after.map((row) => row[5])).toEqual(['get visibilityState', 'get hidden', 'get webkitVisibilityState', 'get webkitHidden'])
  })

  it('adds no global and no own property on the document, however often the state changes', () => {
    const snapshot = (): unknown => read('[Object.keys(globalThis).sort(), Object.getOwnPropertyNames(globalThis).sort(), Object.getOwnPropertyNames(document), Object.getOwnPropertySymbols(globalThis).length]')
    const before = snapshot()
    installPageVisibility()
    send(true)
    send(false)
    expect(snapshot()).toEqual(before)
  })

  it('skips a property this browser does not have and still serves the others', () => {
    runInContext('delete Document.prototype.webkitHidden', page)
    installPageVisibility()
    send(true)
    expect(read('[document.hidden, document.visibilityState, "webkitHidden" in document]')).toEqual([true, 'hidden', false])
  })

  it('fails open: a page the bridge cannot reach keeps the browser\'s answers and the shell\'s messages are not listened for', () => {
    failing.install = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => { installPageVisibility() }).not.toThrow()
      expect(handler).toBeUndefined()
      expect(read('document.hidden')).toBe(false)
    } finally {
      error.mockRestore()
    }
  })

  it('does not let the page fire the change by guessing: a plain visibilitychange from the page changes no answer', () => {
    installPageVisibility()
    read('document.dispatchEvent(new CustomEvent("orivon-visibility", { detail: true }))')
    expect(read('document.hidden')).toBe(false)
  })
})
