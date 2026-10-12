/**
 * Zoom arithmetic for the preview, kept pure so it can be tested without a stage to measure.
 *
 * Zoom is expressed as a scale against the capture's own pixel width, so 100% means one screen pixel
 * per captured pixel and `fit` is whatever scale makes the capture exactly as wide as the stage.
 */

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 3
export const ZOOM_STEP = 0.1

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  // Rounded to whole percentages: floating-point addition of 0.1 lands on 0.30000000000000004, and
  // the readout would then show 30% while the width was computed from a different number.
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale)) * 100) / 100
}

export function zoomIn(scale: number): number {
  return clampZoom(scale + ZOOM_STEP)
}

export function zoomOut(scale: number): number {
  return clampZoom(scale - ZOOM_STEP)
}

/**
 * The scale that makes the capture fill the stage's usable width.
 *
 * Capped at 1 so `Fit` never *enlarges* a narrow capture: a 400px-wide region blown up to fill a
 * 1400px stage is a blurry lie about what will be exported, and the whole point of this preview is
 * that it shows the pixels the file will contain.
 */
export function fitZoom(stageWidth: number, gutter: number, imageWidth: number): number {
  if (imageWidth <= 0) return 1
  const available = stageWidth - gutter
  if (available <= 0) return ZOOM_MIN
  return clampZoom(Math.min(1, available / imageWidth))
}

/** The rendered width, in CSS pixels, at a given scale. */
export function zoomedWidth(imageWidth: number, scale: number): number {
  return Math.max(1, Math.round(imageWidth * clampZoom(scale)))
}

export function zoomPercentLabel(scale: number): string {
  return `${Math.round(clampZoom(scale) * 100)}%`
}
