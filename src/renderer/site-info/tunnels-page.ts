import type { ProxyAddressResult, TunnelResult } from '../../main/ipc/site-info-ipc.js'
import type { SiteInfo, SiteTunnelKind, SiteTunnelProfile } from '../../main/permissions/site-info.js'
import { resultOf } from '../pages/shared/proxy-words.js'
import type { ProxyTestResult } from '../pages/shared/proxy-words.js'
import { renderTunnelsPage } from './tunnel-view.js'
import { ADDRESS_NOT_SAVED, ADDRESS_PROBLEM, tunnelListModel } from './tunnels-model.js'

// The tunnels page of the popup as it behaves: the switches, the storage notice before a first move into a profile, the proxy's
// address typed in place (with the question before a change others feel) and the Test of a tunnel. The words and the rows are
// `tunnels-model.ts`'s; the drawing is `tunnel-view.ts`'s. This keeps what the person has half done between two drawings.

export interface TunnelsBridge {
  readonly setTunnel: (kind: SiteTunnelKind | null) => Promise<TunnelResult | null>
  readonly setProxyAddress: (text: string) => Promise<ProxyAddressResult | null>
  readonly testTunnel: (kind: SiteTunnelKind) => Promise<unknown>
  readonly openTunnelSettings: (everywhere: boolean) => Promise<void>
}

export interface TunnelsPageDeps {
  readonly bridge: TunnelsBridge
  readonly getInfo: () => SiteInfo | null
  readonly setInfo: (info: SiteInfo) => void
  /** Draws the page again from what it now holds. */
  readonly redraw: () => void
}

export interface TunnelsPage {
  render: (container: HTMLElement, info: SiteInfo) => void
}

interface Editor { text: string, error: string | null, confirm: boolean, /** Saving the address also turns the proxy on, because the switch was what asked for it. */ thenUse: boolean }

export function createTunnelsPage (deps: TunnelsPageDeps): TunnelsPage {
  /** The notice before a website first moves into a profile is open: which profile, and the tunnel (or none) the switches were moved to. */
  let notice: { readonly profile: SiteTunnelProfile, readonly choice: SiteTunnelKind | null } | null = null
  let failed = false
  let editor: Editor | null = null
  let test: { kind: SiteTunnelKind, busy: boolean, result: ProxyTestResult | null } | null = null
  /** Where the keyboard goes after the next drawing. */
  let focus: string | null = null

  async function setTunnel (kind: SiteTunnelKind | null): Promise<void> {
    notice = null
    const result = await deps.bridge.setTunnel(kind)
    failed = result === null || !result.ok
    if (result !== null) deps.setInfo(result.info)
    deps.redraw()
  }

  /** A switch was moved to `choice`: the first move into a profile asks first, anything else is done. */
  function choose (choice: SiteTunnelKind | null): void {
    const info = deps.getInfo()
    // Moving the switches back to where they were while the notice is open leaves everything as it was.
    if (choice === (info?.tunnel?.via ?? null)) { notice = null; deps.redraw(); return }
    const profile = info?.tunnel?.notices[choice ?? 'off']
    if (profile !== undefined) { notice = { profile, choice }; deps.redraw(); return }
    void setTunnel(choice)
  }

  async function saveAddress (text: string): Promise<void> {
    const result = await deps.bridge.setProxyAddress(text)
    const thenUse = editor?.thenUse === true
    if (result !== null) deps.setInfo(result.info)
    if (result !== null && result.ok) {
      editor = null
      if (thenUse) { choose('socks5'); return }
      deps.redraw()
      return
    }
    editor = { text, error: result?.reason === 'invalid' ? ADDRESS_PROBLEM : ADDRESS_NOT_SAVED, confirm: false, thenUse }
    focus = '#tunnel-proxy-address'
    deps.redraw()
  }

  function onSave (typed: string): void {
    const info = deps.getInfo()
    const proxy = info?.tunnel?.proxy
    if (proxy === undefined) return
    const text = typed.trim()
    const thenUse = editor?.thenUse === true
    // The same address: nothing to save, and nobody to ask.
    if (text === proxy.address) { editor = null; if (thenUse) choose('socks5'); else deps.redraw(); return }
    const users = proxy.users
    if (proxy.address !== '' && (users.sites + users.apps > 0 || users.everything)) {
      editor = { text, error: null, confirm: true, thenUse }
      focus = '#tunnel-proxy-confirm'
      deps.redraw()
      return
    }
    editor = { text, error: null, confirm: false, thenUse }
    void saveAddress(text)
  }

  async function runTest (kind: SiteTunnelKind): Promise<void> {
    test = { kind, busy: true, result: null }
    deps.redraw()
    const reply = await deps.bridge.testTunnel(kind)
    test = { kind, busy: false, result: reply === null ? null : resultOf(reply) }
    deps.redraw()
  }

  return {
    render: (container, info) => {
      const view = { notice: notice?.profile ?? null, pending: notice === null ? undefined : notice.choice, failed }
      renderTunnelsPage(container, info, tunnelListModel(info, { pending: view.pending, editor, test }), view, {
        onToggle: (kind, next) => {
          failed = false
          // The proxy has no address yet: its switch asks for one, and saving it is what turns the proxy on.
          if (kind === 'socks5' && next && info.tunnel?.proxy.address === '') {
            editor = { text: editor?.text ?? '', error: null, confirm: false, thenUse: true }
            focus = '#tunnel-proxy-address'
            deps.redraw()
            return
          }
          // The switch of a tunnel turned on picks it; the lit one turned off picks none.
          choose(next ? kind : null)
        },
        onAddressInput: (text) => { if (editor === null) editor = { text, error: null, confirm: false, thenUse: false }; else editor.text = text },
        onSaveAddress: onSave,
        onChangeAddress: () => { editor = { text: info.tunnel?.proxy.address ?? '', error: null, confirm: false, thenUse: false }; focus = '#tunnel-proxy-address'; deps.redraw() },
        onConfirmAddress: () => { void saveAddress(editor?.text ?? '') },
        onCancelAddress: () => { editor = null; deps.redraw() },
        onTest: (kind) => { void runTest(kind) },
        onConfirm: () => { void setTunnel(notice === null ? null : notice.choice) },
        onCancel: () => { notice = null; deps.redraw() },
        onOpenSettings: (everywhere) => { void deps.bridge.openTunnelSettings(everywhere) }
      })
      // The page was drawn again: the keyboard goes where the last step left it, to Cancel while the storage notice asks, else to the lit switch.
      const wanted = focus ?? (view.notice !== null ? '#tunnel-notice-cancel' : `#tunnel-switch-${info.tunnel?.via ?? 'nym'}`)
      focus = null
      queueMicrotask(() => { container.querySelector<HTMLElement>(wanted)?.focus() })
    }
  }
}
