import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { hasSite, must } from './context.js'

function isBookmarked (state: ShellState, url: string): boolean {
  return state.bookmarks.some((b) => b.url === url)
}

/** The bookmark star, the zoom chip, and the toolbar's right end: the all-sites permissions button, the
 * profile chip and the menu button. */
export function createCluster (): ChromeModule {
  let bookmarkToggle: HTMLButtonElement | undefined
  let zoomChip: HTMLButtonElement | undefined
  let profileChip: HTMLButtonElement | undefined

  function renderProfile (profile: ShellState['profile']): void {
    if (profileChip === undefined) return
    profileChip.hidden = !profile.shown
    profileChip.dataset['color'] = profile.color
    profileChip.textContent = profile.name
    profileChip.title = profile.isPrivate ? 'A private window: what it keeps, and what it does not' : `Profile: ${profile.name}`
  }

  function wireStar (toggle: HTMLButtonElement, ctx: ChromeContext): void {
    toggle.addEventListener('click', () => {
      const state = ctx.state()
      const active = ctx.activeTab()
      if (state === null || !hasSite(active)) return
      if (isBookmarked(state, active.url)) {
        ctx.shell.removeBookmark(active.url)
      } else {
        ctx.shell.addBookmark(active.url, active.title.length > 0 ? active.title : active.url, active.id)
      }
    })
  }

  function wireMenu (menuBtn: HTMLButtonElement, ctx: ChromeContext): void {
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
      const permissionsBtn = must(document.querySelector<HTMLButtonElement>('#permissions-btn'), '#permissions-btn missing')
      const chip = must(document.querySelector<HTMLButtonElement>('#zoom-chip'), '#zoom-chip missing')
      const profile = must(document.querySelector<HTMLButtonElement>('#profile-chip'), '#profile-chip missing')
      const menuBtn = must(document.querySelector<HTMLButtonElement>('#menu'), '#menu missing')
      bookmarkToggle = toggle
      zoomChip = chip
      profileChip = profile

      wireStar(toggle, ctx)
      // The all-sites popup: always the full list, scrolled to whichever app the CURRENT tab is when there is
      // one. A URL that belongs to no app is harmless -- settings/main.ts finds no card to scroll to and
      // renders the list unscrolled, which is the ordinary open.
      permissionsBtn.addEventListener('click', () => {
        const active = ctx.activeTab()
        shell.openPermissions(ctx.anchorFor(permissionsBtn), hasSite(active) ? active.url : undefined)
      })
      chip.addEventListener('click', () => { shell.runCommand('zoom.reset') })
      profile.addEventListener('click', () => { shell.openInternal(ctx.state()?.profile.isPrivate === true ? 'private' : 'profiles') })
      wireMenu(menuBtn, ctx)
    },
    render: (state, ctx) => {
      const active = ctx.activeTab()
      const bookmarked = active !== undefined && isBookmarked(state, active.url)
      bookmarkToggle?.classList.toggle('active', bookmarked)
      bookmarkToggle?.setAttribute('aria-pressed', String(bookmarked))

      if (zoomChip !== undefined) {
        zoomChip.hidden = state.zoomPercent === null
        if (state.zoomPercent !== null) zoomChip.textContent = `${String(state.zoomPercent)}%`
      }
      document.documentElement.dataset['private'] = String(state.profile.isPrivate)
      renderProfile(state.profile)
    }
  }
}
