// Match the GPT Image 2 presets used by the reference app. "2K" means the
// longest edge is around 2K, not that every edge is 2048 pixels.
export const OUTPUT_PRESETS = [
  { ratio: '1:1', label: '方图', sizes: { '1K': '1024x1024', '2K': '2048x2048' } },
  { ratio: '4:5', label: '竖图', sizes: { '1K': '1024x1280', '2K': '1600x2000' } },
  { ratio: '3:4', label: '竖图', sizes: { '1K': '1152x1536', '2K': '1536x2048' } },
  { ratio: '2:3', label: '全身', sizes: { '1K': '1024x1536', '2K': '1344x2016' } },
  { ratio: '9:16', label: '长竖图', sizes: { '1K': '864x1536', '2K': '1152x2048' } },
  { ratio: '9:21', label: '超长竖图', sizes: { '1K': '672x1568', '2K': '1152x2688' } },
  { ratio: '5:4', label: '横图', sizes: { '1K': '1280x1024', '2K': '2000x1600' } },
  { ratio: '4:3', label: '横图', sizes: { '1K': '1536x1152', '2K': '2048x1536' } },
  { ratio: '3:2', label: '横图', sizes: { '1K': '1536x1024', '2K': '2016x1344' } },
  { ratio: '16:9', label: '宽屏', sizes: { '1K': '1536x864', '2K': '2048x1152' } },
  { ratio: '21:9', label: '超宽屏', sizes: { '1K': '1568x672', '2K': '2688x1152' } },
];
export const RESOLUTIONS = ['1K', '2K'];
export const RESOLUTION_LABELS = { '1K': '标准 1K', '2K': '高清 2K' };

// The first version incorrectly treated 2K as a 2048-pixel short edge. Keep
// these aliases readable and migrate them to the corrected preset on reuse.
const LEGACY_SIZE_ALIASES = [
  { size: '2048x3072', ratio: '2:3', resolution: '2K' },
  { size: '3072x2048', ratio: '3:2', resolution: '2K' },
];

function settingsForSize(size) {
  for (const preset of OUTPUT_PRESETS) {
    for (const resolution of RESOLUTIONS) {
      if (preset.sizes[resolution] === size) return { ratio: preset.ratio, resolution };
    }
  }
  return LEGACY_SIZE_ALIASES.find(item => item.size === size);
}

export function resolveOutputSettings(input = {}) {
  const fromSize = settingsForSize(input.size);
  if (input.size !== undefined && !fromSize) throw new Error('请选择有效的图片尺寸。');
  const aspectRatio = input.aspectRatio ?? fromSize?.ratio ?? '2:3';
  const preset = OUTPUT_PRESETS.find(p => p.ratio === aspectRatio);
  if (!preset) throw new Error('请选择有效的图片比例。');
  const resolution = input.resolution ?? fromSize?.resolution ?? '1K';
  if (!RESOLUTIONS.includes(resolution)) throw new Error('请选择 1K 或 2K 分辨率。');
  return { aspectRatio, resolution, size: preset.sizes[resolution] };
}

export const pixelLabel = size => size?.replace('x', ' × ') || '';
