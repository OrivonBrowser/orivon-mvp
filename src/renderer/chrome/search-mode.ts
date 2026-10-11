// The Web3 / Web2 switch in the address bar: which list a search typed here goes to (`search.mode`). It shows while the
// field is being used, so it never sits beside the site's own Web2 / Web2.5 / Web3 mark and reads as that site's level.
// The switch itself is the `search.toggleMode` command; main answers with the new mode in the pushed state.
import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeModule } from './context.js'
import { must } from './context.js'

type Mode = ShellState['searchMode']

export interface ChipView {
  readonly text: string
  /** What a screen reader and the tooltip say: the engine in use, and what a click switches to. */
  readonly label: string
  readonly pressed: boolean
}

const MODE_NAME: Readonly<Record<Mode, string>> = { web3: 'Web3', web2: 'Web2' }

/** The chip for a state: engine names come from main, so the text follows Settings. */
export function chipView (state: Pick<ShellState, 'searchMode' | 'searchWeb3Name' | 'searchWeb2Name'>): ChipView {
  const names: Readonly<Record<Mode, string>> = { web3: state.searchWeb3Name, web2: state.searchWeb2Name }
  const withEngine = (mode: Mode): string => `${MODE_NAME[mode]}${names[mode] === '' ? '' : ` with ${names[mode]}`}`
  const other: Mode = state.searchMode === 'web3' ? 'web2' : 'web3'
  return {
    text: MODE_NAME[state.searchMode],
    label: `Searching ${withEngine(state.searchMode)}. Click to search ${withEngine(other)}.`,
    pressed: state.searchMode === 'web3'
  }
}

/** Whether the chip is shown: while the field has the keyboard (or the chip itself has, reached by Tab), or holds nothing, as on a new tab. */
export function chipShown (fieldFocused: boolean, chipFocused: boolean, fieldValue: string): boolean {
  return fieldFocused || chipFocused || fieldValue === ''
}

export function createSearchMode (): ChromeModule {
  let chip: HTMLButtonElement | undefined
  let input: HTMLInputElement | undefined
  /** What was last drawn, so a push that changes nothing here asks nothing of the dropdown. */
  let drawn: string | undefined

  return {
    name: 'search-mode',
    init: (ctx) => {
      const button = must(document.querySelector<HTMLButtonElement>('#search-mode'), '#search-mode missing')
      const field = must(document.querySelector<HTMLInputElement>('#address'), '#address missing')
      chip = button
      input = field
      let fieldFocused = false
      let chipFocused = false
      const refreshVisibility = (): void => { button.hidden = !chipShown(fieldFocused, chipFocused, field.value) }

      field.addEventListener('focus', () => { fieldFocused = true; refreshVisibility() })
      field.addEventListener('blur', (event) => { fieldFocused = false; chipFocused = event.relatedTarget === button; refreshVisibility() })
      field.addEventListener('input', refreshVisibility)
      button.addEventListener('focus', () => { chipFocused = true; refreshVisibility() })
      button.addEventListener('blur', (event) => { chipFocused = false; fieldFocused = event.relatedTarget === field; refreshVisibility() })
      // The field keeps the keyboard through a click, so a switch does not close what is being typed.
      button.addEventListener('mousedown', (event) => { event.preventDefault() })
      button.addEventListener('click', () => { ctx.shell.runCommand('search.toggleMode') })
      button.hidden = true
    },
    render: (state) => {
      if (chip === undefined || input === undefined) return
      const view = chipView(state)
      chip.textContent = view.text
      chip.dataset['mode'] = state.searchMode
      chip.title = view.label
      chip.setAttribute('aria-label', view.label)
      chip.setAttribute('aria-pressed', String(view.pressed))
      chip.hidden = !chipShown(document.activeElement === input, document.activeElement === chip, input.value)
      // A dropdown that is open names the engine in its first row: ask again so it names the new one.
      const now = view.label
      if (drawn !== undefined && drawn !== now) input.dispatchEvent(new CustomEvent('address-refresh'))
      drawn = now
    }
  }
}
