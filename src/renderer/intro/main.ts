// The welcome screen's whole behaviour. No preload and no bridge: the shell
// watches this page's URL hash (src/main/shell/intro-view.ts), so the page
// needs no capability beyond its own document.

// The fade-out's length in style.css (.overlay).
const FADE_MS = 400

const overlay = document.getElementById('overlay')
const enter = document.getElementById('enter')
const cta = document.getElementById('cta')
const offer = document.getElementById('default-offer')
const makeDefault = document.getElementById('make-default') as HTMLInputElement | null
const question = document.getElementById('telemetry-choice')
const withTelemetry = document.getElementById('enter-with-telemetry')
const withoutTelemetry = document.getElementById('enter-without-telemetry')
const hint = document.getElementById('telemetry-hint')
const query = new URLSearchParams(location.search)
// Shown only when the shell loaded this page with the offer: the box starts unticked, and nothing happens unless it is ticked.
if (query.get('default') === '1') offer?.removeAttribute('hidden')
const asksTelemetry = query.get('telemetry') === '1'

function leave (report: string): void {
  // "leaving" first, so the shell makes its view transparent before the fade
  // shows what is under it.
  location.hash = report
  overlay?.classList.add('leaving')
  setTimeout(() => { location.hash = 'entered' }, FADE_MS)
}

function makeDefaultChosen (): boolean {
  return makeDefault?.checked === true && offer?.hidden === false
}

if (asksTelemetry) {
  // The person has not chosen, so no button has the focus and none is the way in: Enter does nothing until one is pressed.
  cta?.setAttribute('hidden', '')
  question?.removeAttribute('hidden')
  let left = false
  const choose = (on: boolean): void => {
    if (left) return
    left = true
    leave(`leaving?default=${makeDefaultChosen() ? '1' : '0'}&telemetry=${on ? '1' : '0'}`)
  }
  withTelemetry?.addEventListener('click', () => { choose(true) })
  withoutTelemetry?.addEventListener('click', () => { choose(false) })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    const onButton = event.target instanceof HTMLButtonElement
    if (!onButton && hint !== null) hint.textContent = 'Choose one to continue.'
  })
} else {
  // Enter has the focus, so Enter acts at once; the default-browser box, when offered, is a Tab away.
  enter?.focus()
  enter?.addEventListener('click', () => {
    leave(makeDefaultChosen() ? 'leaving-default' : 'leaving')
  }, { once: true })
}
