import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareImageInputs } from './image-input.mjs';
import { openAIEdit } from './import-job-api.mjs';
import { geminiDesignNativeFields, normalizeDesignNativeOptions, resolveDesignOutput } from './design-output-settings.mjs';

export const DEFAULT_DESIGN_GENERATION_IMPORT_PATH = 'E:\\新建文件夹 (6)\\新建文件夹\\新建文件夹\\新建文件夹\\easyConfig.json';
const short = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

function normalizeBaseUrl(value) {
  const clean = short(value, 1000).replace(/\/+$/, '');
  let url;
  try { url = new URL(clean); } catch { throw invalid('设计出图接口地址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('设计出图接口地址须为不含密钥、查询参数的 http 或 https 地址。');
  return clean;
}

function normalizeProtocol(value) {
  const protocol = value ?? 'gemini';
  if (!['gemini', 'openai'].includes(protocol)) throw invalid('设计出图协议请选择 Gemini 或 OpenAI。');
  return protocol;
}

export function geminiDesignEndpoint(baseUrl, model) {
  const base = normalizeBaseUrl(baseUrl).replace(/\/(?:v1|v1beta)$/, '');
  return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function originalImageOutputs(result) {
  const outputs = [];
  for (const candidate of Array.isArray(result?.candidates) ? result.candidates : []) {
    for (const part of candidate?.content?.parts || []) {
      const inline = part?.inlineData || part?.inline_data;
      if (!inline || typeof inline.data !== 'string') continue;
      const mime = inline.mimeType || inline.mime_type || 'image/png';
      if (!/^image\/(png|jpeg|webp)$/.test(mime)) continue;
      const encoded = inline.data.replace(/[\r\n\s]/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('设计出图接口返回了不完整的图片数据。');
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('设计出图接口返回了不完整的图片数据。');
      outputs.push(bytes);
    }
  }
  return outputs;
}

export async function geminiDesignGenerate({ key, baseUrl, model, images, prompt, aspectRatio, resolution, count = 1, safetyPreset='default', googleSearch=false, timeoutMs = 300000, compressInput = false }, options = {}) {
  if (!Number.isInteger(count)||count<1||count>4) throw invalid('设计出图数量请选择 1–4 张。');
  resolveDesignOutput({aspectRatio,resolution});
  const nativeFields=geminiDesignNativeFields({safetyPreset,googleSearch});
  const inputs = await prepareImageInputs(images, { compressInput });
  const effectiveModel = String(model || '').trim();
  const endpoint = geminiDesignEndpoint(baseUrl, effectiveModel);
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 300000;
  const signal = AbortSignal.timeout(timeout);
  const fetcher = options.fetch || fetch;
  let response, result;
  try {
    response = await fetcher(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, ...inputs.map(image => ({ inlineData: { mimeType: image.mime, data: image.data.toString('base64') } }))] }],
        generationConfig: { temperature: 0.7, candidateCount:count, responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio, imageSize: resolution } },
        ...nativeFields,
      }),
    });
    try { result = await response.json(); }
    catch (error) {
      if (signal.aborted) throw signal.reason || error;
      throw new Error(response.status === 413 ? '设计出图接口拒绝了过大的上传请求（HTTP 413）。' : `设计出图接口返回了无法解析的响应（HTTP ${response.status}）。`, { cause: error });
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.isLocalTimeout = signal.aborted; failure.timeoutMs = timeout;
    failure.status = response?.status;
    if (response?.status === 413) failure.failureKind = 'input_too_large';
    failure.requestId = response?.headers?.get('x-request-id') || response?.headers?.get('request-id') || null;
    failure.networkCode = error?.cause?.code || error?.code || null;
    failure.networkMessage = error?.cause?.message || null;
    throw failure;
  }
  const requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || result?.responseId || result?.response_id || null;
  if (!response.ok) {
    // Never return raw upstream bodies: gateways may echo request credentials.
    const error = new Error(`设计出图接口返回 HTTP ${response.status}，请检查独立出图配置和服务商状态。`);
    error.status = response.status; error.requestId = requestId;
    error.providerCode = short(String(result?.error?.status || result?.error?.code || ''), 100) || null;
    if (response.status === 413) error.failureKind = 'input_too_large';
    throw error;
  }
  const outputs = originalImageOutputs(result);
  if (!outputs.length) {
    const error = new Error('设计出图接口没有返回图片，请检查该模型是否支持图片生成。');
    error.status = response.status; error.requestId = requestId;
    throw error;
  }
  for (const bytes of outputs) Object.defineProperties(bytes, {
    requestId: { value: requestId, enumerable: false }, httpStatus: { value: response.status, enumerable: false }, modelUsed: { value: effectiveModel, enumerable: false },
  });
  return outputs.length === 1 ? outputs[0] : outputs;
}

export function createDesignGenerationService(options = {}) {
  let settings = {}, settingsPath;
  let writes = Promise.resolve();
  const editor = options.imageEdit || openAIEdit;
  const publicSettings = () => ({ baseUrl: settings.baseUrl || 'https://api.openlux.ai', model: settings.model || '', protocol: settings.protocol || 'gemini',
    configured: Boolean(settings.apiKey && settings.model), maskedKey: settings.apiKey ? `••••${settings.apiKey.slice(-4)}` : '', imported: settings.imported === true });
  async function persist(next) {
    const temporary = `${settingsPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, settingsPath); settings = next;
  }
  const snapshot = () => {
    if (!settings.apiKey || !settings.model) throw invalid('请先填写设计工作台的独立出图接口设置。', 503);
    return { key: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, protocol: settings.protocol || 'gemini' };
  };
  return {
    async init(storeDir) {
      settingsPath = path.join(storeDir, 'design-generation-settings.json');
      try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let imported = {};
      const source = options.importPath === undefined ? DEFAULT_DESIGN_GENERATION_IMPORT_PATH : options.importPath;
      if (source) {
        try {
          const configs = JSON.parse(await readFile(source, 'utf8'));
          const config = Array.isArray(configs) ? configs.find(item => item.name === 'api') || configs[0] : configs;
          if (config?.api_key && config?.api_base_url && config?.model) imported = {
            apiKey: short(config.api_key, 10000), baseUrl: normalizeBaseUrl(config.api_base_url), model: short(config.model, 200), imported: true,
          };
        } catch { /* Missing legacy configuration must not prevent FPA from starting. */ }
      }
      await persist({ version: 1, protocol: 'gemini', ...imported });
    },
    settings: publicSettings,
    request: snapshot,
    requireConfigured() { snapshot(); },
    validateCount(count) { if(!Number.isInteger(count)||count<1||count>4)throw invalid('设计出图数量请选择 1–4 张。'); },
    updateSettings(input) {
      const task = writes.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('设计出图设置格式不正确。');
        const next = { ...settings, baseUrl: normalizeBaseUrl(input.baseUrl ?? publicSettings().baseUrl), model: short(input.model ?? settings.model, 200), protocol: normalizeProtocol(input.protocol ?? settings.protocol) };
        if (!next.model || /\s/.test(next.model)) throw invalid('请填写有效的设计出图模型名称。');
        if (input.clearKey) next.apiKey = '';
        else if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.apiKey = short(input.apiKey, 10000);
        await persist(next); return publicSettings();
      });
      writes = task.catch(() => {}); return task;
    },
    async generate(args) {
      resolveDesignOutput(args,args.protocol);
      normalizeDesignNativeOptions(args,args.protocol);
      if (args.protocol === 'gemini') return geminiDesignGenerate(args, { fetch: options.fetch });
      if (args.protocol !== 'openai') throw invalid('设计出图协议无效。');
      // A bare hostname is common in the imported Gemini configuration. For
      // explicitly selected OpenAI mode, use the standard /v1 base endpoint.
      const baseUrl = new URL(args.baseUrl).pathname === '/' ? `${args.baseUrl}/v1` : args.baseUrl;
      return editor({ ...args, baseUrl });
    },
  };
}
