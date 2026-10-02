// The welcome screen's whole behaviour. No preload and no bridge: the shell
// watches this page's URL hash (src/main/shell/intro-view.ts), so the page
// needs no capability beyond its own document.

// The fade-out's length in style.css (.overlay).
const FADE_MS = 400

const overlay = document.getElementById('overlay')
const enter = document.getElementById('enter')
// The one control on the screen: Enter acts at once, without a Tab first.
enter?.focus()

enter?.addEventListener('click', () => {
  // "leaving" first, so the shell makes its view transparent before the fade
  // shows what is under it.
  location.hash = 'leaving'
  overlay?.classList.add('leaving')
  setTimeout(() => { location.hash = 'entered' }, FADE_MS)
}, { once: true })
