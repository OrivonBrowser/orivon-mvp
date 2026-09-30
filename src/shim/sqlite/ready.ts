// A bundle imports this before the module that requires `node:sqlite`: the
// top-level await finishes the engine's asynchronous start-up first.
import { loadSqliteEngine } from './engine.js'

await loadSqliteEngine()
