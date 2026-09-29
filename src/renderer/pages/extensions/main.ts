// The Extensions page: the installed extensions, their on/off switch and
// Remove, a details view per extension, and -- Developer mode -- Load
// unpacked and Reload. Install from file is always available.
import { ExtensionsState } from './state.js'
import { renderPage } from './view.js'

const state = new ExtensionsState()
state.onChange(() => { renderPage(state) })
renderPage(state)
void state.load()
