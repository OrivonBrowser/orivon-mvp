import type { ChromeAction } from '../../shell/chrome-actions.js'
import { sharingBars } from './sharing-bar.js'

/** The sharing chip was clicked: shows the window's sharing bar if it was hidden. No payload is read. */
export const sharingBar: ChromeAction = (_payload, { window }) => { sharingBars.reveal(window) }
