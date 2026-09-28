// The sections in the order the page lists them. Each later feature adds its
// section here.
import type { Section } from '../model.js'
import { about } from './about.js'
import { appearance } from './appearance.js'
import { search } from './search.js'
import { tabs } from './tabs.js'

export const SECTIONS: readonly Section[] = [appearance, search, tabs, about]
