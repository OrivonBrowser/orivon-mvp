// The Import page: choose a browser profile or a bookmarks file, and bring its bookmarks and history in
// once. What exists to import, and what an import did, is main's to say.
import { ImportState } from './state.js'
import { ImportView } from './view.js'

const state = new ImportState()
const view = new ImportView(state)
const app = document.getElementById('app')
if (app !== null) view.mount(app)
void state.detect()
