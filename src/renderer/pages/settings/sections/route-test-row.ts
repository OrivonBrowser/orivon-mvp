// The "Test the tunnel" row's control: a button and the answer beside it, a custom control because it is a result
// rather than a setting.
import { h } from '../../shared/dom.js'
import { proxyTestWords } from '../route-part.js'
import type { RoutePart } from '../route-part.js'
import type { SettingsState } from '../state.js'

export function renderProxyTest (state: SettingsState): HTMLElement {
  const part = state.part<RoutePart>('route')
  const address = String(state.value('network.route.proxy') ?? '')
  const button = h('button', {
    className: 'btn',
    type: 'button',
    textContent: part.busy ? 'Testing…' : 'Test',
    disabled: part.busy || address === '',
    onclick: () => { void part.test(address) }
  })
  // An answer is about the address it was asked of: once the setting holds another, it says nothing.
  const answer = part.last !== null && part.last.address === address ? part.last.result : null
  return h('span', { className: 'route-test' },
    answer === null ? h('span') : h('span', { className: answer.ok ? 'muted' : 'problem', role: answer.ok ? 'status' : 'alert', textContent: proxyTestWords(answer) }),
    button)
}
