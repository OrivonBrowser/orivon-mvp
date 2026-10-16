import type { ChromeAction } from '../shell/chrome-actions.js'
import { openWeb3ScoreHelp } from './web3-score-help.js'

/** The "Web?" mark in the address bar: no argument, the page and the tab are fixed here. */
export const web3ScoreHelp: ChromeAction = (_payload, { window }) => { openWeb3ScoreHelp(window.tabs) }
