import { fileAccessMessage } from '../shared/errors'
import { degradationParts } from '../shared/capture-degradation'
import { CAPTURE_LIMITS } from '../shared/capture-plan'
import { LONG_PAGE_SETTING_LABEL } from '../shared/capture-depth'
import type { CaptureJob } from '../shared/messages'
import {
  noticeNumber,
  noticeSetting,
  noticeText,
  noticeValue,
  type NoticePart,
} from '../shared/notice-parts'

export type { NoticePart } from '../shared/notice-parts'

export interface NoticeContent {
  parts: NoticePart[]
  /** Whether the notice offers a way into Settings, which only an outcome a setting governs should. */
  settingsLink: boolean
}

const t = noticeText
const value = noticeValue
const num = noticeNumber
const setting = noticeSetting

function sections(count: number): NoticePart[] {
  return [num(count), t(count === 1 ? ' section' : ' sections')]
}

function pixels(css: number): NoticePart[] {
  return [num(css), t(' CSS pixels')]
}

/**
 * What this capture has to admit, or `null` when it has nothing to admit.
 *
 * Ordered by specificity rather than severity: an outcome a user caused (`stoppedEarly`) or can undo
 * (`endlessPage`) has a better explanation than the generic truncation, so the generic one is last
 * and only reached when nothing more precise applies.
 */
export function captureNotice(job: CaptureJob, historyFailure?: string): NoticeContent | null {
  if (historyFailure) return { parts: [t(historyFailure)], settingsLink: false }

  if (job.fileAccessFallback) {
    return { parts: [t(fileAccessMessage(true))], settingsLink: false }
  }

  if (job.restrictedPageFallback) {
    return {
      parts: [
        t(
          'Chrome does not allow extensions to run on this page, so PageShotter captured the visible area instead. Content outside the viewport is not included.',
        ),
      ],
      settingsLink: false,
    }
  }

  if (job.stoppedEarly) {
    const captured = job.finalDocumentHeight ?? 0
    const full = job.fullDocumentHeight
    // A page that grows as it is scrolled has no honest total, so the share of the page is only
    // claimed when the last measured height was actually larger than what was captured.
    const share: NoticePart[] =
      full && full > captured
        ? [
            t(' — about '),
            value(`${Math.round((captured / full) * 100)}%`),
            t(' of the page as it measured when you stopped'),
          ]
        : []
    return {
      parts: [
        t('You stopped this capture, so PageShotter assembled the '),
        ...sections(job.segmentCount ?? 0),
        t(' it had already taken'),
        ...share,
        t('. That is '),
        ...pixels(captured),
        t(', and all of it is below.'),
      ],
      settingsLink: false,
    }
  }

  if (job.endlessPage) {
    return {
      parts: [
        t('This page kept loading more as it was scrolled, so PageShotter took the first '),
        ...sections(job.segmentCount ?? 0),
        t(' — '),
        ...pixels(job.finalDocumentHeight ?? 0),
        t(' — and stopped rather than chasing content written as fast as it is captured. '),
        t('Everything captured is below. If this page does have an end, change '),
        setting(LONG_PAGE_SETTING_LABEL),
        t(' and capture again.'),
      ],
      // The one outcome here a reader can undo, so the one that earns a way out of the page.
      settingsLink: true,
    }
  }

  if (job.deadlineReached) {
    return {
      parts: [
        t('This capture reached its time limit, so PageShotter assembled the '),
        ...sections(job.segmentCount ?? 0),
        t(' it had taken — '),
        ...pixels(job.finalDocumentHeight ?? 0),
        t('. The page was slower to capture than it was long; everything captured is below.'),
      ],
      settingsLink: false,
    }
  }

  if (job.truncated && job.fullDocumentHeight) {
    const captured = Math.round(((job.finalDocumentHeight ?? 0) / job.fullDocumentHeight) * 100)
    // The cap is PageShotter's section ceiling, not Chrome's canvas limit: capture is tiled now, so
    // saying "longer than Chrome can save in a single image" would name the wrong reason.
    return {
      parts: [
        t('This page is longer than PageShotter captures in one run, so it captured the first '),
        value(`${captured}%`),
        t(' of it ('),
        num(job.finalDocumentHeight ?? 0),
        t(' of '),
        ...pixels(job.fullDocumentHeight),
        t(', in '),
        ...sections(CAPTURE_LIMITS.maxSegments),
        t('). Everything captured is below.'),
      ],
      settingsLink: false,
    }
  }

  /*
   * Last, and reached only when the capture did not stop.
   *
   * Every branch above says the screenshot is *incomplete*, and that is the more urgent thing to
   * know -- a reader told their capture stopped at 40% does not also need to hear that one video in
   * it is black. This one is for the case that has no other tell: the capture ran to the end, the
   * picture looks finished, and part of it is blank or black anyway.
   */
  const degraded = degradationParts(job.degradations)
  if (degraded) return { parts: degraded, settingsLink: false }

  return null
}
