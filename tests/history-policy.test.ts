import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HISTORY_LIMITS,
  HISTORY_RETENTION_CHOICES,
  dayLabel,
  deleteSelectedLabel,
  expiredHistoryIds,
  fitsHistoryBudget,
  formatAge,
  formatBytes,
  formatSource,
  matchesHistoryQuery,
  type HistoryLimits,
  type HistorySummary,
} from '../src/shared/history-policy'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function entry(id: string, ageDays: number, bytes = 1_000): HistorySummary {
  return { id, createdAt: NOW - ageDays * DAY, bytes }
}

const limits = (overrides: Partial<HistoryLimits>): HistoryLimits => ({ ...DEFAULT_HISTORY_LIMITS, ...overrides })

describe('expiredHistoryIds', () => {
  it('keeps everything inside every limit', () => {
    expect(expiredHistoryIds([entry('a', 0), entry('b', 3)], NOW)).toEqual([])
  })

  it('drops entries past the retention period', () => {
    const kept = entry('kept', 6)
    const gone = entry('gone', 8)
    expect(expiredHistoryIds([kept, gone], NOW)).toEqual(['gone'])
  })

  it('treats a non-positive retention period as keep-forever', () => {
    const ancient = entry('ancient', 900)
    expect(expiredHistoryIds([ancient], NOW, limits({ maxAgeMs: 0 }))).toEqual([])
    expect(expiredHistoryIds([ancient], NOW, limits({ maxAgeMs: -1 }))).toEqual([])
  })

  it('still applies the count cap when retention is keep-forever, because that cap is the safety net', () => {
    const entries = [entry('a', 1), entry('b', 2), entry('c', 3)]
    expect(expiredHistoryIds(entries, NOW, limits({ maxAgeMs: 0, maxEntries: 2 }))).toEqual(['c'])
  })

  it('trims the count cap from the oldest end', () => {
    const entries = [entry('newest', 0), entry('middle', 1), entry('oldest', 2)]
    expect(expiredHistoryIds(entries, NOW, limits({ maxEntries: 1 }))).toEqual(['middle', 'oldest'])
  })

  it('trims the size cap from the oldest end', () => {
    const entries = [entry('newest', 0, 600), entry('middle', 1, 600), entry('oldest', 2, 600)]
    expect(expiredHistoryIds(entries, NOW, limits({ maxBytes: 1_300 }))).toEqual(['oldest'])
  })

  it('does not let a burst of large captures evict an entry the age rule would have kept', () => {
    // The size cap admits the two newest and evicts the oldest -- but never reaches past the
    // eviction it needs, so the entry at 3 days survives exactly as its retention period promised.
    const entries = [entry('a', 0, 900), entry('b', 1, 900), entry('c', 3, 900)]
    expect(expiredHistoryIds(entries, NOW, limits({ maxBytes: 2_000 }))).toEqual(['c'])
  })

  it('counts an expired entry as freeing its space, not as occupying it', () => {
    // 'old' is already doomed by age, so its bytes must not push the two live entries over budget.
    const entries = [entry('a', 0, 900), entry('b', 1, 900), entry('old', 40, 5_000)]
    expect(expiredHistoryIds(entries, NOW, limits({ maxBytes: 2_000 }))).toEqual(['old'])
  })

  it('reports each doomed id once when several rules condemn the same entry', () => {
    const entries = [entry('a', 0), entry('b', 1), entry('stale', 90)]
    const dropped = expiredHistoryIds(entries, NOW, limits({ maxEntries: 2 }))
    expect(dropped).toEqual(['stale'])
    expect(new Set(dropped).size).toBe(dropped.length)
  })

  it('ignores a negative byte count rather than crediting it against the budget', () => {
    const entries = [entry('a', 0, -5_000), entry('b', 1, 900), entry('c', 2, 900)]
    expect(expiredHistoryIds(entries, NOW, limits({ maxBytes: 1_500 }))).toEqual(['c'])
  })

  it('handles an empty history', () => {
    expect(expiredHistoryIds([], NOW)).toEqual([])
  })
})

describe('fitsHistoryBudget', () => {
  it('admits an ordinary capture', () => {
    expect(fitsHistoryBudget(20 * 1024 * 1024)).toBe(true)
  })

  it('refuses a capture larger than the whole budget instead of storing then evicting it', () => {
    expect(fitsHistoryBudget(DEFAULT_HISTORY_LIMITS.maxBytes + 1)).toBe(false)
  })

  it('refuses an empty capture', () => {
    expect(fitsHistoryBudget(0)).toBe(false)
    expect(fitsHistoryBudget(-1)).toBe(false)
  })
})

describe('formatBytes', () => {
  it('reads in the unit a person would use', () => {
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB')
    expect(formatBytes(300 * 1024)).toBe('300 KB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
  })

  it('never reports a stored capture as nothing at all', () => {
    expect(formatBytes(10)).toBe('1 KB')
  })

  it('reports genuinely empty storage as zero', () => {
    expect(formatBytes(0)).toBe('0 KB')
    expect(formatBytes(Number.NaN)).toBe('0 KB')
  })
})

describe('formatAge', () => {
  it('reads coarsely, which is all a list needs', () => {
    expect(formatAge(NOW, NOW)).toBe('Just now')
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5 min ago')
    expect(formatAge(NOW - 60 * 60_000, NOW)).toBe('1 hour ago')
    expect(formatAge(NOW - 5 * 60 * 60_000, NOW)).toBe('5 hours ago')
    expect(formatAge(NOW - DAY, NOW)).toBe('Yesterday')
    expect(formatAge(NOW - 4 * DAY, NOW)).toBe('4 days ago')
  })

  it('does not read as the future when clocks disagree', () => {
    expect(formatAge(NOW + 60_000, NOW)).toBe('Just now')
  })
})

describe('formatSource', () => {
  it('shows the host alone', () => {
    expect(formatSource('https://www.example.com/a/very/long/path?q=1')).toBe('www.example.com')
  })

  it('falls back to the raw string rather than showing nothing', () => {
    expect(formatSource('not a url')).toBe('not a url')
  })

  it('shows nothing when there is no source', () => {
    expect(formatSource(undefined)).toBe('')
  })
})

describe('admitting a new capture alongside what is already stored', () => {
  // The save path prunes against a prospective list -- everything stored plus the incoming capture,
  // stamped as the newest -- so the budget is enforced before the write rather than one capture late.
  it('evicts exactly enough of the oldest to make room for the incoming capture', () => {
    const incoming = { id: 'new', createdAt: NOW, bytes: 900 }
    const stored = [entry('a', 1, 900), entry('b', 2, 900), entry('c', 3, 900)]
    const dropped = expiredHistoryIds([incoming, ...stored], NOW, limits({ maxBytes: 2_000 }))
    expect(dropped).toEqual(['b', 'c'])
    expect(dropped).not.toContain('new')
  })

  it('never condemns the capture being written, which is why it is stamped newest', () => {
    const incoming = { id: 'new', createdAt: NOW, bytes: 1_900 }
    const stored = [entry('a', 1, 900), entry('b', 2, 900)]
    const dropped = expiredHistoryIds([incoming, ...stored], NOW, limits({ maxBytes: 2_000 }))
    expect(dropped).not.toContain('new')
  })
})

describe('matchesHistoryQuery', () => {
  const entry = { title: 'Pricing — Acme', url: 'https://acme.example.com/pricing?ref=nav' }

  it('matches an empty query, so an untouched search box hides nothing', () => {
    expect(matchesHistoryQuery(entry, '')).toBe(true)
    expect(matchesHistoryQuery(entry, '   ')).toBe(true)
  })

  it('searches the title and the URL, because people remember either', () => {
    expect(matchesHistoryQuery(entry, 'pricing')).toBe(true)
    expect(matchesHistoryQuery(entry, 'acme.example')).toBe(true)
  })

  it('ignores case', () => {
    expect(matchesHistoryQuery(entry, 'ACME')).toBe(true)
  })

  it('narrows with each term rather than widening', () => {
    expect(matchesHistoryQuery(entry, 'pricing acme')).toBe(true)
    expect(matchesHistoryQuery(entry, 'pricing github')).toBe(false)
  })

  it('matches across the title/URL boundary only per term, not as one string', () => {
    // 'acme' is in both; 'https' only in the URL. Both terms match somewhere, so the entry matches.
    expect(matchesHistoryQuery(entry, 'acme https')).toBe(true)
  })

  it('does not crash on an entry with no URL', () => {
    expect(matchesHistoryQuery({ title: 'Local file' }, 'local')).toBe(true)
    expect(matchesHistoryQuery({ title: 'Local file' }, 'example.com')).toBe(false)
  })
})

describe('dayLabel', () => {
  // Constructed with local date parts, so these hold in any timezone.
  const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h).getTime()

  it('names today and yesterday rather than dating them', () => {
    expect(dayLabel(at(2026, 7, 26, 9), at(2026, 7, 26, 23))).toBe('Today')
    expect(dayLabel(at(2026, 7, 25, 23), at(2026, 7, 26, 1))).toBe('Yesterday')
  })

  it('counts calendar days, not elapsed hours', () => {
    // Two hours apart, but across midnight — a person calls that yesterday.
    expect(dayLabel(at(2026, 7, 25, 23), at(2026, 7, 26, 1))).toBe('Yesterday')
    // Twenty-two hours apart, same calendar day.
    expect(dayLabel(at(2026, 7, 26, 1), at(2026, 7, 26, 23))).toBe('Today')
  })

  it('omits the year within the current year and shows it beyond', () => {
    expect(dayLabel(at(2026, 0, 4), at(2026, 7, 26))).toBe('4 Jan')
    expect(dayLabel(at(2025, 11, 31), at(2026, 7, 26))).toBe('31 Dec 2025')
  })

  it('crosses a year boundary without calling January "Yesterday" of the wrong year', () => {
    expect(dayLabel(at(2025, 11, 31, 20), at(2026, 0, 1, 9))).toBe('Yesterday')
  })
})

describe('deleteSelectedLabel', () => {
  it('does not claim a count when nothing is selected', () => {
    expect(deleteSelectedLabel(0)).toBe('Delete selected')
  })

  it('names the count once something is', () => {
    expect(deleteSelectedLabel(1)).toBe('Delete 1 selected')
    expect(deleteSelectedLabel(12)).toBe('Delete 12 selected')
  })
})

describe('HISTORY_RETENTION_CHOICES', () => {
  it('offers forever as zero days, which is the absence of an age rule', () => {
    const forever = HISTORY_RETENTION_CHOICES.find((choice) => choice.label === 'Forever')
    expect(forever?.days).toBe(0)
    expect(expiredHistoryIds([entry('ancient', 5_000)], NOW, limits({ maxAgeMs: 0 }))).toEqual([])
  })

  it('offers every period the settings page names, and each is distinct', () => {
    expect(HISTORY_RETENTION_CHOICES.map((choice) => choice.days)).toEqual([1, 7, 30, 90, 180, 365, 0])
    expect(new Set(HISTORY_RETENTION_CHOICES.map((choice) => choice.label)).size).toBe(
      HISTORY_RETENTION_CHOICES.length,
    )
  })

  it('includes the default, so the dropdown can never open on a blank value', () => {
    const defaultDays = DEFAULT_HISTORY_LIMITS.maxAgeMs / (24 * 60 * 60 * 1000)
    expect(HISTORY_RETENTION_CHOICES.some((choice) => choice.days === defaultDays)).toBe(true)
  })

  it('keeps the count cap loose enough that a long period is not overruled by it', () => {
    // A year of retention with a tight count cap would tell the user one thing and do another.
    expect(DEFAULT_HISTORY_LIMITS.maxEntries).toBeGreaterThanOrEqual(100)
  })
})

describe('searching what the page said', () => {
  const captured = {
    title: 'Acme',
    url: 'https://acme.example.com/p',
    searchText: 'quarterly revenue forecast 2026 by region',
  }

  it('finds a capture by a phrase that was only ever in the picture', () => {
    // The title is a brand name and the URL is a slug -- the words a person remembers are neither.
    expect(matchesHistoryQuery(captured, 'forecast')).toBe(true)
    expect(matchesHistoryQuery(captured, 'quarterly revenue')).toBe(true)
  })

  it('still narrows across the three fields rather than widening', () => {
    expect(matchesHistoryQuery(captured, 'acme forecast')).toBe(true)
    expect(matchesHistoryQuery(captured, 'forecast pricing')).toBe(false)
  })

  it('does not match a capture whose text was never harvested', () => {
    expect(matchesHistoryQuery({ title: 'Acme', url: 'https://acme.example.com/p' }, 'forecast')).toBe(false)
  })
})
