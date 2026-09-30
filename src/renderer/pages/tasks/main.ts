// The task manager page: live memory and processor use for Orivon's
// processes, sortable, with End process for a tab, app, extension or service.
import { TasksState } from './state.js'
import { createTasksView } from './view.js'

const state = new TasksState()
const view = createTasksView(state)
state.onChange(() => { view.render(state) })
document.getElementById('app')?.append(view.element)
view.render(state)

/** A page nobody can see has no use for the reading, so it polls only while shown. */
function syncPolling (): void {
  if (document.visibilityState === 'visible') state.start()
  else state.stop()
}
document.addEventListener('visibilitychange', syncPolling)
syncPolling()
