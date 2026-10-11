// The card the Web3 Score shield opens on a new tab: what the shield shows once a site is open, and each level drawn
// as the address bar draws it, the shield in its colour and the Web2 / Web2.5 / Web3 mark beside it.
import { h } from '../../pages/shared/dom.js'
import type { ScoreLevel } from '../../../trust/website-level.js'
import { paintMark, paintShield, web3Shield } from '../../web3-shield.js'
import type { Overlay, OverlayPage } from '../kit.js'
import './web3-score.css'

/** The scale in the root README.md, in the words of someone who has never heard of it; each level keeps the one before. */
const LEVELS: ReadonlyArray<{ level: ScoreLevel, meaning: string }> = [
  { level: 1, meaning: 'A standard website. You get whatever its server sends you.' },
  { level: 2, meaning: 'Its files are checked against what its owner published, so nobody in between can change them.' },
  { level: 3, meaning: 'Also open source, and it reaches nothing outside without your consent.' },
  { level: 4, meaning: 'Also relies on no server at all: nobody can switch it off or show you false data.' }
]

function levelRow ({ level, meaning }: { level: ScoreLevel, meaning: string }): HTMLLIElement {
  const shield = web3Shield()
  paintShield(shield, level)
  const mark = h('span', { className: 'web3-mark' })
  paintMark(mark, level)
  return h('li', { className: 'ws-level' },
    shield,
    h('div', { className: 'ws-level-text' },
      h('div', { className: 'ws-level-head' }, h('span', { className: 'ws-level-name' }, `Level ${String(level)}`), mark),
      h('p', { className: 'ws-level-meaning' }, meaning)))
}

export const web3ScorePage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const icon = web3Shield()
    const provider = h('button', { type: 'button', className: 'link-btn', onclick: () => { void overlay.request({ type: 'provider' }) } }, 'Choose a score provider')
    const learn = h('button', { type: 'button', className: 'link-btn', onclick: () => { void overlay.request({ type: 'learn' }) } }, 'How scores work')
    content.append(h('div', { className: 'ws', role: 'dialog', ariaLabel: 'Web3 Score' },
      h('div', { className: 'ws-head' }, icon, h('h1', { className: 'sheet-title' }, 'Web3 Score')),
      h('p', { className: 'ws-lead' }, 'Open a site and this shield shows its Web3 Score: how little you have to trust the people behind it. The higher the level, the less trust it asks for.'),
      h('ol', { className: 'ws-levels' }, ...LEVELS.map(levelRow)),
      h('p', { className: 'ws-note' }, 'Orivon checks Levels 1 and 2 on this computer. Levels 3 and 4 come from the score provider you choose.'),
      h('div', { className: 'ws-foot' }, provider, learn)))
    return { shown () {} }
  }
}
