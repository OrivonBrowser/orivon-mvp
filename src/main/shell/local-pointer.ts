// Whether a pointer's screen position can be trusted here. On a native Wayland session it cannot: the compositor
// tells a client nothing about where its windows are or where the pointer is outside them, so Electron reports
// every window at one fixed place and the global cursor at (0, 0). Tab dragging then uses the browser's own drag and
// drop (native-tab-drag.ts), which hands each window its own coordinates. Tied to Electron: the platform is the one
// Chromium resolved at start.
import { app } from 'electron'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** `ozonePlatform` is what Chromium resolved (it writes the choice back into the `ozone-platform` switch, whether
 * the person gave one or its own detection picked Wayland). `forced` is the test seam below. */
export function isLocalPointer (ozonePlatform: string, forced = false): boolean {
  return forced || ozonePlatform === 'wayland'
}

/** True when window positions and the cursor's screen position are not known (a native Wayland session). A test
 * build can force it with ORIVON_TEST_LOCAL_POINTER=1, so a virtual X display runs the same code; an ordinary
 * build ignores the variable. */
export function pointerIsLocal (env: NodeJS.ProcessEnv = process.env): boolean {
  return isLocalPointer(app.commandLine.getSwitchValue('ozone-platform'), SEAM_ENABLED && env['ORIVON_TEST_LOCAL_POINTER'] === '1')
}
