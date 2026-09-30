import type { Section } from '../model.js'
import { languageRows } from './rows/languages.js'

export const languages: Section = {
  id: 'languages',
  title: 'Languages',
  rows: [...languageRows]
}
