import type { SiteSummary } from '../../main/permissions/site-info-controller.js'
import type { Web3Score } from '../../main/browsing/site-trust.js'
import type { ShellState, TabState } from '../../main/shell/tabs.js'
import { paintMark, paintShield, shieldLabel, web3Shield } from '../web3-shield.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { hasSite, must } from './context.js'

function originOf (url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** How soon a shield whose provider was still being asked asks again. */
const PENDING_RETRY_MS = 2_000

/** What the address pill says about the active site: the Web3 Score shield and its mark, and the key for
 * the permissions this site has asked for. Both answers come from main a moment after the push that asked,
 * so each remembers what it asked to drop a stale response. */
export function createSiteBadges (): ChromeModule {
  let web3ScoreBtn: HTMLButtonElement | undefined
  let web3MarkEl: HTMLSpanElement | undefined
  let sitePermissionsBtn: HTMLButtonElement | undefined
  let shieldEl: SVGSVGElement | undefined
  let shieldRequestUrl: string | null = null
  let pendingRetry: ReturnType<typeof setTimeout> | undefined
  let shieldOrigin: string | null = null
  let permissionsRequestUrl: string | null = null
  let connectionSecure = false

  function applyShield (score: Web3Score | null): void {
    if (shieldEl === undefined || web3ScoreBtn === undefined || web3MarkEl === undefined) return
    paintShield(shieldEl, score?.level ?? null)
    paintMark(web3MarkEl, score?.level ?? null)
    const label = shieldLabel(score)
    web3ScoreBtn.title = label
    web3ScoreBtn.setAttribute('aria-label', label)
    web3MarkEl.title = label
  }

  /** The shield's displayed-level query, resolved the same lagging, per-active-tab way the permissions key
   * is. A new origin clears the shield and mark first; a push for the SAME origin (a title, a favicon, a
   * load finishing) keeps the level it already shows while re-asking, or every push would flash it grey. */
  function updateShield (active: TabState | undefined, ctx: ChromeContext): void {
    // Skip isNewTab: in dev mode the dashboard's own URL is a plain http://localhost:... address, which has
    // no Website level to show -- an internal page, not a real signal about anything the user visited.
    if (!hasSite(active)) {
      shieldRequestUrl = null
      shieldOrigin = null
      applyShield(null)
      return
    }
    const url = active.url
    shieldRequestUrl = url
    const origin = originOf(url)
    if (origin !== shieldOrigin) {
      shieldOrigin = origin
      applyShield(null)
    }
    askShield(url, ctx)
  }

  function askShield (url: string, ctx: ChromeContext): void {
    void ctx.shell.web3ScoreFor(url).then((score) => {
      if (shieldRequestUrl !== url) return // the active tab moved on; this answer is stale
      applyShield(score)
      // A slow provider (a cold ipfs:// fetch) answers after the page has stopped pushing state.
      if (score?.pending !== true) return
      clearTimeout(pendingRetry)
      pendingRetry = setTimeout(() => { if (shieldRequestUrl === url) askShield(url, ctx) }, PENDING_RETRY_MS)
    })
  }

  function applyPermissionsBadge (summary: SiteSummary): void {
    if (sitePermissionsBtn === undefined) return
    sitePermissionsBtn.hidden = !summary.asked
    sitePermissionsBtn.classList.toggle('has-warning', summary.warning)
    const permissions = summary.warning ? 'Permissions — this site has an unlimited grant' : 'Permissions'
    const label = connectionSecure ? `${permissions}. Connection is secure` : permissions
    sitePermissionsBtn.title = label
    sitePermissionsBtn.setAttribute('aria-label', label)
  }

  /** The key stays hidden until the active site has asked for something at all: an ordinary website carries none. */
  function updatePermissionsBadge (active: TabState | undefined, ctx: ChromeContext): void {
    const url = hasSite(active) ? active.url : null
    permissionsRequestUrl = url
    connectionSecure = active?.connection === 'secure'
    if (url === null) {
      applyPermissionsBadge({ asked: false, warning: false })
      return
    }
    void ctx.shell.siteSummaryFor(url).then((summary) => {
      if (permissionsRequestUrl === url) applyPermissionsBadge(summary)
    })
  }

  return {
    name: 'site-badges',
    init: (ctx) => {
      const scoreBtn = must(document.querySelector<HTMLButtonElement>('#web3-score-btn'), '#web3-score-btn missing')
      // index.html ships this button empty -- built here, once, so applyShield only ever repaints an
      // existing element rather than replacing the button's whole content on every state push.
      shieldEl = web3Shield()
      scoreBtn.append(shieldEl)
      web3ScoreBtn = scoreBtn
      web3MarkEl = must(document.querySelector<HTMLSpanElement>('#web3-mark'), '#web3-mark missing')
      const permissionsBtn = must(document.querySelector<HTMLButtonElement>('#site-permissions-btn'), '#site-permissions-btn missing')
      sitePermissionsBtn = permissionsBtn

      // The site-info popup's two entry points: the shield opens straight to the Web3 Score page, the key to
      // the main page. Both act on the active tab's own url; a click while there is none, or on the
      // dashboard, is a no-op -- there is no origin for either page to describe.
      scoreBtn.addEventListener('click', () => {
        const active = ctx.activeTab()
        if (!hasSite(active)) return
        ctx.shell.openSiteInfo(ctx.anchorFor(scoreBtn), 'web3', active.url)
      })
      permissionsBtn.addEventListener('click', () => {
        const active = ctx.activeTab()
        if (!hasSite(active)) return
        ctx.shell.openSiteInfo(ctx.anchorFor(permissionsBtn), 'main', active.url)
      })
    },
    render: (_state: ShellState, ctx) => {
      const active = ctx.activeTab()
      updateShield(active, ctx)
      updatePermissionsBadge(active, ctx)
    }
  }
}
