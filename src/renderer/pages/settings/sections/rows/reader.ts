import type { Row } from '../../model.js'

const KEYWORDS = ['reader', 'reading mode', 'article', 'read aloud', 'distraction']

/** Rows spread into the Reader view group of Page content, so a feature adds its rows here and edits no other file. */
export const readerRows: readonly Row[] = [
  {
    id: 'reader-font',
    group: 'Reader view',
    label: 'Font',
    help: 'The typeface articles are set in when you open reader view.',
    keywords: [...KEYWORDS, 'serif', 'sans', 'typeface'],
    control: { type: 'choice', key: 'reader.font', options: [{ value: 'sans', label: 'Sans-serif' }, { value: 'serif', label: 'Serif' }] }
  },
  {
    id: 'reader-size',
    group: 'Reader view',
    label: 'Text size',
    help: 'Also changed from the Text and layout button in reader view.',
    keywords: [...KEYWORDS, 'font size', 'bigger', 'larger'],
    control: { type: 'choice', key: 'reader.size', options: ['14', '16', '18', '20', '24', '28'].map((value) => ({ value, label: `${value} px` })) }
  },
  {
    id: 'reader-theme',
    group: 'Reader view',
    label: 'Colours',
    help: 'Automatic follows the browser. Sepia is a warm paper tone.',
    keywords: [...KEYWORDS, 'sepia', 'dark', 'light', 'theme', 'paper'],
    control: { type: 'choice', key: 'reader.theme', options: [{ value: 'auto', label: 'Automatic' }, { value: 'light', label: 'Light' }, { value: 'sepia', label: 'Sepia' }, { value: 'dark', label: 'Dark' }] }
  }
]
