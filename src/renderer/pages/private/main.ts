// The Private page: what a private window keeps and what it does not, stated as
// exactly as it is true, and a button for another. It opens first in every
// private window, and is what the "Private" chip leads to.
import { internalBridge } from '../shared/bridge.js'
import { h } from '../shared/dom.js'

const bridge = internalBridge()

const list = (items: readonly string[]): HTMLElement => h('ul', { className: 'points' }, ...items.map((text) => h('li', { textContent: text })))

document.getElementById('app')?.append(
  h('main', { className: 'page' },
    h('h1', { textContent: 'You are in a private window' }),
    h('p', { className: 'lead', textContent: 'It starts empty, and everything it holds is deleted when you close its last window.' }),
    h('section', { className: 'card' },
      h('h2', { textContent: 'What it keeps until you close it, and then forgets' }),
      list([
        'Cookies, site data and the cache of the sites you visit.',
        'The permissions you give sites and apps. Each is asked for again, and none carries over from your profile.',
        'The files you pick for an app to use, and what an app stores here.',
        'Your bookmarks and zoom levels, if you make any: they are deleted with the window.',
        'Apps work here as anywhere, but start with no permissions and no files of their own.'
      ])),
    h('section', { className: 'card' },
      h('h2', { textContent: 'What it does not keep' }),
      list([
        'A history of the pages you visit.',
        'Usage statistics: none are collected or sent.',
        'Your identity key. Apps that ask for it get a new one for this window, and cannot save secrets with it.'
      ])),
    h('section', { className: 'card' },
      h('h2', { textContent: 'What it does not hide' }),
      list([
        'Your network address: sites, and whoever runs your network, still see where you connect from.',
        'Files you download: they stay on your computer.',
        'Who you are to a site you sign in to.'
      ])),
    h('p', null, h('button', {
      className: 'btn primary',
      type: 'button',
      textContent: 'Open another private window',
      onclick: () => { void bridge.request('profiles', { type: 'newPrivate' }) }
    }))))
