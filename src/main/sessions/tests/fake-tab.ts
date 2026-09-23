import { EventEmitter } from 'node:events'
import type { PromptingTab } from '../tab-prompts.js'

export type FakeTab = PromptingTab & {
  touch: (type: string) => void
  navigate: () => void
  getURL: () => string
}

/** A tab's webContents as far as prompting cares: the two events it listens
 * for, emitted the way Electron emits them, and the URL it shows. */
export function fakeTab (url = 'https://example.com/'): FakeTab {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    touch: (type: string) => { emitter.emit('input-event', {}, { type }) },
    navigate: () => { emitter.emit('did-navigate', {}, url, 200, 'OK') },
    getURL: () => url
  })
}
