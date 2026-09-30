// The address field's dropdown from the chrome's side: what is typed goes to main, which answers how many rows
// there are and what to finish the text with, and the keys that move or choose a row go back to it. The rows
// themselves are drawn by an overlay (src/renderer/overlay/omnibox/) and the field keeps focus throughout.
import type { ChromeContext, ChromeModule } from './context.js'
import { must } from './context.js'
import { isPrintableKey, keyIntent, wasTyped } from './address-suggest-model.js'

/** Blur closes the dropdown, but a click on a row blurs the field first: the choice is taken on the press, and
 * this is how long a blur waits for it. Refocusing the field cancels it. */
const BLUR_CLOSE_MS = 150
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

interface Reply { seq: number, count: number, completion: string | null }

function asReply (value: unknown): Reply | undefined {
  if (!isRecord(value)) return undefined
  const { seq, count, completion } = value
  if (typeof seq !== 'number' || typeof count !== 'number') return undefined
  return { seq, count, completion: typeof completion === 'string' && completion !== '' ? completion : null }
}

export function createAddressSuggest (): ChromeModule {
  /** Set by `init`, which owns the state an event from main has to change. */
  let fromMain: (payload: Record<string, unknown>) => void = () => {}
  return {
    name: 'address-suggest',
    init: (ctx: ChromeContext) => {
      const input = must(document.querySelector<HTMLInputElement>('#address'), '#address missing')
      const form = must(document.querySelector<HTMLFormElement>('#address-form'), '#address-form missing')
      const pill = must(document.querySelector<HTMLElement>('#address-pill'), '#address-pill missing')
      /** What the person typed, without the completion or a row's address. */
      let typed = ''
      /** Whether anything was typed since the field was last left: only then is a submit a typed address. */
      let edited = false
      let completion = ''
      let open = false
      let selected = 0
      let seq: number | undefined
      /** Each edit takes a number; a reply for an older one is dropped. */
      let token = 0
      let waiting = false
      let lastPrintableKeyAt = 0
      let composing = false
      let blurTimer: ReturnType<typeof setTimeout> | undefined

      input.setAttribute('role', 'combobox')
      input.setAttribute('aria-autocomplete', 'both')
      input.setAttribute('aria-haspopup', 'listbox')
      input.setAttribute('aria-controls', 'omnibox-list')
      input.setAttribute('aria-expanded', 'false')

      function setOpen (on: boolean): void {
        open = on
        input.setAttribute('aria-expanded', String(on))
        if (on) input.setAttribute('aria-activedescendant', `omnibox-option-${String(selected)}`)
        else input.removeAttribute('aria-activedescendant')
      }

      /** Leaves the typing: the dropdown is gone here, and, unless `tellMain` is false, in main. */
      function settle (tellMain: boolean, submitted?: string): void {
        token += 1
        waiting = false
        selected = 0
        completion = ''
        seq = undefined
        setOpen(false)
        if (tellMain) void ctx.shell.act('omnibox.close', submitted === undefined ? {} : { typed: submitted })
        edited = false
      }

      function showText (text: string, selectFrom?: number): void {
        input.value = text
        input.setSelectionRange(selectFrom ?? text.length, text.length)
      }

      function onInput (event: Event): void {
        const value = input.value
        typed = value
        edited = true
        completion = ''
        selected = 0
        if (value.trim() === '') {
          settle(true)
          return
        }
        const mine = ++token
        const typing = wasTyped(event as InputEvent, input, lastPrintableKeyAt, Date.now())
        waiting = true
        void ctx.shell.act('omnibox.query', { text: value, typing, anchor: ctx.anchorFor(pill) }).then((answer) => {
          if (mine !== token) return
          waiting = false
          const reply = asReply(answer)
          if (reply === undefined || reply.count === 0) {
            setOpen(false)
            return
          }
          seq = reply.seq
          setOpen(true)
          if (typing && reply.completion !== null && input.value === value && document.activeElement === input) {
            completion = reply.completion
            showText(value + completion, value.length)
          }
        }, () => { waiting = false })
      }

      function onMove (step: 1 | -1): void {
        const mine = token
        void ctx.shell.act('omnibox.select', { step, seq }).then((answer) => {
          if (mine !== token || !isRecord(answer) || typeof answer['selected'] !== 'number') {
            if (mine === token && answer === undefined) setOpen(false)
            return
          }
          selected = answer['selected']
          setOpen(true)
          const fill = answer['fill']
          // Back on the first row the typed text returns, with what it was finished with.
          if (typeof fill === 'string') showText(fill)
          else showText(typed + completion, completion === '' ? undefined : typed.length)
        })
      }

      function onPick (disposition: 'current' | 'tab'): void {
        const index = selected
        const chosen = seq
        settle(false)
        void ctx.shell.act('omnibox.pick', { index, disposition, seq: chosen }).then(() => { input.blur() })
      }

      function onEscape (): void {
        if (open || waiting) {
          settle(true)
          showText(typed)
          return
        }
        const tab = ctx.activeTab()
        typed = tab === undefined || tab.isNewTab ? '' : tab.displayUrl
        input.value = typed
        input.select()
      }

      input.addEventListener('input', onInput)
      input.addEventListener('compositionstart', () => { composing = true })
      input.addEventListener('compositionend', () => { composing = false })
      // Capture: a chosen row's Enter is taken here, before the form's own submit sees it.
      input.addEventListener('keydown', (event) => {
        if (isPrintableKey(event)) lastPrintableKeyAt = Date.now()
        const intent = keyIntent({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, isComposing: composing || event.isComposing }, { open, selected })
        if (intent === null) return
        event.preventDefault()
        if (intent.type === 'move') onMove(intent.step)
        else if (intent.type === 'pick') onPick(intent.disposition)
        else onEscape()
      }, true)
      input.addEventListener('focus', () => {
        if (blurTimer !== undefined) clearTimeout(blurTimer)
        blurTimer = undefined
      })
      input.addEventListener('blur', () => {
        blurTimer = setTimeout(() => {
          blurTimer = undefined
          if (document.activeElement !== input && (open || waiting)) settle(true)
        }, BLUR_CLOSE_MS)
      })
      // Capture, so the value is read before the address bar's own submit blurs the field and puts the page's address back.
      form.addEventListener('submit', () => { settle(true, edited ? input.value : undefined) }, true)

      fromMain = (payload) => {
        // A choice was made with the mouse: the field stops being typed in and shows the page it leads to.
        if (payload['type'] === 'done') {
          settle(false)
          input.blur()
        }
        // The search key: the field, ready for the words of a search.
        if (payload['type'] === 'focusSearch') {
          input.focus()
          typed = '? '
          showText(typed)
        }
      }
    },
    event: (payload) => { if (isRecord(payload)) fromMain(payload) }
  }
}
