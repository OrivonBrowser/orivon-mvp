// The "Test" row of a tunnel: a button and the answer beside it, a custom control because it is a result rather than a setting. One
// row for Nym and one for the person's proxy, so each is tested whichever is the default.
import { h } from '../../shared/dom.js'
import { nymTestingWords, nymTestWords } from '../../shared/nym-words.js'
import { proxyTestWords } from '../../shared/proxy-words.js'
import type { RoutePart } from '../route-part.js'
import type { SettingsState } from '../state.js'

/** What a test of Nym is about. */
export const NYM_SUBJECT = 'nym'

/** The test of the tunnel `kind`: Nym, or the address saved for the proxy. */
export function renderTunnelTest (kind: 'nym' | 'socks5'): (state: SettingsState) => HTMLElement {
  return (state) => {
    const part = state.part<RoutePart>('route')
    const address = String(state.value('network.route.proxy') ?? '')
    const subject = kind === 'nym' ? NYM_SUBJECT : address
    const busy = part.busy && part.testing === kind
    const button = h('button', {
      className: 'btn',
      type: 'button',
      textContent: busy ? 'Testing…' : 'Test',
      disabled: part.busy || (kind === 'socks5' && (address === '' || state.isHeld('network.route.proxy'))),
      onclick: () => { void part.test(subject, kind) }
    })
    // An answer is about what it was asked of: once the setting holds another address, it says nothing.
    const answer = part.last !== null && part.last.kind === kind && part.last.subject === subject ? part.last.result : null
    const words = answer === null ? '' : answer.nym === true ? nymTestWords(answer) : proxyTestWords(answer)
    return h('span', { className: 'route-test' },
      // An earlier answer is not left standing next to "Testing…".
      busy && kind === 'nym' ? h('span', { className: 'muted', role: 'status', textContent: nymTestingWords() })
        : answer === null || busy ? h('span') : h('span', { className: answer.ok ? 'muted' : 'problem', role: answer.ok ? 'status' : 'alert', textContent: words }),
      button)
  }
}
