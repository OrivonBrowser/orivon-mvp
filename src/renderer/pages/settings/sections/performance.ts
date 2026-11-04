import type { Section } from '../model.js'
import { graphicsRows } from './rows/graphics.js'
import { memoryRows } from './rows/memory.js'

export const performanceSection: Section = {
  id: 'performance',
  title: 'Performance',
  intro: 'Orivon can free memory from tabs you are not using.',
  rows: [...memoryRows, ...graphicsRows]
}
