// What one carry did, as numbers and named problems: the log line, the marker's record and the unit tests all read it.
// A problem names a kind of thing and where it was (a cookie's name, a database, a record's position), never a value.

export interface Counts {
  carried: number
  /** Left as the website session already had it. */
  skipped: number
  failed: number
}

export interface CarryReport {
  cookies: Counts
  localStorage: Counts
  databases: Counts
  records: Counts
  /** What the old partition held that is not carried, by name. */
  notCarried: string[]
  problems: string[]
  /** How many more problems there were than `problems` holds. */
  problemsLeftOut: number
}

/** The longest list of problems one report keeps: a store of a million unreadable records must not write a million lines. */
export const MAX_PROBLEMS = 25

const counts = (): Counts => ({ carried: 0, skipped: 0, failed: 0 })

export function newReport (): CarryReport {
  return { cookies: counts(), localStorage: counts(), databases: counts(), records: counts(), notCarried: [], problems: [], problemsLeftOut: 0 }
}

/** Records `text` as a problem, up to `MAX_PROBLEMS`, and counts the rest. */
export function addProblem (report: CarryReport, text: string): void {
  if (report.problems.length < MAX_PROBLEMS) report.problems.push(text)
  else report.problemsLeftOut += 1
}

/** The whole outcome in one line. */
export function summarize (report: CarryReport): string {
  const part = (label: string, c: Counts): string => `${String(c.carried)} ${label}${c.skipped > 0 ? ` (${String(c.skipped)} left as they were)` : ''}${c.failed > 0 ? ` (${String(c.failed)} failed)` : ''}`
  return [part('cookies', report.cookies), part('local storage items', report.localStorage), part('databases', report.databases), part('database records', report.records)].join(', ')
}
