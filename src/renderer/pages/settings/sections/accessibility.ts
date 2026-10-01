import type { Section } from '../model.js'
import { caretRows } from './rows/caret.js'

export const accessibility: Section = {
  id: 'accessibility',
  title: 'Accessibility',
  rows: [...caretRows]
}
