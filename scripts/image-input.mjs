import sharp from 'sharp';
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, MAX_TASK_IMAGE_BYTES, imageLimitMessage } from '../src/image-limits.mjs';

// This is the application's budget for an explicitly requested compressed
// retry, not a provider's documented upload limit. Normal requests ignore it.
export const COMPRESSED_INPUT_BUDGET_BYTES = 18 * 1024 * 1024;

const IMAGE_TYPES = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
};

export async function identifyImageInput(data) {
  const metadata = await sharp(data).metadata();
  const type = IMAGE_TYPES[metadata.format];
  if (!type) throw Object.assign(new Error('参考图片请使用 PNG、JPEG 或 WebP 格式。'), { status: 400 });
  if ((metadata.pages || 1) > 1) throw Object.assign(new Error('参考图片请使用静态 PNG、JPEG 或 WebP 图片。'), { status: 400 });
  return { data, ...type, metadata };
}

function imageName(name, extension, index) {
  const original = String(name || '').replaceAll('\\', '/').split('/').at(-1);
  const stem = original.replace(/\.[^.]*$/, '') || `image-${index + 1}`;
  return `${stem}.${extension}`;
}

async function compressedImage(image, budget) {
  const { data, metadata } = image;
  const rotated = [5, 6, 7, 8].includes(metadata.orientation);
  const originalWidth = rotated ? metadata.height : metadata.width;
  const originalHeight = rotated ? metadata.width : metadata.height;
  // ICC conversion preserves the displayed colour when making the optional
  // copy. auto-orientation applies EXIF before its tag is discarded. Default
  // transport never enters this path and retains every original metadata byte.
  const pipeline = (width, height) => {
    const input = sharp(data).rotate().withIccProfile('srgb');
    return width === originalWidth && height === originalHeight
      ? input : input.resize(width, height, { fit: 'inside', withoutEnlargement: true });
  };
  const geometryScale = Math.min(1, MAX_IMAGE_SIDE / originalWidth, MAX_IMAGE_SIDE / originalHeight, Math.sqrt(MAX_IMAGE_PIXELS / (originalWidth * originalHeight)));
  let width = Math.max(1, Math.floor(originalWidth * geometryScale));
  let height = Math.max(1, Math.floor(originalHeight * geometryScale));
  let smallest = image;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Keep all pixels on the first pass. Transparent inputs use lossless WebP
    // so alpha and edge colours are never flattened onto a background.
    const candidates = metadata.hasAlpha
      ? [{ format: 'webp', options: { lossless: true, effort: 4 } }]
      : [{ format: 'jpeg', options: { quality: 92, chromaSubsampling: '4:4:4' } },
        { format: 'jpeg', options: { quality: 85, chromaSubsampling: '4:4:4' } }];
    for (const candidate of candidates) {
      const bytes = await pipeline(width, height)[candidate.format](candidate.options).toBuffer();
      const result = { data: bytes, ...IMAGE_TYPES[candidate.format] };
      if (bytes.length < smallest.data.length) smallest = result;
      if (smallest.data.length <= budget) return smallest;
    }
    if (smallest.data.length <= budget) return smallest;
    if (width === 1 && height === 1) break;
    // Only reduce dimensions once full-resolution encodings exceed the
    // per-image share. Preserve aspect ratio without a fixed 2048px ceiling.
    const scale = Math.min(0.85, Math.sqrt(budget / smallest.data.length) * 0.92);
    const nextWidth = Math.max(1, Math.floor(width * scale));
    const nextHeight = Math.max(1, Math.floor(height * scale));
    width = nextWidth;
    height = nextHeight;
  }
  throw Object.assign(new Error('参考图压缩后仍超过发送预算，请减少参考图片后重试。'), { failureKind: 'input_compression_failed' });
}

export async function prepareImageInputs(images, { compressInput = false, maxTotalBytes = COMPRESSED_INPUT_BUDGET_BYTES } = {}) {
  const identified = [];
  for (const image of images) identified.push({ ...await identifyImageInput(image.data), originalName: image.name });
  if (!compressInput) {
    const totalBytes = identified.reduce((sum, image) => sum + image.data.length, 0);
    const limitMessage = identified.map(image => imageLimitMessage({ bytes: image.data.length, width: image.metadata.width, height: image.metadata.height })).find(Boolean)
      || (totalBytes > MAX_TASK_IMAGE_BYTES ? '本次参考图片超过本地 128MB 总量上限。' : '');
    if (limitMessage) throw Object.assign(new Error(limitMessage), { failureKind: 'input_too_large', inputLimitSource: 'local' });
  }
  if (!compressInput) return identified.map((image, index) => ({
    data: image.data, mime: image.mime, name: imageName(image.originalName, image.extension, index),
  }));
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error('Invalid compressed input budget');
  const totalBytes = identified.reduce((sum, image) => sum + image.data.length, 0);
  const prepared = [];
  for (const [index, image] of identified.entries()) {
    const budget = Math.max(1, Math.min(Math.floor(maxTotalBytes * image.data.length / totalBytes), Math.floor(image.data.length * 0.9)));
    const compressed = await compressedImage(image, budget);
    prepared.push({ data: compressed.data, mime: compressed.mime, name: imageName(image.originalName, compressed.extension, index) });
  }
  if (prepared.reduce((sum, image) => sum + image.data.length, 0) > maxTotalBytes) {
    throw Object.assign(new Error('参考图压缩后仍超过发送预算，请减少参考图片后重试。'), { failureKind: 'input_compression_failed' });
  }
  return prepared;
}
