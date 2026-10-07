// The report page: `orivon://report`, or `orivon://report/crash/<id>` with that crash chosen. What it shows and
// what it sends is built by main; the page is the form and the words around it.
import { ReportState } from './state.js'
import { mountReport } from './view.js'

const state = new ReportState()
const root = document.getElementById('app')
if (root !== null) mountReport(root, state)
void state.load(ReportState.crashOfPath(location.pathname))
