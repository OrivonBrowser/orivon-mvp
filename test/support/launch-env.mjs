// What a launch through launch-electron.mjs may do to the machine it runs on: no sound on its speakers, no focus taken
// from whoever is at it, and no window on a Linux desktop outside scripts/run-headless.mjs.

/**
 * This machine's audio output is a real, audible desktop: xvfb hides a
 * window, but nothing hides sound -- Chromium's audio service reaches
 * PipeWire/PulseAudio regardless of the virtual display, so a test page
 * that plays a tone (an oscillator, a captured tab) is heard on the
 * owner's real speakers. `PULSE_SERVER=unix:/nonexistent` makes Chromium's
 * PulseAudio client unable to connect, and it falls back to ALSA;
 * `--alsa-output-device=null` points that ALSA fallback at alsa-lib's own
 * null PCM instead of the real card. Audio still runs at real-time rate
 * (capture and `isCurrentlyAudible()` keep working, measured against
 * a tabCapture feasibility probe), only nothing
 * reaches a speaker. `--mute-audio` was not used instead: it can replace
 * the renderer's own sink with a null one and was not verified to leave
 * tab capture intact.
 */
export const SILENT_AUDIO_ENV = { PULSE_SERVER: 'unix:/nonexistent' }
export const SILENT_AUDIO_SWITCH = '--alsa-output-device=null'

/**
 * The no-focus default of a launch: on, so a run never takes focus from whoever is at the machine, except on a
 * macOS CI runner. Nobody sits at one, and macOS gives no window the keyboard while its app is not the active
 * one, so a window shown inactive there leaves every `isFocused()` false and no key reaches a focused page.
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @returns {'0' | '1'}
 */
export function noFocusDefault (platform, env) {
  return platform === 'darwin' && env['CI'] === 'true' ? '0' : '1'
}

/**
 * Why a launch must not start, or undefined when it may. On a Linux desktop a window only stays off the
 * owner's screen when the launch runs under scripts/run-headless.mjs (a virtual display, the desktop's
 * Wayland socket hidden), which marks its child with ORIVON_RUN_HEADLESS. A driver script that launches
 * Electron without it opens a real window on the desktop, so it is refused here instead.
 * ORIVON_ALLOW_VISIBLE_WINDOW=1 is for a run someone means to watch.
 * @param {Record<string, string | undefined>} env
 * @param {string} [platform]
 * @returns {string | undefined}
 */
export function visibleDesktopRefusal (env, platform = process.platform) {
  if (platform !== 'linux') return undefined
  if (env['ORIVON_RUN_HEADLESS'] !== undefined || env['ORIVON_ALLOW_VISIBLE_WINDOW'] === '1') return undefined
  if (env['WAYLAND_DISPLAY'] === undefined && env['DISPLAY'] === undefined) return undefined
  return 'launchElectron: refusing to open a window on the desktop. Run the command through ' +
    '`node scripts/run-headless.mjs <command>` (or an npm script that does), or set ORIVON_ALLOW_VISIBLE_WINDOW=1 ' +
    'for a run you mean to watch.'
}
