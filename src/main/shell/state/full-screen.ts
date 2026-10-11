import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the window fills the screen: on macOS the system then hides the window buttons, and the chrome draws its own. */
export const fullScreenStatePart: ShellStatePart = {
  name: 'fullScreen',
  read: ({ window }) => ({ fullScreen: window.window.isFullScreen() }),
  watch: ({ window }, push) => {
    const win = window.window
    win.on('enter-full-screen', push)
    win.on('leave-full-screen', push)
    return () => {
      win.off('enter-full-screen', push)
      win.off('leave-full-screen', push)
    }
  }
}
