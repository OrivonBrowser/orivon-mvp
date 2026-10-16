import { describe, expect, it, vi } from 'vitest'
import { parseOmniboxInput } from '../../browsing/omnibox.js'
import { runChromeAction } from '../../shell/chrome-actions.js'
import { openWeb3ScoreHelp, WEB3_SCORE_HELP_ADDRESS, web3ScoreHelpUrl } from '../web3-score-help.js'

describe('the Web3 Score help address', () => {
  it('is the name Orivon\'s documentation lives at, and opens as the address bar opens it when it is typed', () => {
    expect(WEB3_SCORE_HELP_ADDRESS).toBe('docs.orivonstack.eth/docs/using/web3-score')
    expect(web3ScoreHelpUrl()).toBe('https://docs.orivonstack.eth/docs/using/web3-score')
    expect(parseOmniboxInput(WEB3_SCORE_HELP_ADDRESS)).toEqual({ kind: 'url', url: web3ScoreHelpUrl() })
  })

  it('follows the address bar for a developer name, which is served on loopback over http', () => {
    expect(web3ScoreHelpUrl((host) => host === 'docs.orivonstack.eth')).toBe('http://docs.orivonstack.eth/docs/using/web3-score')
  })

  it('opens one new tab in front at that address', () => {
    const createTab = vi.fn(() => 'tab-1')
    openWeb3ScoreHelp({ createTab })
    expect(createTab).toHaveBeenCalledExactlyOnceWith('https://docs.orivonstack.eth/docs/using/web3-score')
  })

  it('is the chrome action "web3-score.help", which takes no argument from the page', () => {
    const createTab = vi.fn(() => 'tab-1')
    runChromeAction('web3-score.help', { url: 'https://evil.test/' }, { window: { tabs: { createTab } } as never, services: {} as never })
    expect(createTab).toHaveBeenCalledExactlyOnceWith('https://docs.orivonstack.eth/docs/using/web3-score')
  })
})
