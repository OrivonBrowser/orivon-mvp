// The "Test the tunnel" row's control: a button and the answer beside it, a custom control because it is a result
// rather than a setting.
import { h } from '../../shared/dom.js'
import { nymTestWords } from '../../shared/nym-words.js'
import { proxyTestWords } from '../route-part.js'
import type { RoutePart } from '../route-part.js'
import type { SettingsState } from '../state.js'

/** What a test is about: Nym, or the address the setting holds. */
export const NYM_SUBJECT = 'nym'

export function renderProxyTest (state: SettingsState): HTMLElement {
  const part = state.part<RoutePart>('route')
  const onNym = state.value('network.route.kind') !== 'socks5'
  const address = String(state.value('network.route.proxy') ?? '')
  const subject = onNym ? NYM_SUBJECT : address
  const button = h('button', {
    className: 'btn',
    type: 'button',
    textContent: part.busy ? 'Testing…' : 'Test',
    disabled: part.busy || (!onNym && address === ''),
    onclick: () => { void part.test(subject) }
  })
  // An answer is about what it was asked of: once the setting holds another, it says nothing.
  const answer = part.last !== null && part.last.subject === subject ? part.last.result : null
  const words = answer === null ? '' : answer.nym === true ? nymTestWords(answer) : proxyTestWords(answer)
  return h('span', { className: 'route-test' },
    answer === null ? h('span') : h('span', { className: answer.ok ? 'muted' : 'problem', role: answer.ok ? 'status' : 'alert', textContent: words }),
    button)
}
