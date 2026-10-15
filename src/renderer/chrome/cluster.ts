import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { must } from './context.js'

/** The bookmark star, the zoom chip, and the toolbar's right end: the Available networks button, the
 * profile chip and the menu button. */
export function createCluster (): ChromeModule {
  let bookmarkToggle: HTMLButtonElement | undefined
  let zoomChip: HTMLButtonElement | undefined
  let profileChip: HTMLButtonElement | undefined
  let networksDot: HTMLElement | undefined

  function renderProfile (profile: ShellState['profile']): void {
    if (profileChip === undefined) return
    profileChip.hidden = !profile.shown
    profileChip.dataset['color'] = profile.color
    profileChip.textContent = profile.name
    if (profile.tunnel === undefined) delete profileChip.dataset['tunnel']
    else profileChip.dataset['tunnel'] = profile.tunnel
    profileChip.title = profile.tunnel === 'nym'
      ? 'A private window that goes through Nym only: what it keeps, and what it does not'
      : profile.isPrivate ? 'A private window: what it keeps, and what it does not' : `Profile: ${profile.name}`
  }

  function wireMenu (menuBtn: HTMLButtonElement, ctx: ChromeContext): void {
    // A press on this button takes the focus the open menu holds and closes it; main stamps the press so the click that
    // follows reads as that same gesture however long the button was held. A key has no press.
    menuBtn.addEventListener('pointerdown', (event) => { if (event.button === 0) ctx.shell.press('menu') })
    menuBtn.addEventListener('click', () => { ctx.shell.openMenu(ctx.anchorFor(menuBtn)) })
    // Builds the menu's (kept-warm) view ahead of the click that usually follows a hover or a keyboard
    // tab-stop, so opening it then costs no more than attaching an already-live view -- never at window
    // startup, which would cost every window a hidden renderer process nobody may ever open. Once is
    // enough: a click no hover preceded (a keyboard Enter with no prior focus event, or a test's direct
    // click) still builds it, just not ahead of time.
    let prewarmed = false
    const prewarmOnce = (): void => {
      if (prewarmed) return
      prewarmed = true
      ctx.shell.prewarmMenu()
    }
    menuBtn.addEventListener('pointerenter', prewarmOnce)
    menuBtn.addEventListener('focus', prewarmOnce)
  }

  return {
    name: 'cluster',
    init: (ctx) => {
      const { shell } = ctx
      const toggle = must(document.querySelector<HTMLButtonElement>('#bookmark-toggle'), '#bookmark-toggle missing')
      const networksBtn = must(document.querySelector<HTMLButtonElement>('#networks-btn'), '#networks-btn missing')
      const chip = must(document.querySelector<HTMLButtonElement>('#zoom-chip'), '#zoom-chip missing')
      const profile = must(document.querySelector<HTMLButtonElement>('#profile-chip'), '#profile-chip missing')
      const menuBtn = must(document.querySelector<HTMLButtonElement>('#menu'), '#menu missing')
      bookmarkToggle = toggle
      zoomChip = chip
      profileChip = profile

      // The Available networks popup: the same list whichever tab is in front.
      networksBtn.addEventListener('pointerdown', (event) => { if (event.button === 0) shell.press('networks') })
      networksBtn.addEventListener('click', () => { shell.openNetworks(ctx.anchorFor(networksBtn)) })
      chip.addEventListener('click', () => { shell.runCommand('zoom.reset') })
      profile.addEventListener('click', () => { shell.openInternal(ctx.state()?.profile.isPrivate === true ? 'private' : 'profiles') })
      wireMenu(menuBtn, ctx)
    },
    render: (state, ctx) => {
      const active = ctx.activeTab()
      const bookmarked = active !== undefined && state.bookmarked
      bookmarkToggle?.classList.toggle('active', bookmarked)
      bookmarkToggle?.setAttribute('aria-pressed', String(bookmarked))

      if (zoomChip !== undefined) {
        zoomChip.hidden = state.zoomPercent === null
        if (state.zoomPercent !== null) zoomChip.textContent = `${String(state.zoomPercent)}%`
      }
      networksDot ??= document.querySelector<HTMLElement>('#networks-btn .networks-dot') ?? undefined
      if (networksDot !== undefined) networksDot.dataset['dot'] = state.networksDot
      document.documentElement.dataset['private'] = String(state.profile.isPrivate)
      renderProfile(state.profile)
    }
  }
}
