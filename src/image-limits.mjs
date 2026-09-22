// Local resource limits, aligned with the reference application's image policy.
// They are not a claim about any provider's upload limits.
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 16384;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_TASK_IMAGE_BYTES = 128 * 1024 * 1024;
export const MAX_UPLOAD_JSON_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;

export function imageLimitMessage({ bytes, width, height }) {
  if (bytes > MAX_IMAGE_BYTES) return '单张原图超过本地 50MB 上传上限。';
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    return '原图超过本地尺寸上限（单边 16384 像素，总像素 6710 万）。';
  }
  return '';
}
