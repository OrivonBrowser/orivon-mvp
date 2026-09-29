// Whether the empty tail of the tab strip (after the new-tab button) drags
// the window the way `-webkit-app-region: drag` was meant to, or has to be
// driven from JS instead. Pure: no Electron, so the decision is testable
// without a window.
//
// Under real X11 input, a `-webkit-app-region: drag` region delivers no DOM
// event for any pointer button -- Chromium's Linux window-event filter
// treats the whole area as a caption and consumes the click before it
// reaches the page, and Electron 44 has no `startMove()` to fall back on.
// That is Linux-and-X11-specific and unconfirmed on Wayland: native Wayland
// compositors do not route input through the same caption-click path X11
// window managers do, so the native drag region is left alone there
// (provisionally, pending a real Wayland session to check), as it is on
// Windows and macOS.
//
// Ozone auto-detects and prefers Wayland whenever it is available, but a
// process can still end up rendering through X11 on a Wayland desktop: the
// `--ozone-platform=x11` command-line switch, or the
// `ELECTRON_OZONE_PLATFORM_HINT=x11` environment variable Chromium reads for
// the same choice. Either one means X11 regardless of what the session
// variables below say, since Ozone follows it in preference to auto-detection.

export type DragMode = 'native' | 'manual'

/** `env` is read, not the ambient `process.env`, so this stays a pure function of its inputs.
 * `ozonePlatformSwitch` is `app.commandLine.getSwitchValue('ozone-platform')` -- also passed in,
 * for the same reason, rather than read from `app` here. */
export function dragModeFor (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, ozonePlatformSwitch = ''): DragMode {
  if (platform !== 'linux') return 'native'
  if (ozonePlatformSwitch === 'x11' || env.ELECTRON_OZONE_PLATFORM_HINT === 'x11') return 'manual'
  // Ozone auto-detects and prefers Wayland whenever it is available
  // (orivon-electron skill, "xvfb-run is not enough on a Wayland desktop"):
  // the same two variables that section's own fix strips to force X11 for a
  // headless run are what say, in the other direction, that a real desktop
  // session ended up on Wayland rather than X11.
  const nativeWayland = env.XDG_SESSION_TYPE === 'wayland' || typeof env.WAYLAND_DISPLAY === 'string'
  return nativeWayland ? 'native' : 'manual'
}
