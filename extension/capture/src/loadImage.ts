export interface LoadedImage {
  source: CanvasImageSource
  width: number
  height: number
}
/** Decodes the screenshot at full size (the stage draws the same object URL; no reduced preview, a screenshot stays sharp when zoomed). */
export function loadImage(url: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => {
      if (im.naturalWidth <= 0) return reject(new Error('The image could not be loaded'))
      resolve({ source: im, width: im.naturalWidth, height: im.naturalHeight })
    }
    im.onerror = () => reject(new Error('The image could not be loaded'))
    im.src = url
  })
}
