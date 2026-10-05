// The welcome screen's whole behaviour. No preload and no bridge: the shell
// watches this page's URL hash (src/main/shell/intro-view.ts), so the page
// needs no capability beyond its own document.

// The fade-out's length in style.css (.overlay).
const FADE_MS = 400

const overlay = document.getElementById('overlay')
const enter = document.getElementById('enter')
const offer = document.getElementById('default-offer')
const makeDefault = document.getElementById('make-default') as HTMLInputElement | null
// Shown only when the shell loaded this page with the offer: the box starts unticked, and nothing happens unless it is ticked.
if (new URLSearchParams(location.search).get('default') === '1') offer?.removeAttribute('hidden')
// Enter has the focus, so Enter acts at once; the default-browser box, when offered, is a Tab away.
enter?.focus()

enter?.addEventListener('click', () => {
  // "leaving" first, so the shell makes its view transparent before the fade
  // shows what is under it.
  location.hash = makeDefault?.checked === true && offer?.hidden === false ? 'leaving-default' : 'leaving'
  overlay?.classList.add('leaving')
  setTimeout(() => { location.hash = 'entered' }, FADE_MS)
}, { once: true })
