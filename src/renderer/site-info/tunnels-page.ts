import type { ProxyAddressResult, TunnelResult } from '../../main/ipc/site-info-ipc.js'
import type { SiteInfo, SiteTunnel, SiteTunnelKind, SiteTunnelProfile } from '../../main/permissions/site-info.js'
import { resultOf } from '../pages/shared/proxy-words.js'
import type { ProxyTestResult } from '../pages/shared/proxy-words.js'
import { renderTunnelsPage } from './tunnel-view.js'
import { ADDRESS_NOT_SAVED, ADDRESS_PROBLEM, tunnelListModel } from './tunnels-model.js'
import { BROWSER_LABEL, browserListModel, firstPanelLabel, initialPanel } from './browser-wide-model.js'
import type { Panel } from './browser-wide-model.js'

// The tunnels page of the popup as it behaves: the two panels (this tab, site or app, and the whole browser), the switches, the
// storage notice before a first move into a profile, the question before a tunnel is set browser-wide while tabs keep their own,
// the proxy's address typed in place (with the question before a change others feel) and the Test of a tunnel. The words and the
// rows are `tunnels-model.ts`'s and `browser-wide-model.ts`'s; the drawing is `tunnel-view.ts`'s. This keeps what the person has
// half done between two drawings.

export interface TunnelsBridge {
  readonly setTunnel: (kind: SiteTunnelKind | null) => Promise<TunnelResult | null>
  readonly setBrowserTunnel: (kind: SiteTunnelKind | null) => Promise<TunnelResult | null>
  readonly setNodesTunnel: (on: boolean) => Promise<TunnelResult | null>
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
  /** The tunnel a Browser-wide switch was moved to while the question about the tabs that keep their own is open. */
  let asking: SiteTunnelKind | null = null
  /** The panel shown: decided on the first drawing, and after that only by the person's own click. */
  let panel: Panel | null = null
  let failed = false
  let editor: Editor | null = null
  let test: { kind: SiteTunnelKind, busy: boolean, result: ProxyTestResult | null } | null = null
  /** Where the keyboard goes after the next drawing. */
  let focus: string | null = null

  /** Takes what main answered to a change, whether it was done or not. */
  function answered (result: TunnelResult | null): void {
    failed = result === null || !result.ok
    if (result !== null) deps.setInfo(result.info)
    deps.redraw()
  }

  async function setTunnel (kind: SiteTunnelKind | null): Promise<void> {
    notice = null
    answered(await deps.bridge.setTunnel(kind))
  }

  async function setBrowser (kind: SiteTunnelKind | null): Promise<void> {
    asking = null
    answered(await deps.bridge.setBrowserTunnel(kind))
  }

  function browserShown (): boolean {
    return panel === 'browser' && deps.getInfo()?.browserTunnel !== undefined
  }

  /** The proxy of the panel shown: the website's or tab's own, or the whole browser's. They are the same address, and one count of who goes through it. */
  function proxyOf (info: SiteInfo): SiteTunnel['proxy'] | undefined {
    return browserShown() ? info.browserTunnel?.proxy : info.tunnel?.proxy
  }

  /** A Browser-wide switch was moved to `choice`: a tunnel turned on, or changed, asks first while a tab keeps its own, turning it off asks nothing. */
  function chooseBrowser (choice: SiteTunnelKind | null): void {
    const browser = deps.getInfo()?.browserTunnel
    if (browser === undefined) return
    // Moving the switches back to where they were while the question is open leaves everything as it was.
    if (choice === browser.via) { asking = null; deps.redraw(); return }
    if (choice !== null && browser.tabs.length > 0) { asking = choice; deps.redraw(); return }
    void setBrowser(choice)
  }

  /** The panel shown takes the choice: the first its own tunnel, Browser-wide the whole browser's. */
  function pick (choice: SiteTunnelKind | null): void {
    if (browserShown()) chooseBrowser(choice)
    else choose(choice)
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
      if (thenUse) { pick('socks5'); return }
      deps.redraw()
      return
    }
    editor = { text, error: result?.reason === 'invalid' ? ADDRESS_PROBLEM : ADDRESS_NOT_SAVED, confirm: false, thenUse }
    focus = '#tunnel-proxy-address'
    deps.redraw()
  }

  function onSave (typed: string): void {
    const info = deps.getInfo()
    const proxy = info === null ? undefined : proxyOf(info)
    if (proxy === undefined) return
    const text = typed.trim()
    const thenUse = editor?.thenUse === true
    // The same address: nothing to save, and nobody to ask.
    if (text === proxy.address) { editor = null; if (thenUse) pick('socks5'); else deps.redraw(); return }
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

  /** Goes to the other panel: what was half done on this one is dropped, and the keyboard goes to the tab that was chosen. */
  function showPanel (next: Panel): void {
    if (next === panel) return
    panel = next
    notice = null
    asking = null
    editor = null
    test = null
    failed = false
    focus = `#tunnel-tab-${next}`
    deps.redraw()
  }

  return {
    render: (container, info) => {
      if (panel === null) panel = initialPanel(info)
      const names = info.browserTunnel === undefined ? null : { first: firstPanelLabel(info), browser: BROWSER_LABEL }
      const shown: Panel = names === null ? 'first' : panel
      const browser = shown === 'browser'
      const pending = browser ? asking ?? undefined : notice === null ? undefined : notice.choice
      const model = (browser ? browserListModel : tunnelListModel)(info, { pending, editor, test })
      const view = { notice: browser ? null : notice?.profile ?? null, pending, failed, panel: shown, panels: names }
      renderTunnelsPage(container, info, model, view, {
        onToggle: (kind, next) => {
          failed = false
          // The proxy has no address yet: its switch asks for one, and saving it is what turns the proxy on.
          if (kind === 'socks5' && next && proxyOf(info)?.address === '') {
            editor = { text: editor?.text ?? '', error: null, confirm: false, thenUse: true }
            focus = '#tunnel-proxy-address'
            deps.redraw()
            return
          }
          // The switch moved off while the question about the tabs is open is the one that was moved on: the question is closed.
          if (browser && asking === kind && !next) { asking = null; deps.redraw(); return }
          // The switch of a tunnel turned on picks it; the lit one turned off picks none.
          pick(next ? kind : null)
        },
        onAddressInput: (text) => { if (editor === null) editor = { text, error: null, confirm: false, thenUse: false }; else editor.text = text },
        onSaveAddress: onSave,
        onChangeAddress: () => { editor = { text: proxyOf(info)?.address ?? '', error: null, confirm: false, thenUse: false }; focus = '#tunnel-proxy-address'; deps.redraw() },
        onConfirmAddress: () => { void saveAddress(editor?.text ?? '') },
        onCancelAddress: () => { editor = null; deps.redraw() },
        onTest: (kind) => { void runTest(kind) },
        onConfirm: () => { if (asking !== null) void setBrowser(asking); else void setTunnel(notice === null ? null : notice.choice) },
        onCancel: () => { notice = null; asking = null; deps.redraw() },
        onOpenSettings: (everywhere) => { void deps.bridge.openTunnelSettings(everywhere) },
        onPanel: showPanel,
        onNodes: (next) => { failed = false; void deps.bridge.setNodesTunnel(next).then(answered) }
      })
      // The page was drawn again: the keyboard goes where the last step left it, to Cancel while a question asks, else to the lit switch.
      const lit = browser ? info.browserTunnel?.via : info.tunnel?.via
      const wanted = focus ?? (model.prompt !== null ? '#tunnel-prompt-cancel' : view.notice !== null ? '#tunnel-notice-cancel' : `#tunnel-switch-${lit ?? 'nym'}`)
      focus = null
      queueMicrotask(() => { container.querySelector<HTMLElement>(wanted)?.focus() })
    }
  }
}
