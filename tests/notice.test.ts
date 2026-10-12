import { describe, expect, it } from 'vitest'
import { captureNotice, type NoticePart } from '../src/result/notice'
import { LONG_PAGE_SETTING_LABEL } from '../src/shared/capture-depth'
import type { CaptureJob } from '../src/shared/messages'

function job(over: Partial<CaptureJob> = {}): CaptureJob {
  return { id: 'j', status: 'complete', mode: 'full', createdAt: 0, updatedAt: 0, ...over } as CaptureJob
}

const flatten = (parts: NoticePart[]): string => parts.map((p) => p.text).join('')
const kinds = (parts: NoticePart[], kind: NoticePart['kind']): string[] =>
  parts.filter((p) => p.kind === kind).map((p) => p.text)

describe('what a capture has to admit', () => {
  it('says nothing when there is nothing to admit', () => {
    expect(captureNotice(job())).toBeNull()
  })

  it('offers a way into Settings only for the outcome a setting governs', () => {
    expect(captureNotice(job({ endlessPage: true, segmentCount: 16 }))?.settingsLink).toBe(true)
    for (const other of [
      job({ stoppedEarly: true, segmentCount: 3 }),
      job({ deadlineReached: true, segmentCount: 9 }),
      job({ truncated: true, fullDocumentHeight: 500_000, finalDocumentHeight: 100_000 }),
      job({ restrictedPageFallback: true }),
      job({ fileAccessFallback: true }),
    ]) {
      expect(captureNotice(other)?.settingsLink).toBe(false)
    }
  })

  it('names the setting exactly as the settings page labels it', () => {
    const notice = captureNotice(job({ endlessPage: true, segmentCount: 16 }))
    expect(kinds(notice?.parts ?? [], 'setting')).toEqual([LONG_PAGE_SETTING_LABEL])
  })

  it('marks up the measured numbers rather than burying them in prose', () => {
    const notice = captureNotice(job({ endlessPage: true, segmentCount: 16, finalDocumentHeight: 12_494 }))
    expect(kinds(notice?.parts ?? [], 'value')).toEqual(['16', (12_494).toLocaleString()])
    expect(flatten(notice?.parts ?? [])).toContain(`${(12_494).toLocaleString()} CSS pixels`)
  })

  it('groups a large number the way the reader reads it, and keeps grouping inside the number', () => {
    /*
     * Deliberately compared against `toLocaleString` rather than a literal: this machine formats
     * en-IN, where 1234567 is "12,34,567", and a hard-coded US grouping made the test fail on a
     * correctly behaving function. The separators have to sit inside the marked-up run either way,
     * or the number wraps across a line break mid-figure.
     */
    const notice = captureNotice(job({ deadlineReached: true, segmentCount: 1, finalDocumentHeight: 1_234_567 }))
    expect(kinds(notice?.parts ?? [], 'value')).toContain((1_234_567).toLocaleString())
  })

  it('says "section" for one and "sections" for the rest', () => {
    expect(flatten(captureNotice(job({ endlessPage: true, segmentCount: 1 }))?.parts ?? [])).toContain('1 section ')
    expect(flatten(captureNotice(job({ endlessPage: true, segmentCount: 2 }))?.parts ?? [])).toContain('2 sections')
  })

  it('claims a share of the page only when the page had an honest total', () => {
    // A page that grows while it is captured has no total worth quoting, so a stop on one says how
    // much it got and not what fraction that was.
    const withTotal = captureNotice(job({ stoppedEarly: true, segmentCount: 4, finalDocumentHeight: 5_000, fullDocumentHeight: 10_000 }))
    expect(flatten(withTotal?.parts ?? [])).toContain('50%')
    const noTotal = captureNotice(job({ stoppedEarly: true, segmentCount: 4, finalDocumentHeight: 5_000 }))
    expect(flatten(noTotal?.parts ?? [])).not.toContain('%')
  })

  it('prefers the outcome the reader caused or can undo over the generic truncation', () => {
    const both = captureNotice(job({ endlessPage: true, truncated: true, fullDocumentHeight: 900_000, segmentCount: 16 }))
    expect(flatten(both?.parts ?? [])).toContain('kept loading more as it was scrolled')
    expect(flatten(both?.parts ?? [])).not.toContain('longer than PageShotter captures in one run')
  })
})
