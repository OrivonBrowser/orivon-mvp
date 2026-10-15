// The Private page: what a private window keeps and what it does not, stated as
// exactly as it is true, and a button for another. It opens first in every
// private window, and is what the "Private" chip leads to. A private window that
// goes through Nym only says so, and its button opens another like it.
import { internalBridge } from '../shared/bridge.js'
import { h } from '../shared/dom.js'
import { privateIcon } from '../shared/icons.js'
import { privateWords } from './words.js'

const bridge = internalBridge()

const list = (items: readonly string[]): HTMLElement => h('ul', { className: 'points' }, ...items.map((text) => h('li', { textContent: text })))

async function tunnelOfThisWindow (): Promise<'nym' | undefined> {
  try {
    const reply = await bridge.request('profiles', { type: 'list' }) as { tunnel?: unknown } | undefined
    return reply?.tunnel === 'nym' ? 'nym' : undefined
  } catch {
    return undefined
  }
}

void tunnelOfThisWindow().then((tunnel) => {
  const words = privateWords(tunnel)
  if (tunnel === 'nym') document.title = 'Private window with Nym'
  document.getElementById('app')?.append(
    h('main', { className: 'page' },
      h('div', { className: 'top-title' }, privateIcon(), h('h1', { textContent: words.title })),
      h('p', { className: 'lead', textContent: words.lead }),
      h('section', { className: 'card' },
        h('h2', { textContent: 'What it keeps until you close it, and then forgets' }),
        list(words.keeps)),
      h('section', { className: 'card' },
        h('h2', { textContent: 'What it does not keep' }),
        list(words.keepsNot)),
      h('section', { className: 'card' },
        h('h2', { textContent: 'What it does not hide' }),
        list(words.hidesNot)),
      h('p', null, h('button', {
        className: 'btn primary',
        type: 'button',
        textContent: words.another,
        onclick: () => { void bridge.request('profiles', { type: 'newPrivate' }) }
      }))))
})
