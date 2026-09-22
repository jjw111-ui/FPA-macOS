import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { openAIEdit } from './import-job-api.mjs';
import { OUTPUT_PRESETS, RESOLUTIONS, pixelLabel, resolveOutputSettings } from '../src/output-settings.mjs';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_UPLOAD_JSON_BYTES, imageLimitMessage } from '../src/image-limits.mjs';
import { buildDesignGuide, buildDesignPrompt, createDesignService, MAX_DESIGN_JSON_BYTES, normalizeDesignInput } from './design-api.mjs';
import { GEMINI_DESIGN_PRESETS, GEMINI_DESIGN_RESOLUTIONS, normalizeDesignNativeOptions, resolveDesignOutput } from './design-output-settings.mjs';
import { createDesignGenerationService } from './design-generation-api.mjs';
import { createQuiverService, quiverOptions, QUIVER_TIMEOUT_MS } from './quiver-api.mjs';
import { createTypeSafeSearchService, TYPESAFE_TIMEOUT_MS } from './typesafe-search.mjs';
import { normalizeSearchMetadata } from './asset-labels.mjs';
import { searchDocument, currentSearchMetadata } from '../src/asset-search.mjs';

export const CATEGORIES = {
  upperbody: '上衣', wholebody_up: '外套', lowerbody: '下装', dress: '内搭',
  shoes: '鞋子', accessories_up: '配饰', fabric: '面料', trims: '辅料', person: '人物体型', face: '人物人脸', pose: '人物姿势', scene: '场景',
};

const garmentParts = new Set(['upperbody', 'wholebody_up', 'lowerbody', 'dress', 'shoes', 'accessories_up']);
const materialParts = new Set(['fabric', 'trims']);
const cleanableParts = new Set([...garmentParts, ...materialParts]);
const peopleParts = new Set(['face', 'person']);
const sceneParts = new Set(['scene']);
const qualities = new Set(['auto', 'low', 'medium', 'high']);
const outputFormats = new Set(['png', 'jpeg', 'webp']);
const moderations = new Set(['auto', 'low']);
const fileMimes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const short = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const send = (res, status, value) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
};

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

let legacyLibraryCache = null;
let legacyLibraryPath = null;
async function readLegacyLibrary(filePath) {
  if (legacyLibraryPath === filePath && legacyLibraryCache !== null) return legacyLibraryCache;
  legacyLibraryCache = await readJson(filePath, []);
  legacyLibraryPath = filePath;
  return legacyLibraryCache;
}

async function serveThumbnail(req, res, storeDir, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.svg') return false;
  const thumbDir = path.join(storeDir, 'thumbs');
  const thumbName = `${path.basename(filename, ext)}.webp`;
  const thumbPath = path.join(thumbDir, thumbName);
  try {
    const thumbStat = await stat(thumbPath);
    if (thumbStat.isFile()) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Content-Length', thumbStat.size);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (req.method === 'HEAD') { res.end(); return true; }
      createReadStream(thumbPath).pipe(res);
      return true;
    }
  } catch { /* Cache miss, generate below. */ }
  try {
    const source = await readFile(path.join(storeDir, filename));
    const thumb = await sharp(source, { limitInputPixels: 60000000 })
      .rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 }).toBuffer();
    await mkdir(thumbDir, { recursive: true });
    await writeFile(path.join(thumbDir, thumbName), thumb);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', thumb.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (req.method === 'HEAD') { res.end(); return true; }
    res.end(thumb);
    return true;
  } catch { return false; }
}

async function payload(req, maxBytes = MAX_UPLOAD_JSON_BYTES) {
  let count = 0; const chunks = [];
  for await (const chunk of req) {
    count += chunk.length;
    if (count > maxBytes) throw invalid(maxBytes === MAX_DESIGN_JSON_BYTES ? '本次参考图请求过大，请控制单张 50MB、合计 128MB 以内。' : '图片过大，请使用 50MB 以内的原图。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw invalid('请求格式不正确。'); }
}

function normalizeBaseUrl(value) {
  const clean = short(value, 1000).replace(/\/$/, '');
  let parsed;
  try { parsed = new URL(clean); } catch { throw invalid('接口地址格式不正确。'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw invalid('接口地址必须使用 http 或 https。');
  return clean;
}

function normalizeQuality(value, fallback = 'high') {
  const quality = short(value, 20) || fallback;
  if (!qualities.has(quality)) throw invalid('请选择有效的出图画质。');
  return quality;
}

function normalizeCount(value, fallback = 1) {
  const count = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw invalid('出图数量请选择 1–4 张。');
  return count;
}

function normalizeOutputFormat(value, fallback = 'png') {
  const format = short(value, 20) || fallback;
  if (!outputFormats.has(format)) throw invalid('请选择 PNG、JPEG 或 WebP 输出格式。');
  return format;
}

function normalizeModeration(value, fallback = 'auto') {
  const moderation = short(value, 20) || fallback;
  if (!moderations.has(moderation)) throw invalid('请选择有效的审核强度。');
  return moderation;
}

async function encodeOutput(bytes, format, targetSize) {
  let pipeline = sharp(bytes, { limitInputPixels: 60000000 }).rotate().toColorspace('srgb');
  if (targetSize?.width && targetSize?.height) {
    pipeline = pipeline.resize(targetSize.width, targetSize.height, { fit: 'cover', position: 'centre' });
  }
  if (format === 'jpeg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 95 });
  else if (format === 'webp') pipeline = pipeline.webp({ quality: 95 });
  else pipeline = pipeline.png();
  return pipeline.toBuffer({ resolveWithObject: true });
}

function buildScenePrompt(asset) {
  return `Perform a pixel-faithful background cleanup, not a scene redesign. Remove only the person, their face, body, clothing, accessories, footwear, logos and cast/contact shadows. Preserve all background pixels outside the removed subject as closely as possible. Match the original white balance, exposure, saturation, contrast, hue, color temperature, lighting falloff and background gradient exactly. Do not recolor, relight, restyle, blur, simplify, crop, zoom or replace the scene. Inpaint only the removed subject area using the immediately surrounding background. Preserve the original camera viewpoint, composition, perspective, geometry and empty space. The final image must contain no person or fashion item and must look like the same photograph after the subject was cleanly removed. ${asset.notes || ''}`;
}

function buildProductPrompt(asset) {
  if (asset.part === 'fabric') {
    return `Create a faithful fabric swatch reference from the supplied image. Target fabric name: ${asset.name}. User target and detail notes: ${asset.notes || 'Use the main fabric visible in the reference.'}
Extract the actual visible fabric as a flat material sample for clothing design. Preserve its exact color, texture, weave or knit structure, grain direction, surface finish, transparency, print and pattern repeat, and the original relative scale of every visible detail. Keep the original viewpoint and magnification; do not enlarge the weave or change pattern scale.
Remove garment form, seams unrelated to the target sample, wearer, hands, hanger and background only as needed to show the fabric itself. When the reference is already a flat swatch or a close-up, retain that material view and clean only distracting surroundings. Place a bounded swatch on a plain neutral white background; an existing fabric close-up may retain its full-frame material view. Use neutral lighting without recoloring or flattening the visible texture.
Do not invent weave, knit stitches, fibers, print, pattern, branding or missing material details. Use only clearly visible fabric; do not extrapolate hidden areas, synthesize a new seamless pattern, turn it into a garment, or add a model, props, captions or watermark. This output is a design material reference, not a wearable product.`;
  }
  if (asset.part === 'trims') {
    return `Create an isolated garment trim reference from the supplied image. Target trim name: ${asset.name}. User target and detail notes: ${asset.notes || 'Use the main garment trim visible in the reference.'}
Extract ONLY the actual selected trim, such as buttons, a zipper, a label, cord, buckle, fastener or metal hardware. Remove the wearer, hands, unrelated clothing, surrounding fabric, other products and original background only as needed to isolate it. Preserve fabric tape, attachment loops or other material that is an integral part of the trim.
Preserve the exact item shape, proportions, material, color, texture, finish and construction details, including button holes, zipper teeth and puller, label edges, stitching, cord tips, engravings and existing readable text. Keep all text and logos exactly as observed: do not invent, rewrite, mirror or reverse text, and do not guess obscured characters. Do not redesign, recolor, simplify, duplicate or invent hidden components.
Show the complete visible trim centered on a plain white background with soft neutral lighting and a subtle contact shadow. Keep the reference viewpoint and realistic geometry without cropping item edges. Retain the actual number of pieces in a referenced pair or set; never add pieces. No person, garment silhouette, unrelated items, captions or added watermark. This output is a design material reference, not a wearable accessory.`;
  }
  if (asset.part === 'accessories_up') {
    return `Create an isolated accessory product photograph from the reference image. Target accessory name: ${asset.name}. User target and detail notes: ${asset.notes || 'Use the main accessory visible in the reference.'}
Extract ONLY the target accessory, such as a hat, bag, glasses, belt, scarf, jewelry or another selected accessory. Remove the person, face, hair, hands, body, unrelated clothing, other products, display stands and original background. Do not turn the result into a garment photograph or a dressed model.
Preserve the accessory's exact shape, proportions, color, material, texture, pattern, stitching, logos and readable markings. Keep functional details intact: bag handles and straps, buckles, zippers, metal hardware, chains, hat brims, glasses frames and lenses. Preserve transparent or open areas naturally. Do not replace, simplify, recolor or redesign the accessory, and do not add new branding or decoration.
Show the complete accessory centered on a plain white background with soft neutral product lighting and a subtle contact shadow. Keep the reference viewpoint and realistic geometry; do not crop handles, straps or edges. If the target is a matching pair or set shown in the reference, retain that pair or set without duplicating or inventing extra pieces. Where the wearer obscures the product, reconstruct only the necessary missing product contours conservatively from visible details. No person, mannequin, unrelated items, captions or added watermark.`;
  }
  return `Create a clean product photograph of ONLY the ${CATEGORIES[asset.part]} named ${asset.name} from the reference. Remove wearer, hanger, other garments and background. Use a plain white background. Preserve exact garment construction, material, color, length and legible graphics. Do not redesign. Show complete garment, no clipping. ${asset.notes || ''}`;
}

export function buildOutfitPrompt(refs, input) {
  const roles = refs.map((asset, index) => {
    const role = asset.part === 'face'
      ? 'Only facial identity and hair. Do not borrow body proportions, clothing, pose or background.'
      : asset.part === 'person'
        ? `${refs.some(reference => reference.part === 'face') ? 'Body proportions only; facial identity comes from the face reference.' : 'Identity, hair and body proportions only.'} Preserve the reference head-to-body ratio, shoulder width, torso length and leg proportions. Treat every garment, sleeve, arm covering, shoe, accessory, logo, color, lighting cue and background visible in this image as MASKED-OUT INFORMATION. Do not copy any of it. The person image supplies geometry only; it is never a wardrobe source.`
      : asset.part === 'pose'
          ? 'Pose, limb placement and camera angle ONLY. Never copy this reference person, face, clothing or background.'
          : asset.part === 'scene'
            ? 'Scene, background, lighting and environment ONLY. Do not copy any person, face, clothing, pose, logo or product from this reference.'
          : `Exact ${CATEGORIES[asset.part]} product only. Ignore its wearer and background. Preserve color, fabric, silhouette, length, construction, closures and visible graphics.`;
    return `Image ${index + 1}: ${asset.name}. ${role} ${asset.notes ? `Reference notes: ${asset.notes}` : ''}`;
  });
  const sceneReference = refs.find(asset => asset.part === 'scene');
  const sceneInstruction = sceneReference ? 'Use the selected scene reference for the background, lighting and environment. Preserve its visual atmosphere while removing any people, clothing, products, text and logos from it.' : `Scene: ${input.scene || 'neutral light-gray studio background, soft natural light'}.`;
  if (refs.some(asset => asset.part === 'dress')) {
    roles.push('LAYERING: Wear the selected inner layer (内搭) underneath any selected top and outerwear. Keep each garment as a distinct item with its original construction and naturally visible neckline, cuffs or hem. Do not replace the selected top or trousers with the inner layer, and do not invent openings to expose it.');
  }
  return `Create ONE realistic fashion editorial photograph using these references with strictly separated roles.\n${roles.join('\n')}\nREFERENCE PRIORITY AND ISOLATION: Product images control garments. The face image controls facial identity and hair only. The person image controls body geometry only. The pose image controls pose and camera angle only. The scene image controls background, lighting and environment only. Clothing, accessories, logos, colors, lighting and backgrounds visible in person or pose references are forbidden and must not appear in the result. Do not copy pixels, garments or styling from a person/pose reference.\nWARDROBE SOURCE LOCK: The final outfit must contain only the selected product references, each exactly once. A person or pose reference may show a shirt, jacket, trousers, shorts, arm sleeves, gloves, socks or shoes; erase all of those visually before dressing the model. Never use a person/pose reference to fill, replace or complete a clothing slot. Never invent a garment when a slot is unselected.\nWear every selected garment and accessory exactly once. Do not redesign, shorten, lengthen, replace or merge the selected products. If a selected product image shows a wearer, extract only the product and discard that wearer. Preserve recognizable facial identity from the face reference when provided. Layer outerwear naturally without inventing zippers or openings. If no person reference is supplied, use a fictional adult model. If no pose reference is supplied, use this pose: ${input.poseText || 'relaxed front-facing full-body standing, arms away from torso'}.\n${sceneInstruction}\nFull-body framing from head through feet; show shoes only when a shoe product is selected, otherwise show natural feet or the appropriate lower-body ending. Realistic anatomy and cloth drape, no text overlay or watermark.\nFINAL CHECK BEFORE OUTPUT: verify the selected garment sleeve length, neckline, hem, trouser silhouette and shoe design against their product references; verify that no garment, sleeve, logo or background has been copied from the person/pose references.\nAdditional direction: ${input.direction || 'Keep garments clearly readable.'}`;
}

export function wardrobeStudioApi(options = {}) {
  let root, dataDir, storeDir, dbPath, settingsPath;
  let db = { version: 2, assets: [], jobs: [] };
  let localSettings = {};
  let writeQueue = Promise.resolve();
  let settingsWriteQueue = Promise.resolve();
  let queueSequence = 0;
  const pending = new Map();
  const running = new Set();
  const recognizing = new Map();
  const editor = options.imageEdit || openAIEdit;
  const setting = (name, fallback = '') => Object.hasOwn(localSettings, name)
    ? String(localSettings[name]) : options.env?.[name] ?? process.env[name] ?? fallback;
  const requestTimeoutMs = () => {
    const configured = Number(setting('OPENAI_IMAGE_TIMEOUT_MS', '300000'));
    return Number.isFinite(configured) ? Math.min(300000, Math.max(60000, Math.round(configured))) : 300000;
  };
  const design = createDesignService({ importPath: options.designConfigImportPath, fetch: options.designFetch, timeoutMs: requestTimeoutMs });
  const designGeneration = createDesignGenerationService({ importPath: options.designGenerationConfigImportPath, fetch: options.designGenerationFetch, imageEdit: options.designImageEdit || editor });
  const quiver = createQuiverService({ fetch: options.quiverFetch });
  const typesafe = createTypeSafeSearchService({ fetch: options.typesafeFetch, timeoutMs: options.typesafeTimeoutMs || TYPESAFE_TIMEOUT_MS });
  const concurrencyLimit = () => {
    const configured = Number(setting('OPENAI_IMAGE_CONCURRENCY', '2'));
    return Number.isInteger(configured) ? Math.min(8, Math.max(1, configured)) : 2;
  };
  const compareQueued = (a, b) => (a.queueSequence || 0) - (b.queueSequence || 0)
    || String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt));
  const markQueued = job => Object.assign(job, {
    status: 'queued', queuedAt: new Date().toISOString(), queueSequence: ++queueSequence,
  });
  const save = () => {
    const snapshot = JSON.stringify(db, null, 2);
    const task = writeQueue.then(async () => {
      const temp = `${dbPath}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot); await rename(temp, dbPath);
    });
    writeQueue = task.catch(() => {}); return task;
  };
  const saveSettings = () => {
    const snapshot = JSON.stringify(localSettings, null, 2);
    const task = settingsWriteQueue.then(async () => {
      const temp = `${settingsPath}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, settingsPath);
    });
    settingsWriteQueue = task.catch(() => {}); return task;
  };

  function settingsResponse() {
    const key = setting('OPENAI_API_KEY').trim();
    return {
      configured: Boolean(key), maskedKey: key ? `••••${key.slice(-4)}` : '',
      keySource: Object.hasOwn(localSettings, 'OPENAI_API_KEY') ? '本地设置' : key ? '环境配置' : '未配置',
      baseUrl: setting('OPENAI_API_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
      model: setting('OPENAI_IMAGE_MODEL', 'gpt-image-2'),
      quality: normalizeQuality(setting('OPENAI_IMAGE_QUALITY', 'high')),
      timeoutMinutes: Math.round(requestTimeoutMs() / 60000),
      concurrency: concurrencyLimit(),
    };
  }

  function normalizedSettings(input) {
    const current = settingsResponse();
    const timeoutMinutes = Number(input.timeoutMinutes ?? current.timeoutMinutes);
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 5) throw invalid('等待时间必须是 1–5 分钟的整数。');
    const concurrency = Number(input.concurrency ?? current.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw invalid('同时生成任务数必须是 1–8 的整数。');
    const next = {
      OPENAI_API_BASE_URL: normalizeBaseUrl(input.baseUrl ?? current.baseUrl),
      OPENAI_IMAGE_MODEL: short(input.model ?? current.model, 200),
      OPENAI_IMAGE_QUALITY: normalizeQuality(input.quality, current.quality),
      OPENAI_IMAGE_TIMEOUT_MS: String(timeoutMinutes * 60000),
      OPENAI_IMAGE_CONCURRENCY: String(concurrency),
    };
    if (!next.OPENAI_IMAGE_MODEL || /\s/.test(next.OPENAI_IMAGE_MODEL)) throw invalid('模型名称不正确。');
    if (input.clearKey) next.OPENAI_API_KEY = '';
    else if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.OPENAI_API_KEY = input.apiKey.trim();
    else if (Object.hasOwn(localSettings, 'OPENAI_API_KEY')) next.OPENAI_API_KEY = localSettings.OPENAI_API_KEY;
    return next;
  }

  async function assets() {
    const old = await readLegacyLibrary(path.join(dataDir, 'library.json'));
    const legacy = old.filter(asset => !db.assets.some(current => current.id === asset.id)).map(asset => ({ ...asset, origin: 'legacy', kind: 'garment' }));
    return [...db.assets.filter(asset => !asset.archived), ...legacy];
  }

  function assetPath(url) {
    if (typeof url !== 'string') throw invalid('素材图片缺失。');
    const current = url.match(/^\/api\/studio\/files\/([a-f0-9-]+\.(?:png|jpeg|webp))$/i);
    if (current) return path.join(storeDir, current[1]);
    const legacy = url.match(/^\/api\/import\/library\/([\w.-]+\.png)$/i);
    if (legacy) return path.join(dataDir, 'imported', legacy[1]);
    throw invalid('不支持此素材图片路径。');
  }

  async function statePayload() {
    const queued = db.jobs.filter(job => job.status === 'queued').sort(compareQueued);
    const positions = new Map(queued.map((job, index) => [job.id, index + 1]));
    return {
      assets: await assets(),
      jobs: db.jobs.map(job => ({ ...job, ...(positions.has(job.id) ? { queuePosition: positions.get(job.id) } : {}) })),
      configured: Boolean(setting('OPENAI_API_KEY').trim()), settings: settingsResponse(),
      search: { visionConfigured: design.settings().configured, typesafeConfigured: typesafe.settings().configured },
      queue: { running: db.jobs.filter(job => job.status === 'processing').length, queued: queued.length, concurrency: concurrencyLimit() },
    };
  }

  function searchCandidate(asset) {
    return searchDocument(asset);
  }

  async function recognizeLabels(source, force) {
    const existing = currentSearchMetadata(source);
    if (existing.updatedAt && !force) return { asset: source, cached: true };
    if (recognizing.has(source.id)) return recognizing.get(source.id);
    if (recognizing.size >= 2) throw invalid('已有素材正在识别，请稍后重试。',429);
    const signature = JSON.stringify([source.image,source.part,source.searchMetadata]);
    const operation = (async () => {
      const metadata = await design.recognizeAsset(await readFile(assetPath(source.image)), CATEGORIES[source.part]);
      const current = (await assets()).find(asset => asset.id === source.id);
      if (!current || JSON.stringify([current.image,current.part,current.searchMetadata]) !== signature) throw invalid('素材或标签已修改，本次识别结果未覆盖新内容。',409);
      let target=db.assets.find(asset=>asset.id===source.id);
      if (!target) { target={...current}; db.assets.push(target); }
      const previous=target.searchMetadata;
      target.searchMetadata={...metadata,source:'ai',sourceImage:source.image,updatedAt:new Date().toISOString(),revision:randomUUID()};
      try { await save(); } catch(error) { target.searchMetadata=previous; throw error; }
      return {asset:target,cached:false};
    })();
    recognizing.set(source.id,operation);
    try { return await operation; } finally { recognizing.delete(source.id); }
  }

  function run(job) {
    if (job.status !== 'queued') return;
    pending.set(job.id, job);
    pump();
  }

  function pump() {
    for (const [id, job] of pending) if (job.status !== 'queued') pending.delete(id);
    while (running.size < concurrencyLimit()) {
      const job = [...pending.values()].filter(item => !running.has(item.id)).sort(compareQueued)[0];
      if (!job) break;
      pending.delete(job.id);
      // Reserve the slot before any asynchronous file or API work begins.
      running.add(job.id);
      void execute(job).catch(error => {
        console.error('[studio] Task persistence failed:', error.code || 'unknown');
      }).finally(() => {
        running.delete(job.id);
        pump();
      });
    }
  }

  async function execute(job) {
      try {
        const started = Date.now();
        // Keep each running request on one configuration even if settings change.
        const request = job.kind === 'design' ? (job.sketchProvider === 'quiver'
          ? { ...quiver.request(job.quiver), quality: normalizeQuality(job.quality, 'high') }
          : job.designProvider === 'openai'
            ? { key: setting('OPENAI_API_KEY'), baseUrl: setting('OPENAI_API_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''), model: setting('OPENAI_IMAGE_MODEL', 'gpt-image-2'), quality: normalizeQuality(job.quality, normalizeQuality(setting('OPENAI_IMAGE_QUALITY', 'high'))), protocol: 'openai' }
            : { ...designGeneration.request(), quality: normalizeQuality(job.quality, 'high') }) : {
          key: setting('OPENAI_API_KEY'), baseUrl: setting('OPENAI_API_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
          model: setting('OPENAI_IMAGE_MODEL', 'gpt-image-2'), quality: normalizeQuality(job.quality, normalizeQuality(setting('OPENAI_IMAGE_QUALITY', 'high'))),
        };
        const timeoutMs = job.kind === 'design' && job.sketchProvider === 'quiver' ? QUIVER_TIMEOUT_MS : requestTimeoutMs();
        Object.assign(job, { status: 'processing', error: null, failureKind: null, resultUncertain: false, requestId: null, httpStatus: null, startedAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(), requestTimeoutMs: timeoutMs, attemptCount: (job.attemptCount || 0) + 1 });
        job.providerModel = request.model;
        if (job.kind === 'design') job.providerProtocol = request.protocol;
        await save();
        const images = await Promise.all(job.references.map(async asset => ({ name: path.basename(assetPath(asset.image)), data: await readFile(assetPath(asset.image)) })));
        if (job.kind === 'design' && job.designGuide?.image) {
          images.push({ name: path.basename(assetPath(job.designGuide.image)), data: await readFile(assetPath(job.designGuide.image)) });
        }
        const outputFormat = normalizeOutputFormat(job.outputFormat);
        const count = normalizeCount(job.count);
        const moderation = normalizeModeration(job.moderation);
        const result = await (job.kind === 'design' ? job.sketchProvider === 'quiver' ? quiver.generate : job.designProvider === 'openai' ? editor : designGeneration.generate : editor)({
          ...request,
          size: job.size, aspectRatio: job.aspectRatio, resolution: job.resolution, vector: job.vector === true, images, prompt: job.prompt, count, outputFormat, moderation, ...(job.kind==='design' && job.sketchProvider !== 'quiver'?normalizeDesignNativeOptions(job,request.protocol):{}), timeoutMs: job.requestTimeoutMs, compressInput: job.compressInput === true,
        });
        const outputs = Array.isArray(result) ? result : [result];
        if (!outputs.length) throw new Error('图像服务没有返回图片。');
        job.requestId = outputs[0].requestId || null; job.httpStatus = outputs[0].httpStatus || 200; job.providerModel = outputs[0].modelUsed || request.model; job.elapsedMs = Date.now() - started;
        const stored = [];
        for (const bytes of outputs) {
          const providerMetadata = await sharp(bytes, { limitInputPixels: 60000000 }).metadata();
          const targetSize = job.kind === 'scene' && job.sourceWidth && job.sourceHeight
            ? { width: job.sourceWidth, height: job.sourceHeight }
            : null;
          const normalized = await encodeOutput(bytes, outputFormat, targetSize);
          const filename = `${randomUUID()}.${outputFormat}`; await writeFile(path.join(storeDir, filename), normalized.data);
          let vector;
          if (job.sketchProvider === 'quiver' && bytes.svg) {
            const svgFilename = `${randomUUID()}.svg`; await writeFile(path.join(storeDir, svgFilename), bytes.svg, 'utf8');
            vector = `/api/studio/files/${svgFilename}`;
          }
          stored.push({
            ...(vector ? { vector } : {}),
            image: `/api/studio/files/${filename}`,
            actualSize: `${normalized.info.width}x${normalized.info.height}`,
            providerActualSize: providerMetadata.width && providerMetadata.height ? `${providerMetadata.width}x${providerMetadata.height}` : null,
          });
        }
        job.count = count; job.outputFormat = outputFormat; job.moderation = moderation;
        job.images = stored.map(item => item.image); job.actualSizes = stored.map(item => item.actualSize);
        if (job.sketchProvider === 'quiver') { job.vectorImages = stored.map(item => item.vector); job.usage = outputs[0].usage; }
        job.providerActualSizes = stored.map(item => item.providerActualSize).filter(Boolean);
        job.image = job.images[0]; job.actualSize = job.actualSizes[0];
        const notices = [];
        const distinctSizes = [...new Set(job.actualSizes)];
        if (job.sketchProvider === 'quiver') {
          notices.push(`已保存原始 SVG；画板预览 ${distinctSizes.map(pixelLabel).join('、')}，SVG 可无损缩放。`);
        } else if (job.kind === 'scene' && job.sourceSize) {
          const providerSizes = [...new Set(job.providerActualSizes)];
          notices.push(`${providerSizes.length ? `接口返回 ${providerSizes.map(pixelLabel).join('、')}；` : ''}已按原图画幅保存为 ${pixelLabel(job.sourceSize)}。`);
        } else if (job.nativeSize||job.actualSizes.some(actualSize => actualSize !== job.size)) notices.push(`接口实际返回 ${distinctSizes.map(pixelLabel).join('、')}；已保留原始图片尺寸。`);
        if (outputs.length !== count) notices.push(`请求 ${count} 张，接口实际返回 ${outputs.length} 张。`);
        job.sizeNotice = notices.join(' ') || null; job.status = 'complete';
        if (job.kind === 'clean' || job.kind === 'scene') {
          const asset = db.assets.find(item => item.id === job.assetId);
          if (asset) { if (job.kind === 'scene') asset.sceneImage = job.image; else asset.cleanedImage = job.image; asset.image = job.image; }
        }
        if (job.kind === 'face') {
          const asset = db.assets.find(item => item.id === job.assetId);
          if (asset) { asset.faceImage = job.image; asset.image = job.image; }
        }
      } catch (error) {
        job.status = 'failed'; job.elapsedMs = job.startedAt ? Date.now() - Date.parse(job.startedAt) : null;
        job.requestId = error.requestId || job.requestId || null; job.httpStatus = error.status || null; job.providerCode = error.providerCode || null;
        const technical = [error.message, error.networkCode, error.networkMessage].filter(Boolean).join(' · ');
        job.technicalError = short(technical, 600);
        const message = String(error.message || '');
        const network = Boolean(error.networkCode) || /fetch failed|network|socket|econnreset|enotfound|etimedout|connect timeout|dns/i.test(`${message} ${error.networkMessage || ''}`);
        const upstreamTimeout = /timeout|timed out|abort/i.test(message); const quota = /quota|insufficient|billing|credit/i.test(message);
        const unavailable = error.status === 503 || /temporarily unavailable|service unavailable|no available channel/i.test(`${message} ${error.networkMessage || ''}`);
        job.failureKind = error.failureKind === 'input_too_large' || error.status === 413 ? 'input_too_large' : error.isLocalTimeout ? 'client_timeout' : quota ? 'quota' : upstreamTimeout ? 'provider_timeout' : unavailable ? 'provider_unavailable' : network ? 'network' : /saturat|overload|429/i.test(message) ? 'busy' : 'provider_error';
        job.resultUncertain = job.failureKind === 'client_timeout';
        job.error = job.failureKind === 'input_too_large' ? (error.inputLimitSource === 'local'
          ? `${error.message} 尚未发送到图像服务。可选择“压缩后重试”，素材原图保留。`
          : '接口明确拒绝了图片上传（HTTP 413：请求过大）。可选择“压缩后重试”，仅处理发送副本，素材原图保留。')
          : job.failureKind === 'client_timeout' ? `等待 ${Math.round(job.requestTimeoutMs / 60000)} 分钟仍未收到图片。服务商可能仍在处理并扣费，请先核对后台记录，再决定是否重试。`
          : job.failureKind === 'quota' ? '服务商返回额度不足，请检查余额后再试。'
            : job.failureKind === 'provider_timeout' ? '图像服务返回超时，请先查看服务商记录，再决定是否重试。'
                : job.failureKind === 'busy' ? '图像服务繁忙，请稍后手动重试。'
                : job.failureKind === 'provider_unavailable' ? `图像模型服务暂时不可用（HTTP ${job.httpStatus || 503}）。请稍后重试。${job.requestId ? `请求编号：${job.requestId}` : ''}`
                : job.failureKind === 'network' ? '无法连接图像服务，可能是网络、代理或服务商暂时不可用。请检查网络后手动重试。'
                : /Unknown parameter.*format/i.test(message) ? '当前图像模型不支持 format 参数，已按接口文档调整请求；请刷新页面后重试。'
                : /No available channel/i.test(message) ? '当前接口没有可用的图像模型通道，请检查服务商配置。' : `生成失败：${error.message}`;
      } finally {
        job.updatedAt = new Date().toISOString(); await save();
      }
  }

  function requireKey() { if (!setting('OPENAI_API_KEY').trim()) throw invalid('请先在系统设置中填写图像接口密钥。', 503); }

  async function cleanJob(asset) {
    requireKey(); if (!asset.originalImage) asset.originalImage = asset.image;
    const previous = db.jobs.find(job => job.kind === 'clean' && job.assetId === asset.id && ['queued', 'processing'].includes(job.status));
    if (previous) return previous;
    const job = {
      id: randomUUID(), kind: 'clean', name: `${asset.name} · ${materialParts.has(asset.part) ? `${CATEGORIES[asset.part]}整理` : asset.part === 'accessories_up' ? '配饰整理' : '单品整理'}`, assetId: asset.id,
      references: [{ ...asset, image: asset.originalImage || asset.image }], size: '1024x1024',
      quality: normalizeQuality(setting('OPENAI_IMAGE_QUALITY', 'high')), count: 1, outputFormat: 'png', moderation: 'auto', status: 'queued', createdAt: new Date().toISOString(),
      prompt: buildProductPrompt(asset),
    };
    markQueued(job); db.jobs.unshift(job); await save(); run(job); return job;
  }

  async function faceJob(asset) {
    requireKey(); if (!asset.originalImage) asset.originalImage = asset.image;
    const previous = db.jobs.find(job => job.kind === 'face' && job.assetId === asset.id && ['queued', 'processing'].includes(job.status));
    if (previous) return previous;
    const job = {
      id: randomUUID(), kind: 'face', name: `${asset.name} · 正脸参考`, assetId: asset.id,
      references: [{ ...asset, image: asset.originalImage || asset.image }], size: '1024x1024',
      quality: normalizeQuality(setting('OPENAI_IMAGE_QUALITY', 'high')), count: 1, outputFormat: 'png', moderation: 'auto', status: 'queued', createdAt: new Date().toISOString(),
      prompt: `Create a clean front-facing facial identity reference from the person in the input image. Preserve the exact facial identity, face shape, skin tone, eye shape, nose, mouth, eyebrows and hairstyle. Make the head face directly toward the camera with neutral expression, even soft light and a simple neutral background. Show head and upper shoulders only. Do not generate a full body, do not change age, gender, ethnicity or facial features, and do not add makeup, jewelry, clothing logos or text. This image is only a face and hair reference for later outfit generation. ${asset.notes || ''}`,
    };
    markQueued(job); db.jobs.unshift(job); await save(); run(job); return job;
  }

  async function sceneJob(asset) {
    requireKey(); if (!asset.originalImage) asset.originalImage = asset.image;
    const previous = db.jobs.find(job => job.kind === 'scene' && job.assetId === asset.id && ['queued', 'processing'].includes(job.status));
    if (previous) return previous;
    const rawMetadata = await sharp(await readFile(assetPath(asset.originalImage || asset.image)), { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    const metadata = rawMetadata.autoOrient || rawMetadata;
    const pendingScene = db.jobs.find(job => job.kind === 'scene' && job.assetId === asset.id && ['queued', 'processing'].includes(job.status));
    if (pendingScene) return pendingScene;
    if (!metadata.width || !metadata.height) throw invalid('无法读取场景原图尺寸。');
    const sourceRatio = metadata.width / metadata.height;
    const preset = OUTPUT_PRESETS.reduce((closest, candidate) => {
      const [width, height] = candidate.ratio.split(':').map(Number);
      const distance = Math.abs(Math.log(sourceRatio / (width / height)));
      return !closest || distance < closest.distance ? { preset: candidate, distance } : closest;
    }, null).preset;
    const job = { id: randomUUID(), kind: 'scene', name: `${asset.name} · 场景提取`, assetId: asset.id,
      references: [{ ...asset, image: asset.originalImage || asset.image }], size: preset.sizes['1K'], sourceWidth: metadata.width, sourceHeight: metadata.height, sourceSize: `${metadata.width}x${metadata.height}`,
      quality: normalizeQuality(setting('OPENAI_IMAGE_QUALITY', 'high')), count: 1, outputFormat: 'png', moderation: 'auto', status: 'queued', createdAt: new Date().toISOString(), prompt: buildScenePrompt(asset) };
    markQueued(job); db.jobs.unshift(job); await save(); run(job); return job;
  }

  async function testConnection(input) {
    const preview = normalizedSettings(input); const key = input.apiKey?.trim() || setting('OPENAI_API_KEY').trim();
    if (!key) throw invalid('请先填写 API Key。');
    const started = Date.now(); let response;
    try { response = await fetch(`${preview.OPENAI_API_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) }); }
    catch (error) { throw invalid(`无法连接图像服务：${error.name === 'TimeoutError' ? '连接超时' : error.message}`, 502); }
    const requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || null;
    if ([401, 403].includes(response.status)) throw invalid('API Key 未通过验证，请检查密钥和接口地址。', 401);
    if (!response.ok && ![404, 405].includes(response.status)) throw invalid(`服务返回 HTTP ${response.status}，请检查接口地址或服务商状态。`, 502);
    let catalog = {}; try { catalog = await response.json(); } catch { /* Optional catalog. */ }
    const modelIds = Array.isArray(catalog.data) ? catalog.data.map(item => item?.id).filter(Boolean) : [];
    const modelAvailable = modelIds.length ? modelIds.includes(preview.OPENAI_IMAGE_MODEL) : null;
    return {
      ok: true, status: response.status, elapsedMs: Date.now() - started, requestId, modelAvailable,
      message: modelAvailable === false ? `连接成功，但模型列表中未找到 ${preview.OPENAI_IMAGE_MODEL}。`
        : [404, 405].includes(response.status) ? '服务地址可访问，但不支持无费用模型列表检测。' : '连接成功，本次没有请求生成图片。',
    };
  }

  async function deleteJob(job) {
    db.jobs = db.jobs.filter(item => item.id !== job.id);
    const images = [...new Set([...(job.images || []), ...(job.vectorImages || []), job.image, ...(job.kind === 'design' ? [...(job.references || []).map(reference => reference.image), job.designGuide?.image] : [])].filter(Boolean))];
    for (const image of images) {
      const match = image.match(/^\/api\/studio\/files\/([a-f0-9-]+\.(?:png|jpeg|webp|svg))$/i);
      if (!match) continue;
      const usedByJob = db.jobs.some(item => item.image === image || item.images?.includes(image) || item.vectorImages?.includes(image) || item.designGuide?.image === image || item.references?.some(reference => reference.image === image));
      const usedByAsset = db.assets.some(asset => [asset.image, asset.originalImage, asset.cleanedImage, asset.sceneImage, asset.fullBodyImage, asset.faceImage].includes(image));
      if (!usedByJob && !usedByAsset) await unlink(path.join(storeDir, match[1])).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await save();
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/studio/')) return next();
    try {
      if (url.pathname === '/api/studio/health' && req.method === 'GET') return send(res, 200, { ok: true, app: 'fpa-local', version: 1 });
      const file = url.pathname.match(/^\/api\/studio\/files\/([a-f0-9-]+\.(png|jpeg|webp|svg))$/i);
      if (file && ['GET', 'HEAD'].includes(req.method)) {
        if (url.searchParams.get('w') === 'thumb' && await serveThumbnail(req, res, storeDir, file[1])) return;
        const filePath = path.join(storeDir, file[1]);
        const fileStat = await stat(filePath);
        const ext = file[2].toLowerCase();
        res.statusCode = 200;
        res.setHeader('Content-Type', ext === 'svg' ? 'image/svg+xml' : fileMimes[ext]);
        res.setHeader('Content-Length', fileStat.size);
        if (ext === 'svg') { res.setHeader('Content-Disposition', `attachment; filename="${file[1]}"`); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('X-Content-Type-Options', 'nosniff'); }
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') return res.end();
        createReadStream(filePath).pipe(res);
        return;
      }
      if (url.pathname === '/api/studio/state' && req.method === 'GET') return send(res, 200, await statePayload());
      if (url.pathname === '/api/studio/typesafe-settings') {
        if (req.method === 'GET') return send(res, 200, typesafe.settings());
        if (req.method === 'PATCH') return send(res, 200, await typesafe.updateSettings(await payload(req)));
      }
      if (url.pathname === '/api/studio/typesafe/search' && req.method === 'POST') {
        const input = await payload(req, 256 * 1024);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('检索请求格式不正确。');
        const query = short(input.query, 500);
        if (!query) return send(res, 200, { configured: Boolean(typesafe.settings().configured), used: false, rankedIds: [], probabilities: {}, confidence: null });
        const available = await assets();
        const requestedIds = Array.isArray(input.candidateIds) ? [...new Set(input.candidateIds.filter(value => typeof value === 'string'))] : available.map(asset => asset.id);
        const candidates = available.filter(asset => requestedIds.includes(asset.id)).map(searchCandidate);
        if (!typesafe.settings().configured) return send(res, 200, { configured: false, used: false, rankedIds: [], probabilities: {}, confidence: null });
        const result = await typesafe.search({ query, candidates });
        return send(res, 200, { configured: true, used: true, ...result });
      }
      const labelRoute=url.pathname.match(/^\/api\/studio\/assets\/([a-z0-9-]+)\/search-labels$/i);
      if (labelRoute && req.method === 'POST') {
        const input=await payload(req,4096);
        const source=(await assets()).find(asset=>asset.id===labelRoute[1]);
        if (!source) throw invalid('素材不存在。',404);
        return send(res,200,await recognizeLabels(source,input?.force===true));
      }
      if (url.pathname === '/api/studio/design/quiver-settings') {
        if (req.method === 'GET') return send(res, 200, quiver.settings());
        if (req.method === 'PATCH') return send(res, 200, await quiver.updateSettings(await payload(req)));
      }
      if (url.pathname === '/api/studio/design/quiver-settings/test' && req.method === 'POST') return send(res, 200, await quiver.test());
      if (url.pathname === '/api/studio/design/output-options' && req.method === 'GET') return send(res, 200, { presets: OUTPUT_PRESETS, resolutions: RESOLUTIONS, gemini:{presets:GEMINI_DESIGN_PRESETS,resolutions:GEMINI_DESIGN_RESOLUTIONS} });
      if (url.pathname === '/api/studio/design/settings' && req.method === 'GET') return send(res, 200, design.settings());
      if (url.pathname === '/api/studio/design/settings' && req.method === 'PATCH') return send(res, 200, await design.updateSettings(await payload(req)));
      if (['/api/studio/design/generation-settings', '/api/studio/design/generation/settings'].includes(url.pathname)) {
        if (req.method === 'GET') return send(res, 200, designGeneration.settings());
        if (req.method === 'PATCH') return send(res, 200, await designGeneration.updateSettings(await payload(req)));
      }
      if (url.pathname === '/api/studio/design/analyze' && req.method === 'POST') return send(res, 200, await design.analyze(await payload(req, MAX_DESIGN_JSON_BYTES)));
      if (url.pathname === '/api/studio/design/generate' && req.method === 'POST') {
        const input = await payload(req, MAX_DESIGN_JSON_BYTES);
        const useQuiver = input.sketchProvider === 'quiver';
        // New UI requests explicitly opt in to the shared GPT image endpoint.
        // Omitting the flag keeps old saved/API clients on the independent
        // design-generation configuration until they are resubmitted.
        const useSystemOpenAI = input.designMode === 'sketch_to_garment' && input.designProvider === 'openai';
        if (input.sketchProvider !== undefined && !['existing', 'quiver'].includes(input.sketchProvider)) throw invalid('线稿接口选择不正确。');
        if (useQuiver && input.designMode !== 'photo_to_sketch') throw invalid('Quiver 仅用于转为矢量线稿。');
        if (useQuiver) quiver.requireConfigured(); else if (useSystemOpenAI) requireKey(); else designGeneration.requireConfigured();
        const selectedQuiver = useQuiver ? quiverOptions({ ...quiver.settings(), ...input.quiver }) : null;
        const protocol=useQuiver || useSystemOpenAI ? 'openai' : designGeneration.settings().protocol;
        let output; try { output = useQuiver ? { size: 'auto', nativeSize: true, vector: true } : useSystemOpenAI ? { ...resolveOutputSettings(input), nativeSize: false, vector: false } : resolveDesignOutput(input,protocol); } catch (error) { throw invalid(error.message); }
        const nativeOptions=useQuiver || useSystemOpenAI ? {} : normalizeDesignNativeOptions(input,protocol);
        const quality = normalizeQuality(input.quality, normalizeQuality(setting('OPENAI_IMAGE_QUALITY', 'high')));
        const count = normalizeCount(input.count), outputFormat = useQuiver ? 'png' : normalizeOutputFormat(input.outputFormat), moderation = normalizeModeration(input.moderation);
        designGeneration.validateCount(count);
        const designInput = await normalizeDesignInput(input);
        if (designInput.sourceJobId) {
          const source = db.jobs.find(item => item.id === designInput.sourceJobId);
          if (!source || source.kind !== 'design' || source.designMode !== 'photo_to_sketch' || source.status !== 'complete' || !(source.image || source.images?.length)) {
            throw invalid('来源线稿任务不存在或尚未成功完成，请重新选择已生成的线稿。');
          }
        }
        const guide = await buildDesignGuide(designInput.references);
        const prompt = buildDesignPrompt(designInput, output, guide);
        const references = [], written = [];
        let job, designGuide;
        try {
          for (const reference of designInput.references) {
            const id = randomUUID(), filename = `${id}.${reference.metadata.format}`, image = `/api/studio/files/${filename}`;
            await writeFile(path.join(storeDir, filename), reference.bytes); written.push(filename);
            const dimensions = reference.metadata.autoOrient || reference.metadata;
            references.push({ id, sourceReferenceId: reference.id, name: reference.name, part: 'design', kind: 'reference', role: reference.role, regions: reference.regions,
              ...(reference.targetRegion !== undefined ? { targetRegion: reference.targetRegion } : {}),
              ...(reference.role === '辅料参考' ? { placement: reference.placement, note: reference.note } : {}),
              image, originalImage: image, originalBytes: reference.bytes.length, originalMime: reference.mime,
              originalWidth: dimensions.width, originalHeight: dimensions.height, originalSha256: createHash('sha256').update(reference.bytes).digest('hex') });
          }
          if (guide) {
            const filename = `${randomUUID()}.png`;
            await writeFile(path.join(storeDir, filename), guide.bytes); written.push(filename);
            designGuide = { version: guide.version, image: `/api/studio/files/${filename}`, mime: 'image/png', bytes: guide.bytes.length,
              width: guide.width, height: guide.height, sha256: createHash('sha256').update(guide.bytes).digest('hex'),
              requestImageIndex: guide.requestImageIndex, panels: guide.panels };
          }
          job = { id: randomUUID(), kind: 'design', name: designInput.name, references, ...output, ...nativeOptions, quality, count, outputFormat, moderation,
            ...(useQuiver ? { sketchProvider: 'quiver', quiver: selectedQuiver } : useSystemOpenAI ? { designProvider: 'openai' } : {}),
            designMode: designInput.designMode, ...(designInput.sourceJobId ? { sourceJobId: designInput.sourceJobId } : {}),
            ...(designGuide ? { designGuide } : {}), ...(designInput.style ? { designStyle: designInput.style } : {}), designPrompt: designInput.prompt, status: 'queued', createdAt: new Date().toISOString(), prompt };
          markQueued(job); db.jobs.unshift(job); await save();
        } catch (error) {
          if (job) db.jobs = db.jobs.filter(item => item.id !== job.id);
          await Promise.all(written.map(filename => unlink(path.join(storeDir, filename)).catch(() => {})));
          throw error;
        }
        run(job); return send(res, 202, job);
      }
      if (url.pathname === '/api/studio/settings' && req.method === 'PATCH') {
        localSettings = normalizedSettings(await payload(req)); await saveSettings(); pump(); return send(res, 200, settingsResponse());
      }
      if (url.pathname === '/api/studio/settings/test' && req.method === 'POST') return send(res, 200, await testConnection(await payload(req)));
      if (url.pathname === '/api/studio/assets' && req.method === 'POST') {
        const input = await payload(req);
        if (!Object.hasOwn(CATEGORIES, input.part)) throw invalid('请选择素材分类。');
        if (input.mode === 'fullbody') throw invalid('人物全身照生成功能已移除，请直接上传人物体型图片。', 410);
        if (input.mode && !['original', 'clean', 'scene', 'face'].includes(input.mode)) throw invalid('上传方式无效。');
        if (input.mode === 'clean') { if (!cleanableParts.has(input.part)) throw invalid('只有服装、配饰、面料或辅料可生成整理图。'); requireKey(); }
        if (input.mode === 'scene') { if (input.part !== 'scene') throw invalid('只有场景素材可以生成纯场景图。'); requireKey(); }
        if (input.mode === 'face') { if (input.part !== 'face') throw invalid('只有人物人脸可以生成正脸参考图。'); requireKey(); }
        const match = typeof input.imageDataUrl === 'string' && input.imageDataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
        if (!match) throw invalid('请上传 PNG、JPG 或 WebP 图片。');
        const bytes = Buffer.from(match[1], 'base64'); if (bytes.length > MAX_IMAGE_BYTES) throw invalid('单张原图不能超过 50MB。', 413);
        let metadata;
        try {
          const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
          metadata = await image.metadata();
          if (!Object.hasOwn(fileMimes, metadata.format)) throw new Error('Unsupported image format');
          if ((metadata.pages || 1) > 1) throw invalid('请上传静态 PNG、JPG 或 WebP 图片。');
          const limitMessage = imageLimitMessage({ bytes: bytes.length, width: metadata.width, height: metadata.height });
          if (limitMessage) throw invalid(limitMessage, 413);
          await image.stats(); // Validate the full image without re-encoding the uploaded file.
        }
        catch (error) { if (error.status) throw error; throw invalid('图片无法读取，或像素超过 6710 万。'); }
        const id = randomUUID(), filename = `${id}.${metadata.format}`, image = `/api/studio/files/${filename}`;
        await writeFile(path.join(storeDir, filename), bytes);
        const displaySize = metadata.autoOrient || metadata;
        const asset = { id, name: short(input.name) || CATEGORIES[input.part], part: input.part, kind: garmentParts.has(input.part) ? 'garment' : 'reference', notes: short(input.notes, 1000), image, originalImage: image, originalBytes: bytes.length, originalMime: fileMimes[metadata.format], originalWidth: displaySize.width, originalHeight: displaySize.height, originalSha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() };
        db.assets.unshift(asset); await save();
        if (input.mode === 'clean') await cleanJob(asset);
        if (input.mode === 'scene') await sceneJob(asset);
        if (input.mode === 'face') await faceJob(asset);
        return send(res, 201, asset);
      }
      const assetRoute = url.pathname.match(/^\/api\/studio\/assets\/([a-z0-9-]+)(?:\/(clean|scene|face|fullbody))?$/i);
      if (assetRoute) {
        if (assetRoute[2] === 'fullbody') throw invalid('人物全身照生成功能已移除，请直接上传人物体型图片。', 410);
        const source = (await assets()).find(asset => asset.id === assetRoute[1]); if (!source) throw invalid('素材不存在。', 404);
        let asset = db.assets.find(item => item.id === source.id); if (!asset) { asset = { ...source }; db.assets.push(asset); }
        if (req.method === 'PATCH' && !assetRoute[2]) {
          const input = await payload(req); if (!Object.hasOwn(CATEGORIES, input.part)) throw invalid('分类无效。');
          const metadata=input.searchMetadata === undefined ? undefined : normalizeSearchMetadata(input.searchMetadata);
          if (metadata && (input.searchMetadata.revision || null) !== (asset.searchMetadata?.revision || null)) throw invalid('标签已在其他操作中更新，请重新打开素材后修改。',409);
          asset.name = short(input.name) || asset.name; asset.part = input.part; asset.notes = short(input.notes, 1000);
          if (input.imageVersion === 'original' && asset.originalImage) asset.image = asset.originalImage;
          if (input.imageVersion === 'cleaned' && asset.cleanedImage) asset.image = asset.cleanedImage;
          if (input.imageVersion === 'scene' && asset.sceneImage && asset.part === 'scene') asset.image = asset.sceneImage;
          if (input.imageVersion === 'face' && asset.faceImage && asset.part === 'face') asset.image = asset.faceImage;
          if (input.imageVersion === 'fullbody' && asset.fullBodyImage && peopleParts.has(asset.part)) asset.image = asset.fullBodyImage;
          if (metadata) asset.searchMetadata={...metadata,source:'manual',sourceImage:asset.image,updatedAt:new Date().toISOString(),revision:randomUUID()};
          asset.kind = garmentParts.has(asset.part) ? 'garment' : 'reference'; await save(); return send(res, 200, asset);
        }
        if (req.method === 'POST' && assetRoute[2] === 'clean') { if (!cleanableParts.has(asset.part)) throw invalid('只有服装、配饰、面料或辅料可生成整理图。'); return send(res, 202, await cleanJob(asset)); }
        if (req.method === 'POST' && assetRoute[2] === 'scene') { if (asset.part !== 'scene') throw invalid('只有场景素材可以生成场景图。'); return send(res, 202, await sceneJob(asset)); }
        if (req.method === 'POST' && assetRoute[2] === 'face') { if (asset.part !== 'face') throw invalid('只有人物人脸可以生成正脸参考图。'); return send(res, 202, await faceJob(asset)); }
        if (req.method === 'DELETE') { asset.archived = true; await save(); return send(res, 200, { archived: true }); }
      }
      if (url.pathname === '/api/studio/outfits' && req.method === 'POST') {
        requireKey(); const input = await payload(req);
        if (!Array.isArray(input.assetIds) || !input.assetIds.length || input.assetIds.length > 10 || new Set(input.assetIds).size !== input.assetIds.length) throw invalid('请选择 1–10 个不重复的素材。');
        const available = await assets(); const refs = input.assetIds.map(id => available.find(asset => asset.id === id));
        if (refs.some(asset => !asset)) throw invalid('部分素材已移除，请重新选择。');
        if (refs.some(asset => materialParts.has(asset.part))) throw invalid('面料和辅料仅供设计参考，不能作为穿搭素材，请移除后再生成。');
        if (!refs.some(asset => garmentParts.has(asset.part) && !['accessories_up', 'shoes'].includes(asset.part))) throw invalid('至少选择一件上衣、外套、下装或内搭。');
        for (const part of Object.keys(CATEGORIES).filter(part => !['accessories_up'].includes(part))) if (refs.filter(asset => asset.part === part).length > 1) throw invalid(`${CATEGORIES[part]}只能选择一个。`);
        if (refs.filter(asset => sceneParts.has(asset.part)).length > 1) throw invalid('场景只能选择一个。');
        let output; try { output = resolveOutputSettings(input); } catch (error) { throw invalid(error.message); }
        const parameters = { scene: short(input.scene, 1000), direction: short(input.direction, 1500), poseText: short(input.poseText, 500) };
        const job = { id: randomUUID(), kind: 'outfit', name: short(input.name) || '我的搭配', references: structuredClone(refs), ...output, ...parameters, quality: normalizeQuality(input.quality, normalizeQuality(setting('OPENAI_IMAGE_QUALITY', 'high'))), count: normalizeCount(input.count), outputFormat: normalizeOutputFormat(input.outputFormat), moderation: normalizeModeration(input.moderation), status: 'queued', createdAt: new Date().toISOString(), prompt: buildOutfitPrompt(refs, parameters) };
        markQueued(job); db.jobs.unshift(job); await save(); run(job); return send(res, 202, job);
      }
      const cancel = url.pathname.match(/^\/api\/studio\/jobs\/([a-f0-9-]+)\/cancel$/i);
      if (cancel && req.method === 'POST') {
        const job = db.jobs.find(item => item.id === cancel[1]); if (!job) throw invalid('任务不存在。', 404);
        if (job.status === 'processing') throw invalid('任务已发送到图像服务，取消本地等待不一定能阻止扣费。', 409);
        if (job.status !== 'queued') throw invalid('只能取消尚未开始的排队任务。', 409);
        job.status = 'cancelled'; pending.delete(job.id); job.error = '已在发送到图像服务前取消。'; job.updatedAt = new Date().toISOString(); await save(); pump(); return send(res, 200, job);
      }
      const archive = url.pathname.match(/^\/api\/studio\/jobs\/([a-f0-9-]+)\/archive$/i);
      if (archive && req.method === 'PATCH') {
        const job = db.jobs.find(item => item.id === archive[1]); if (!job) throw invalid('任务不存在。', 404);
        if (['queued', 'processing'].includes(job.status)) throw invalid('未完成任务不能归档。', 409);
        job.archived = Boolean((await payload(req)).archived); job.updatedAt = new Date().toISOString(); await save(); return send(res, 200, job);
      }
      const jobRoute = url.pathname.match(/^\/api\/studio\/jobs\/([a-f0-9-]+)$/i);
      if (jobRoute && req.method === 'DELETE') {
        const job = db.jobs.find(item => item.id === jobRoute[1]); if (!job) throw invalid('任务不存在。', 404);
        if (['queued', 'processing'].includes(job.status)) throw invalid('请先等待任务完成，或取消排队任务。', 409);
        await deleteJob(job); return send(res, 200, { deleted: true });
      }
      const retry = url.pathname.match(/^\/api\/studio\/jobs\/([a-f0-9-]+)\/retry$/i);
      if (retry && req.method === 'POST') {
        const job = db.jobs.find(item => item.id === retry[1]); if (!job) throw invalid('任务不存在。', 404);
        if (job.kind === 'design') { if (job.sketchProvider === 'quiver') quiver.requireConfigured(); else if (job.designProvider === 'openai') requireKey(); else designGeneration.requireConfigured(); designGeneration.validateCount(normalizeCount(job.count)); }
        else requireKey();
        if (job.kind === 'fullbody') throw invalid('人物全身照生成功能已移除，旧记录仅供查看。', 410);
        if (job.status !== 'failed') throw invalid('仅失败的任务可以重试。', 409);
        const input = await payload(req);
        if (job.status !== 'failed') throw invalid('仅失败的任务可以重试。', 409);
        if (job.assetId && db.jobs.some(item => item.id !== job.id && item.assetId === job.assetId && item.kind === job.kind && ['queued', 'processing'].includes(item.status))) throw invalid('该素材已有相同的生成任务，请等待完成。', 409);
        if (input.compressInput === true && job.failureKind !== 'input_too_large') throw invalid('仅在明确提示图片超限后，才可压缩重试。');
        if (job.kind === 'design') { if (job.sketchProvider !== 'quiver') { const protocol=job.designProvider === 'openai' ? 'openai' : designGeneration.settings().protocol; Object.assign(job, job.designProvider === 'openai' ? { ...resolveOutputSettings(job), nativeSize: false, vector: false } : resolveDesignOutput(job,protocol), job.designProvider === 'openai' ? {} : normalizeDesignNativeOptions(job,protocol)); } }
        else if (job.kind === 'outfit') Object.assign(job, resolveOutputSettings(job));
        Object.assign(job, { status: 'queued', error: null, failureKind: null, resultUncertain: false, archived: false, compressInput: input.compressInput === true });
        markQueued(job); await save(); run(job); return send(res, 202, job);
      }
      return send(res, 404, { error: '未找到该操作。' });
    } catch (error) {
      return send(res, error.code === 'ENOENT' ? 404 : error.status || 500, { error: error.status ? error.message : error.code === 'ENOENT' ? '图片文件不存在。' : '操作失败，请稍后重试。' });
    }
  }

  return {
    name: 'wardrobe-studio-api', apply: 'serve',
    async configResolved(config) {
      root = config.root; dataDir = path.resolve(root, setting('WARDROBE_DATA_DIR', 'data')); storeDir = path.join(dataDir, 'studio');
      dbPath = path.join(storeDir, 'studio.json'); settingsPath = path.join(storeDir, 'settings.json'); await mkdir(storeDir, { recursive: true });
      await design.init(storeDir);
      await designGeneration.init(storeDir);
      await quiver.init(storeDir);
      await typesafe.init(storeDir);
      db = await readJson(dbPath, db); localSettings = await readJson(settingsPath, {}); const queued = [];
      queueSequence = db.jobs.reduce((max, job) => Math.max(max, Number.isSafeInteger(job.queueSequence) ? job.queueSequence : 0), 0);

      // Older builds sent scene references through the clothing-cleanup path and
      // persisted them as `kind: clean`. Migrate those records in place so the
      // history label, scene dimensions and asset version selector stay correct
      // after an upgrade. This only changes local metadata; it never re-sends a
      // completed request to the image service.
      let migratedSceneRecords = false;
      for (const job of db.jobs) {
        const linkedAsset = job.assetId ? db.assets.find(asset => asset.id === job.assetId) : null;
        const sceneReference = (Array.isArray(job.references) ? job.references : []).find(reference => reference.part === 'scene');
        if (job.kind !== 'clean' || (!sceneReference && linkedAsset?.part !== 'scene')) continue;

        job.kind = 'scene';
        job.name = String(job.name || linkedAsset?.name || '场景').replace(/\s*[·•]\s*单品整理\s*$/, ' · 场景提取');
        if (!/场景提取$/.test(job.name)) job.name = `${job.name} · 场景提取`;

        const sourceImage = sceneReference?.originalImage || sceneReference?.image || linkedAsset?.originalImage;
        if (!job.sourceSize && sourceImage) {
          try {
            const metadata = await sharp(await readFile(assetPath(sourceImage)), { limitInputPixels: 60000000 }).metadata();
            if (metadata.width && metadata.height) {
              job.sourceWidth = metadata.width;
              job.sourceHeight = metadata.height;
              job.sourceSize = `${metadata.width}x${metadata.height}`;
            }
          } catch { /* Keep old records readable even if their source was archived. */ }
        }
        if (linkedAsset) {
          const generatedScene = linkedAsset.sceneImage || linkedAsset.cleanedImage;
          if (generatedScene && !linkedAsset.sceneImage) linkedAsset.sceneImage = generatedScene;
          if (linkedAsset.sceneImage && linkedAsset.image !== linkedAsset.sceneImage) linkedAsset.image = linkedAsset.sceneImage;
        }
        migratedSceneRecords = true;
      }
      for (const job of db.jobs) {
        if (job.status === 'processing') {
          job.status = 'failed'; job.failureKind = 'interrupted'; job.resultUncertain = true; job.updatedAt = new Date().toISOString();
          job.error = '服务重启时该任务正在生成，原请求可能已扣费。请先核对服务商后台，再决定是否重试。';
        } else if (job.status === 'queued') queued.push(job);
      }
      if (migratedSceneRecords) db.version = Math.max(Number(db.version) || 0, 3);
      for (const job of queued.sort(compareQueued)) {
        if (!Number.isSafeInteger(job.queueSequence)) job.queueSequence = ++queueSequence;
        job.queuedAt ||= job.createdAt;
      }
      await save();
      for (const job of queued.sort(compareQueued)) pending.set(job.id, job);
      pump();
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
