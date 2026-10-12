/**
 * The crop rectangle the export paths take, in image pixels. Cropping itself is an editor mode now
 * (`scene.ts`); what is left here is the shape exporters share and the whole-image default.
 */

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A selection smaller than this in image pixels is a stray click or a twitch during a click, not a
 * crop anyone meant to make. Exporting an 3x1px image because a drag slipped is worse than ignoring
 * it, and ignoring it costs the user nothing: they simply drag again.
 */
export const MIN_CROP_PX = 8

/** The whole image as a crop, so export paths can take one code path whether or not a crop is set. */
export function fullImageCrop(imageWidth: number, imageHeight: number): CropRect {
  return { x: 0, y: 0, width: imageWidth, height: imageHeight }
}
