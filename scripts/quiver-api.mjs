import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
export const QUIVER_TIMEOUT_MS = 10 * 60 * 1000;
export function quiverOptions(input = {}) {
  const model = input.model ?? 'arrow-2-telos', reasoningEffort = input.reasoningEffort ?? 'high';
  if (!['arrow-2', 'arrow-2-telos'].includes(model)) throw invalid('Quiver 模型请选择 Arrow 2 或 Arrow 2 Telos。');
  if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw invalid('Quiver 推理强度不正确。');
  return { model, reasoningEffort };
}
function baseUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw invalid('Quiver 接口地址不正确。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('Quiver 接口地址不能包含密钥或查询参数。');
  return url.href.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
}
export async function quiverImage(bytes) {
  const metadata = await sharp(bytes, { limitInputPixels: 67108864 }).metadata();
  if (bytes.length <= 12 * 1024 * 1024 && metadata.width <= 4096 && metadata.height <= 4096) return bytes;
  const png = await sharp(bytes, { limitInputPixels: 67108864 }).rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  if (png.length <= 12 * 1024 * 1024) return png;
  const jpeg = await sharp(png).flatten({ background: '#fff' }).jpeg({ quality: 90 }).toBuffer();
  if (jpeg.length > 12 * 1024 * 1024) throw invalid('参考图超过 Quiver 的 12 MB 限制，请使用较小的图片。');
  return jpeg;
}
export function safeQuiverSvg(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024 || !/<svg[\s>]/i.test(value) || !/<\/svg>\s*$/i.test(value)) throw invalid('Quiver 未返回完整 SVG 文件。', 502);
  // SVG is downloaded as an attachment and rasterized locally, never inserted as HTML.
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)|<(?:[\w-]+:)?(?:script|foreignObject|iframe|object|embed|audio|video|image|animate\w*|set)\b|\bon[a-z]+\s*=/i.test(value)) throw invalid('Quiver 返回的 SVG 含有不支持的外部内容，请重新生成。', 502);
  // Keep XML/SVG namespace URLs and benign metadata. Only resource-bearing attributes
  // are checked: fragment references (href="#id", url(#id)) stay local and are safe.
  for (const match of value.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
    if (!/^\s*#/.test(match[2])) throw invalid('Quiver 返回的 SVG 含有不支持的外部内容，请重新生成。', 502);
  }
  if (/@import\b|url\(\s*["']?(?!#)[^)]/i.test(value)) throw invalid('Quiver 返回的 SVG 含有不支持的外部内容，请重新生成。', 502);
  return value;
}
export function createQuiverService(options = {}) {
  let settings = { baseUrl: 'https://api.quiver.ai/v1', ...quiverOptions() }, filename;
  let writes = Promise.resolve();
  const fetcher = options.fetch || fetch;
  const publicSettings = () => ({ baseUrl: settings.baseUrl, ...quiverOptions(settings), configured: Boolean(settings.apiKey), maskedKey: settings.apiKey ? `••••${settings.apiKey.slice(-4)}` : '' });
  const request = (selection = {}) => {
    if (!settings.apiKey) throw invalid('请先在系统设置填写 Quiver 矢量线稿接口。', 503);
    return { key: settings.apiKey, baseUrl: settings.baseUrl, protocol: 'quiver', ...quiverOptions({ ...settings, ...selection }) };
  };
  return {
    async init(directory) {
      filename = path.join(directory, 'quiver-settings.json');
      try { settings = { ...settings, ...JSON.parse(await readFile(filename, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    settings: publicSettings, request, requireConfigured: () => request(),
    updateSettings(input) {
      const pending = writes.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Quiver 设置不正确。');
        const next = { ...settings, ...quiverOptions({ ...settings, ...input }), baseUrl: baseUrl(input.baseUrl ?? settings.baseUrl) };
        if (input.clearKey) next.apiKey = '';
        else if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.apiKey = input.apiKey.trim().slice(0, 10000);
        const temp = `${filename}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temp, filename); settings = next;
        return publicSettings();
      }); writes = pending.catch(() => {}); return pending;
    },
    async test() {
      const config = request();
      const response = await fetcher(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw invalid(`Quiver 连接检测失败（HTTP ${response.status}）。`, 502);
      const result = await response.json();
      return { models: (Array.isArray(result.data) ? result.data : []).filter(item => ['arrow-2', 'arrow-2-telos'].includes(item.id)).map(item => ({ id: item.id, supported_operations: item.supported_operations || [] })) };
    },
    async generate(args) {
      const { model, reasoningEffort } = quiverOptions(args), signal = AbortSignal.timeout(Math.min(args.timeoutMs || QUIVER_TIMEOUT_MS, QUIVER_TIMEOUT_MS));
      let response;
      try {
        const references = [];
        for (const image of args.images) references.push({ base64: (await quiverImage(image.data)).toString('base64') });
        const metadata = await sharp(args.images[0].data).metadata(), dimensions = metadata.autoOrient || metadata;
        response = await fetcher(`${args.baseUrl}/svgs/generations`, {
          method: 'POST', headers: { Authorization: `Bearer ${args.key}`, 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ model, reasoning_effort: reasoningEffort, stream: false, n: args.count || 1, references,
            attributes: { viewBox: { minX: 0, minY: 0, width: dimensions.width, height: dimensions.height } },
            prompt: args.prompt,
            instructions: args.vector
              ? 'Create a polished full-color apparel illustration as a self-contained SVG, with the same visual style and level of finish as the Quiver web experience. Use the reference image and use the user conversation prompt as the instruction. Extract the requested garment itself, isolated from its wearer, with filled shapes, color, subtle shading and visible material details. Do not produce a black-and-white technical flat or a fashion portrait. Use paths and basic SVG shapes only; do not embed raster images, external resources, scripts, text, labels or watermarks.'
              : 'Create a clean black-and-white apparel technical flat as a self-contained SVG. Preserve the reference silhouette, seams, pockets, fasteners and viewpoint. White background, black strokes, no color fills, shading, fabric texture, people, labels or watermark. Use paths and basic SVG shapes only, without embedded images, external resources, scripts or animation.' }),
        });
        const result = await response.json().catch(() => null), requestId = response.headers.get('x-request-id') || result?.request_id || result?.id;
        if (!response.ok) throw Object.assign(new Error(`Quiver 返回 HTTP ${response.status}${result?.code ? `（${String(result.code).replace(/[^a-z_]/g, '').slice(0, 80)}）` : ''}。`), { status: response.status, providerCode: result?.code, requestId });
        if (!Array.isArray(result?.data) || !result.data.length || result.data.length > 4) throw invalid('Quiver 未返回完整矢量线稿。', 502);
        const outputs = [];
        for (const item of result.data) {
          const svg = safeQuiverSvg(item.svg);
          const png = await sharp(Buffer.from(svg), { limitInputPixels: 67108864 }).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
          signal.throwIfAborted();
          Object.assign(png, { svg, requestId, httpStatus: response.status, modelUsed: model, usage: result.usage }); outputs.push(png);
        }
        return outputs;
      } catch (error) {
        error.isLocalTimeout = signal.aborted;
        error.requestId ||= response?.headers?.get('x-request-id');
        throw error;
      }
    },
  };
}
