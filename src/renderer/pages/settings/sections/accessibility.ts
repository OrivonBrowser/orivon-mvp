import type { Section } from '../model.js'
import { caretRows } from './rows/caret.js'
import { contrastRows } from './rows/contrast.js'
import { motionRows } from './rows/motion.js'

export const accessibility: Section = {
  id: 'accessibility',
  title: 'Accessibility',
  rows: [...contrastRows, ...motionRows, ...caretRows]
}
