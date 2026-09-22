import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { recognizeAsset } from './asset-labels.mjs';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_TASK_IMAGE_BYTES, imageLimitMessage } from '../src/image-limits.mjs';

export const MAX_DESIGN_JSON_BYTES = Math.ceil(MAX_TASK_IMAGE_BYTES * 4 / 3) + 1024 * 1024;
export const MAX_DESIGN_REFERENCES = 10;
export const MAX_DESIGN_REQUEST_IMAGES = MAX_DESIGN_REFERENCES + 1;
export const DEFAULT_DESIGN_IMPORT_PATH = 'E:\\新建文件夹 (6)\\新建文件夹\\新建文件夹\\easyConfig.json';
const short = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const mimes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const garmentRoles = new Set(['主体款式参考', '局部细节参考']);
const styleRoles = new Set(['面料参考', '配色参考']);
const roles = new Set([...garmentRoles, ...styleRoles, '辅料参考']);
const designModes = new Set(['redesign', 'photo_to_sketch', 'sketch_to_garment']);
const parts = new Set(['领型', '帽型', '肩部', '袖型', '袖口', '门襟', '胸袋', '下袋', '分割线', '下摆', '面料质感', '装饰结构', '图案', '其他结构']);
const modeLabels = { retain: '严格保留结构', adapt: '借鉴并调整', mood: '仅参考视觉语言' };
const inheritLabels = { retain: '保留', adapt: '转译到目标设计', ignore: '忽略' };

function normalizeBaseUrl(value) {
  const clean = short(value, 1000).replace(/\/+$/, '');
  let url;
  try { url = new URL(clean); } catch { throw invalid('视觉接口地址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('视觉接口地址须为不含密钥、查询参数的 http 或 https 地址。');
  return clean;
}

export function normalizeDesignBox(value) {
  if (!value || typeof value !== 'object') throw invalid('框选区域格式不正确。');
  const box = Object.fromEntries(['x', 'y', 'w', 'h'].map(key => [key, value[key]]));
  if (Object.values(box).some(number => typeof number !== 'number' || !Number.isFinite(number))
    || box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 || box.x + box.w > 1.000001 || box.y + box.h > 1.000001) {
    throw invalid('框选区域必须位于图片内，使用 0–1 的归一化坐标。');
  }
  box.w = Math.min(box.w, 1 - box.x); box.h = Math.min(box.h, 1 - box.y);
  return box;
}

function normalizeRegion(value) {
  const box = normalizeDesignBox(value);
  const mode = value.mode ?? 'adapt', priority = value.priority ?? 'medium';
  const color = value.color ?? 'adapt', fabric = value.fabric ?? 'adapt';
  if (!Object.hasOwn(modeLabels, mode) || !['low', 'medium', 'high'].includes(priority)
    || !Object.hasOwn(inheritLabels, color) || !Object.hasOwn(inheritLabels, fabric)) throw invalid('框选区域的作用方式或继承设置不正确。');
  return { ...box, part: short(value.part, 80) || '其他结构', placement: short(value.placement, 160), note: short(value.note, 2000), mode, priority, color, fabric, ...(value.localStyle !== undefined ? { localStyle: normalizeLocalStyle(value.localStyle) } : {}) };
}

function normalizeLocalStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('局部材料设置格式不正确。');
  const result = {};
  for (const kind of ['fabric', 'color']) {
    const item = value[kind] ?? { mode: 'inherit' }, modes = kind === 'fabric' ? ['inherit', 'image', 'text'] : ['inherit', 'auto', 'image', 'text', 'custom'];
    if (!item || typeof item !== 'object' || Array.isArray(item) || !modes.includes(item.mode)) throw invalid('局部面料或配色来源不正确。');
    if (['inherit', 'auto'].includes(item.mode)) { result[kind] = { mode: item.mode }; continue; }
    const text = designText(item.text, '局部材料说明');
    if (item.mode === 'text' && !text) throw invalid('请填写局部材料说明。');
    if (item.mode === 'custom' && (typeof item.hex !== 'string' || !/^#[a-f\d]{6}$/i.test(item.hex))) throw invalid('局部颜色请使用完整 HEX 色值。');
    result[kind] = { mode: item.mode, ...(text ? { text } : {}), ...(item.mode === 'custom' ? { hex: item.hex } : {}) };
  }
  return result;
}

export async function validateDesignImage(dataUrl) {
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw invalid('设计参考图请上传 PNG、JPG 或 WebP 原图。');
  const base64 = match[2].replace(/[\r\n]/g, '');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) throw invalid('参考图片数据不完整。');
  if (bytes.length > MAX_IMAGE_BYTES) throw invalid('单张原图不能超过 50MB。', 413);
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
    const metadata = await image.metadata();
    if (!Object.hasOwn(mimes, metadata.format) || mimes[metadata.format] !== match[1]) throw invalid('参考图片格式与文件内容不一致。');
    if ((metadata.pages || 1) > 1) throw invalid('请上传静态 PNG、JPG 或 WebP 图片。');
    const limit = imageLimitMessage({ bytes: bytes.length, width: metadata.width, height: metadata.height });
    if (limit) throw invalid(limit, 413);
    await image.stats();
    return { bytes, metadata, mime: mimes[metadata.format] };
  } catch (error) {
    if (error.status) throw error;
    throw invalid('参考图片无法读取，或像素超过 6710 万。');
  }
}

export async function normalizeDesignInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('设计请求格式不正确。');
  const designMode = input.designMode === undefined ? 'redesign' : input.designMode;
  if (!designModes.has(designMode)) throw invalid('设计工作台模式不正确。');
  const prompt = designText(input.prompt, '设计提示词', 64000);
  if (!prompt) throw invalid('请先生成或填写设计提示词。');
  if (!Array.isArray(input.references) || !input.references.length || input.references.length > MAX_DESIGN_REFERENCES) throw invalid('请选择 1–10 张设计参考图。');
  if (input.references.some(reference => !reference || !roles.has(reference.role))) throw invalid('请指定每张参考图的用途。');
  if (input.references.filter(reference => reference.role === '主体款式参考').length !== 1) throw invalid('请设置一张主体款式参考图。');
  if (designMode === 'photo_to_sketch' && (input.references.length !== 1 || input.style !== undefined)) throw invalid('款式转线稿只使用一张主体款式图，不使用面料、配色或辅料设置。');
  if (designMode !== 'sketch_to_garment' && input.references.some(reference => reference.role === '辅料参考')) throw invalid('辅料参考仅用于线稿成衣。');
  if (designMode === 'sketch_to_garment' && input.references.some(reference => reference.role === '局部细节参考')) throw invalid('线稿成衣的服装结构只来自主体线稿，请移除局部细节参考。');
  const sourceJobId = designText(input.sourceJobId, '来源线稿任务编号', 100);
  if (input.sourceJobId !== undefined && (!sourceJobId || !/^[a-z0-9-]+$/i.test(sourceJobId) || designMode !== 'sketch_to_garment')) throw invalid('来源线稿任务编号不正确，或当前模式不支持来源任务。');
  const style = normalizeDesignStyle(input.style, input.references, designMode);
  // Validate all instructions before decoding images, and all images before the
  // caller stores files or queues a potentially billable generation request.
  const references = input.references.map((reference, index) => {
    if (reference.regions !== undefined && (!Array.isArray(reference.regions) || reference.regions.length > 32)) throw invalid('每张参考图最多保留 32 个框选区域。');
    if (!garmentRoles.has(reference.role) && reference.regions?.length) throw invalid('面料、配色和辅料参考图不使用服装局部框选。');
    const accessory = reference.role === '辅料参考';
    const placement = accessory ? designText(reference.placement, '辅料应用部位', 160) : '';
    const note = accessory ? designText(reference.note, '辅料说明', 2000) : '';
    if (accessory && !placement) throw invalid('请填写每张辅料参考的应用部位。');
    const targetRegion = reference.targetRegion;
    if (targetRegion !== undefined && (designMode !== 'sketch_to_garment' || garmentRoles.has(reference.role) || !Number.isInteger(targetRegion) || targetRegion < 1 || targetRegion > (input.references.find(item => item.role === '主体款式参考').regions?.length || 0))) throw invalid('局部材料必须关联有效的主体标注编号。');
    return { id: short(reference.id, 100) || `reference-${index + 1}`, name: short(reference.name) || `参考图 ${index + 1}`, role: reference.role, regions: (reference.regions || []).map(normalizeRegion), ...(accessory ? { placement, note } : {}), ...(targetRegion !== undefined ? { targetRegion } : {}) };
  });
  const primary = references.find(reference => reference.role === '主体款式参考');
  for (const [index, region] of primary.regions.entries()) {
    if (region.localStyle && designMode !== 'sketch_to_garment') throw invalid('局部材料设置仅用于成衣生成。');
    const local = region.localStyle || { fabric: { mode: 'inherit' }, color: { mode: 'inherit' } };
    for (const [kind, role] of [['fabric', '面料参考'], ['color', '配色参考']]) {
      const images = references.filter(reference => reference.targetRegion === index + 1 && reference.role === role);
      if (images.length > 1 || (local[kind].mode === 'image') !== (images.length === 1)) throw invalid(`标注 ${index + 1} 的材料图片与来源设置不一致。`);
    }
    if (local.color.mode === 'auto' && local.fabric.mode !== 'image' && !(local.fabric.mode === 'inherit' && style?.fabric.mode === 'image')) throw invalid(`标注 ${index + 1} 没有可跟随颜色的面料图片。`);
  }
  if (new Set(references.map(reference => reference.id)).size !== references.length) throw invalid('参考图编号重复，请重新添加参考图。');
  let total = 0;
  for (let index = 0; index < references.length; index++) {
    const image = await validateDesignImage(input.references[index].imageDataUrl);
    total += image.bytes.length;
    if (total > MAX_TASK_IMAGE_BYTES) throw invalid('本次参考图片超过本地 128MB 总量上限。', 413);
    Object.assign(references[index], image);
  }
  return { name: short(input.name) || '我的设计', prompt, references, designMode, ...(sourceJobId ? { sourceJobId } : {}), ...(style ? { style } : {}) };
}

function designText(value, label, max = 2000) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw invalid(`${label}须为文字。`);
  const text = value.trim();
  if (text.length > max) throw invalid(`${label}不能超过 ${max} 字。`);
  return text;
}

export function normalizeDesignStyle(input, references, designMode = 'redesign') {
  const sketch = designMode === 'sketch_to_garment';
  const fabrics = references.filter(reference => reference.role === '面料参考' && reference.targetRegion === undefined);
  const colors = references.filter(reference => reference.role === '配色参考' && reference.targetRegion === undefined);
  if (fabrics.length > 1 || colors.length > 1) throw invalid('面料参考和配色参考各只能上传一张。');
  let passedStyle = false, passedAccessory = false;
  for (const reference of references) {
    if (reference.role === '辅料参考') { passedAccessory = true; continue; }
    if (passedAccessory) throw invalid('请将辅料参考放在主体线稿、面料和配色参考图之后。');
    if (styleRoles.has(reference.role)) passedStyle = true;
    else if (passedStyle) throw invalid('请将面料和配色参考放在服装参考图之后。');
  }
  if (input === undefined) {
    // A sketch-to-garment request may intentionally omit material controls.
    // In that case the source sketch is the material and colour reference;
    // explicit uploads still require an explicit matching mode.
    if (sketch && !fabrics.length && !colors.length) return { fabric: { mode: 'primary' }, color: { mode: 'auto' } };
    if (fabrics.length || colors.length) throw invalid('请先选择对应的面料或配色来源。');
    return undefined;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('面料与配色设置格式不正确。');
  const styleVersion = input.version === 2 ? 2 : undefined;
  function source(value, label, modes, defaultMode = 'primary') {
    if (value === undefined) return { mode: defaultMode };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label}来源格式不正确。`);
    const mode = value.mode ?? defaultMode;
    if (!modes.includes(mode)) throw invalid(`${label}来源不正确。`);
    // Hidden controls must never influence a request after switching modes.
    if (mode === 'primary' || mode === 'auto') return { mode };
    const text = designText(value.text, `${label}说明`);
    if (mode === 'text' && !text) throw invalid(`请填写${label}说明。`);
    if (mode === 'custom') {
      if (typeof value.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.hex)) throw invalid('自定义颜色请使用完整的 #RRGGBB 色值。');
      return { mode, hex: value.hex, ...(text ? { text } : {}) };
    }
    return { mode, ...(text ? { text } : {}) };
  }
  // 未选择材料时允许直接生成，默认沿用主体线稿中的可见材质与颜色。
  // 用户主动上传/填写后才覆盖对应属性。
  const fabric = source(input.fabric, '面料', sketch ? ['primary', 'image', 'text'] : ['primary', 'image', 'text'], 'primary');
  // Version 2 clients opt into automatic colour priority. Older records keep
  // their historical primary-colour default when the field was omitted.
  const color = source(input.color, '配色', sketch ? ['auto', 'image', 'custom', 'text'] : ['auto', 'primary', 'image', 'custom', 'text'], sketch || styleVersion === 2 ? 'auto' : 'primary');
  if (sketch && color.mode === 'auto' && fabric.mode === 'text') throw invalid('文字面料没有可跟随的原色，请选择色卡、自定义颜色或文字配色。');
  if ((fabric.mode === 'image') !== (fabrics.length === 1)) throw invalid(fabric.mode === 'image' ? '请上传一张面料参考图。' : '当前面料来源不使用参考图，请移除未启用的面料图片。');
  if ((color.mode === 'image') !== (colors.length === 1)) throw invalid(color.mode === 'image' ? '请上传一张配色参考图。' : '当前配色来源不使用参考图，请移除未启用的配色图片。');
  return { ...(styleVersion ? { version: styleVersion } : {}), fabric, color, colorRatio: designText(input.colorRatio, '配色比例', 1000), hardware: designText(input.hardware, '五金说明', 1000) };
}

function buildDesignStylePrompt(style, references) {
  if (!style) return '';
  const primary = references.findIndex(reference => reference.role === '主体款式参考') + 1;
  const fabricImage = references.findIndex(reference => reference.role === '面料参考') + 1;
  const colorImage = references.findIndex(reference => reference.role === '配色参考') + 1;
  const useFabricColor = style.color.mode === 'auto' && style.fabric.mode === 'image';
  const fabric = style.fabric.mode === 'primary' ? `采用 Image ${primary} 主体款式参考的原面料。`
    : style.fabric.mode === 'image' ? `面料仅取自 Image ${fabricImage} 面料参考的${useFabricColor ? '实际颜色、' : ''}纹理、织法、光泽、厚薄、垂感以及其中可见的印花或织纹图案；${useFabricColor ? '' : '面料颜色按下述明确配色来源调整，保留材料纹理和图案特征。'}面料图只提供材料样本，不继承其服装结构、廓形、人物或背景，也不把样本裁切边缘或背景形状当成服装形状。只复现参考中实际可见的图案，面料本身没有图案时不要发明图案。${style.fabric.text ? `补充面料说明（若文字明确限定使用部位则仅限该部位）：${style.fabric.text}` : ''}`
      : `按文字指定面料：${style.fabric.text}。不从未启用的面料图或配色图推断材质。`;
  const color = style.color.mode === 'auto' ? (style.fabric.mode === 'image'
    ? `自动配色：采用 Image ${fabricImage} 面料参考中实际可见的颜色，并与该面料的纹理、织法及可见印花或织纹图案保持一致。将该面料颜色应用于所有使用该面料的衣身、领子、口袋、袖子、袖口等面料面板；除非对应区域明确 color=retain（保留颜色），不要沿用主体图中的原有颜色或撞色色块。保留这些部位的形状、位置、比例、结构与工艺，保留结构不等于保留原色。`
    : `自动配色：未启用面料参考图，沿用 Image ${primary} 主体款式参考的原配色。`)
    : style.color.mode === 'primary' ? `采用 Image ${primary} 主体款式参考的原配色；该明确配色选择优先于自动面料颜色。`
    : style.color.mode === 'image' ? `配色仅取自 Image ${colorImage} 配色参考的颜色；不继承该图面料、纹理、服装结构、轮廓、图案、人物或背景。${style.color.text ? `补充配色说明：${style.color.text}` : ''}`
      : style.color.mode === 'custom' ? `主色严格采用用户指定的 sRGB 色值 ${style.color.hex}；在真实光照下保持该目标颜色，不以参考图主色替换。${style.color.text ? `补充配色说明：${style.color.text}` : ''}`
        : `按文字指定配色：${style.color.text}。不从未启用的配色图或面料图推断颜色。`;
  const panelRule = useFabricColor
    ? `所有面料面板（包括领子、口袋、袖子、袖口等）默认使用面料参考的颜色、纹理与图案；若补充面料说明明确限定使用部位，则仅在该部位使用面料及其颜色，其他部位沿用 Image ${primary} 主体款式参考的原面料与原配色。`
    : `所有面料面板（包括领子、口袋、袖子、袖口等）遵循上述配色来源；面料默认作用于所有面料面板，若补充面料说明明确限定使用部位则只在该部位使用。${style.color.mode !== 'auto' ? '当前明确选择的配色来源优先于面料参考中携带的颜色。' : ''}`;
  return `\n\n面料与配色来源锁定：以下设置是当前有效的全局来源，覆盖结构化设计要求中与之冲突的旧面料或配色默认值。\n面料：${fabric}\n配色：${color}\n${style.colorRatio ? `配色比例：${style.colorRatio}\n` : ''}${style.hardware ? `五金说明：${style.hardware}\n` : ''}${panelRule}局部继承优先：某个已标注区域明确设置 fabric=retain（保留面料）或 color=retain（保留颜色）时，该区域相应的原面料或原颜色优先于上述全局设置；只作用于该区域，不扩散到整件服装。fabric=retain 只保留材质，不自动保留该区域原色；只有 color=retain 保留该区域原色。其余区域遵循全局来源。材质参考不得改变服装结构，配色参考不得改变面料或结构。`;
}

export function validateDesignRequestBudget(references, guide = null) {
  if (references.length > MAX_DESIGN_REFERENCES || references.length + Number(Boolean(guide)) > MAX_DESIGN_REQUEST_IMAGES) throw invalid('设计请求最多包含 10 张原图和 1 张标注定位图。');
  const images = [...references, ...(guide ? [guide] : [])];
  for (const image of images) {
    const metadata = image.metadata || image;
    const limit = imageLimitMessage({ bytes: image.bytes.length, width: metadata.width, height: metadata.height });
    if (limit) throw invalid(limit, 413);
  }
  if (images.reduce((sum, image) => sum + image.bytes.length, 0) > MAX_TASK_IMAGE_BYTES) {
    throw invalid('参考原图与标注定位图合计超过本地 128MB 上限，请减少参考图后重新提交。原图未压缩，也未发送到图像服务。', 413);
  }
}

// The overview is an extra localization aid. Originals remain independent,
// byte-identical inputs and are always ordered before this derived image.
export async function buildDesignGuide(references) {
  const marked = references.map((reference, index) => ({ reference, referenceIndex: index + 1 })).filter(item => garmentRoles.has(item.reference.role) && item.reference.regions.length);
  if (!marked.length) return null;
  const padding = 20, cellWidth = 808, imageEdge = 768, header = 52, cellHeight = imageEdge + header;
  const columns = Math.min(2, marked.length), rows = Math.ceil(marked.length / columns);
  const width = columns * cellWidth + padding * 2, height = rows * cellHeight + padding * 2;
  const layers = [], panels = [], decorations = [];
  for (const [index, { reference, referenceIndex }] of marked.entries()) {
    const cellLeft = padding + (index % columns) * cellWidth, cellTop = padding + Math.floor(index / columns) * cellHeight;
    // Coordinates from the browser describe the visually oriented image, so
    // apply EXIF orientation before calculating the guide's region positions.
    const thumbnail = await sharp(reference.bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate().resize(imageEdge, imageEdge, { fit: 'inside' }).withIccProfile('srgb').png().toBuffer({ resolveWithObject: true });
    const left = cellLeft + Math.round((cellWidth - thumbnail.info.width) / 2);
    const top = cellTop + header + Math.round((imageEdge - thumbnail.info.height) / 2);
    layers.push({ input: thumbnail.data, left, top });
    decorations.push(`<text x="${cellLeft + 20}" y="${cellTop + 33}" font-family="sans-serif" font-size="25" font-weight="700" fill="#17211b">Image ${referenceIndex} (R${referenceIndex})</text>`);
    const regions = reference.regions.map((region, regionIndex) => {
      const id = `R${referenceIndex}.${regionIndex + 1}`;
      const x = left + region.x * thumbnail.info.width, y = top + region.y * thumbnail.info.height;
      const w = region.w * thumbnail.info.width, h = region.h * thumbnail.info.height;
      const badgeWidth = id.length * 14 + 14, badgeHeight = 30;
      const badgeLeft = Math.max(cellLeft, Math.min(x, cellLeft + cellWidth - badgeWidth));
      const badgeTop = Math.max(cellTop + header, y - badgeHeight);
      decorations.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ffffff" stroke-width="7"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ef6b19" stroke-width="4"/><rect x="${badgeLeft}" y="${badgeTop}" width="${badgeWidth}" height="${badgeHeight}" rx="3" fill="#ef6b19"/><text x="${badgeLeft + 7}" y="${badgeTop + 23}" font-family="sans-serif" font-size="22" font-weight="700" fill="#111111">${id}</text>`);
      return { id, regionIndex: regionIndex + 1, box: { x: region.x, y: region.y, w: region.w, h: region.h } };
    });
    panels.push({ referenceIndex, sourceReferenceId: reference.id, left, top, width: thumbnail.info.width, height: thumbnail.info.height, regions });
  }
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${decorations.join('')}</svg>`);
  const bytes = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite([...layers, { input: overlay, left: 0, top: 0 }]).png().toBuffer();
  const guide = { version: 1, bytes, width, height, format: 'png', panels, requestImageIndex: references.length + 1 };
  validateDesignRequestBudget(references, guide);
  return guide;
}

function buildSketchFlowPrompt(input, output, guide) {
  const primary = input.references[0];
  // Notes entered on a numbered canvas region are executable design
  // instructions, not merely descriptions. Surface obvious colour requests
  // separately so the image model cannot mistake “红色” for a label.
  const colorWords = /(?:红色|蓝色|绿色|黄色|黑色|白色|灰色|紫色|粉色|橙色|棕色|咖啡色|米色|卡其色|酒红色|藏蓝色|墨绿色|银色|金色|透明色)/g;
  const regions = primary.regions.map((region, index) => ({
    region_id: `R1.${index + 1}`, box: { x: region.x, y: region.y, w: region.w, h: region.h },
    part: region.part, placement: region.placement, priority: region.priority, note: region.note,
    edit: region.mode === 'adapt' ? '按说明修改此处' : '保留此处结构',
    ...(region.note.match(colorWords) ? { color_instruction: `将该标注区域改为${[...new Set(region.note.match(colorWords))].join('、')}，这是必须执行的局部颜色修改。` } : {}),
  }));
  const edits = primary.regions.filter(region => region.mode === 'adapt' && region.note.trim());
  const editInstruction = edits.length ? '\n局部修改优先：仅对 edit 为“按说明修改此处”且有明确文字要求的编号区域，允许按说明修改廓形、长度、结构或细节。未提及的属性、未标注区域和“保留此处结构”的区域保持原款；不能因一处修改重设计整件服装。区域说明中的面料配色只在成衣阶段生效，黑白线稿阶段只执行结构修改。' : '';
  const dimensions = output.vector ? '输出 SVG 矢量线稿，画幅和比例跟随主体原图。' : `画面比例 ${output.aspectRatio}，${output.nativeSize ? `目标分辨率 ${output.resolution}` : `目标尺寸 ${output.size}（${output.resolution}）`}。`;
  const localization = `Image 1: ${primary.name}。用途：主体款式参考。image_id=${primary.id}。\n区域说明：${JSON.stringify(regions)}\n区域坐标以图片按正常方向显示后的左上角为原点，以宽、高归一化到 0–1；x、y 为左上角，w、h 为区域宽、高。框选只定位部位，框线本身不是服装结构。标注 note 是必须执行的修改指令，不是可忽略的备注；例如 note=“红色”表示只把该编号区域改为红色，未标注区域不得跟随改变。${editInstruction}`;
  const guideInstruction = guide ? `\nImage ${guide.requestImageIndex} 是额外的标注定位总览图，只用于定位 Image 1 的区域 R1.N，绝不是新的款式、面料、配色或辅料参考。读取原图的真实细节；框线、编号、文字、排版和底色均不得出现在结果中，不要生成总览拼贴。` : '';
  if (input.designMode === 'photo_to_sketch' && output.vector) {
    return `用户对话指令：${input.prompt}\n${dimensions}
${localization}${guideInstruction}
最终以 Quiver 官网的彩色服装 SVG 款式图为准。`;
  }
  if (input.designMode === 'photo_to_sketch') {
    return `你是服装款式线稿转换器。仅依据款式主图生成干净的黑白服装款式线稿，每张独立图片只展示一件完整服装。${dimensions}
去除人物、模特、背景、阴影、摄影光照、颜色、印花及材质纹理。使用白色背景、清晰黑色线条，不做灰度渲染或真实成衣渲染。保留可见的外轮廓、领型、帽型、袖型、口袋、门襟、闭合方式、分割线及工艺线。${edits.length ? '除明确允许修改的编号区域外，保持原款式结构、比例和可见视角，不增加正反面拼图。' : '保持原款式结构、比例和可见视角，不重新设计或改变长度，不增加正反面拼图。'}隐藏或遮挡部分不得声称精确复原；必要时只按可见轮廓保守连接，不虚构不可见结构。不要添加文字、尺寸标注、品牌或水印。
${localization}${guideInstruction}
补充线稿要求：${input.prompt}
以上补充要求不能覆盖黑白线稿输出和去除材质颜色的要求。${edits.length ? '明确的局部结构修改优先于相应区域的原结构，其余区域保持不变。' : '区域说明仅用于明确目标服装与线稿细节，不能覆盖结构保留要求。'}`;
  }
  const style = input.style;
  const fabricIndex = input.references.findIndex(reference => reference.role === '面料参考' && reference.targetRegion === undefined) + 1;
  const colorIndex = input.references.findIndex(reference => reference.role === '配色参考' && reference.targetRegion === undefined) + 1;
  const mappings = input.references.slice(1).map((reference, index) => {
    const prefix = `Image ${index + 2}: ${reference.name}。用途：${reference.role}。image_id=${reference.id}。${reference.targetRegion ? `仅用于标注 R1.${reference.targetRegion}，不得扩散到其他区域。` : ''}`;
    if (reference.role === '面料参考') return `${prefix}仅提供真实材料的纹理、织法、厚薄、光泽、垂感和实际可见图案；自动配色时同时提供颜色。不继承其服装结构、人物、背景或样本裁切边缘，不发明不存在的图案。`;
    if (reference.role === '配色参考') return `${prefix}仅提供颜色，不继承其面料、图案、服装结构、人物或背景。`;
    return `${prefix}仅将该辅料应用于指定部位“${reference.placement}”。${reference.note ? `辅料说明：${reference.note}。` : ''}保留所选辅料的形状、材质和表面处理，尺寸须适合线稿原有结构。不得更改服装结构或背景，不复制参考图中的其他服装、人物、背景或未选辅料。`;
  });
  const fabric = style.fabric.mode === 'primary'
    ? '沿用 Image 1 主体线稿中可见的原面料与材质表现。'
    : style.fabric.mode === 'image'
      ? `采用 Image ${fabricIndex} 面料参考的真实材质。${style.fabric.text ? `补充面料说明：${style.fabric.text}` : ''}`
      : `按文字指定面料：${style.fabric.text}。`;
  const color = style.color.mode === 'auto' ? (style.fabric.mode === 'image'
    ? `自动配色：采用 Image ${fabricIndex} 面料参考中实际可见的颜色，所有使用该面料的部位均跟随此颜色。`
    : '自动配色：沿用 Image 1 主体线稿中可见的原配色。')
    : style.color.mode === 'image' ? `配色仅取自 Image ${colorIndex} 配色参考的颜色。${style.color.text ? `补充配色说明：${style.color.text}` : ''}`
    : style.color.mode === 'custom' ? `主色严格采用用户指定的 sRGB 色值 ${style.color.hex}。${style.color.text ? `补充配色说明：${style.color.text}` : ''}`
    : `按文字指定配色：${style.color.text}。`;
  const localInstructions = primary.regions.flatMap((region, index) => {
    const local = region.localStyle, trims = input.references.map((ref, i) => ({ ref, i })).filter(({ ref }) => ref.targetRegion === index + 1 && ref.role === '辅料参考');
    if (!local && !trims.length) return [];
    const imageIndex = role => input.references.findIndex(ref => ref.targetRegion === index + 1 && ref.role === role) + 1;
    const fabric = !local || local.fabric.mode === 'inherit' ? '沿用整体面料' : local.fabric.mode === 'image' ? `采用 Image ${imageIndex('面料参考')} 的纹理、织法、厚薄、光泽及可见图案${local.fabric.text ? `，补充：${local.fabric.text}` : ''}` : `按文字面料：${local.fabric.text}`;
    const color = !local || local.color.mode === 'inherit' ? '沿用整体配色' : local.color.mode === 'auto' ? `跟随 Image ${local.fabric.mode === 'image' ? imageIndex('面料参考') : fabricIndex} 面料自身的实际颜色` : local.color.mode === 'image' ? `采用 Image ${imageIndex('配色参考')} 色卡颜色${local.color.text ? `，补充：${local.color.text}` : ''}` : local.color.mode === 'custom' ? `采用 sRGB ${local.color.hex}${local.color.text ? `，补充：${local.color.text}` : ''}` : `按文字配色：${local.color.text}`;
    return [`标注 R1.${index + 1}（${region.placement || region.part}）：面料=${fabric}；配色=${color}。${trims.map(({ ref, i }) => `辅料仅取 Image ${i + 1}，仅用于此处；${ref.note || '保留原有结构和位置'}。`).join('')}`];
  });
  return `你是线稿成衣效果图生成器。根据主体线稿和已选择材料，生成真实、清晰的单件成衣产品图，每张独立图片只展示一件完整服装。${dimensions}
结构锁定：Image 1 是唯一的款式结构依据，${edits.length ? '以线稿结构为基础，仅明确允许修改的编号区域按文字调整，其余服装品类、轮廓、比例、长度、视角、领型、袖型、口袋、分割线和闭合方式保持不变。' : '严格保留线稿的服装品类、轮廓、比例、长度、视角、领型、袖型、口袋形状与位置、分割线和闭合方式。'}面料、颜色、辅料及补充风格只能改变材质表现或指定部位，不能重新设计服装。白色中性背景、自然产品光照、真实材料和合理垂感，无人物、模特、文字、水印或拼贴。
${localization}
${mappings.join('\n')}${guideInstruction}
面料与配色来源锁定：
面料：${fabric}
配色：${color}
${style.colorRatio ? `配色比例：${style.colorRatio}\n` : ''}${style.hardware ? `五金说明（仅约束线稿已有或明确选择的辅料）：${style.hardware}\n` : ''}面料默认应用于整件服装的面料面板。局部面料、拼接或局部配色以对应框选区域的部位和文字说明为准，只在明确指定的区域生效，其他区域继续使用全局来源。明确选择的色卡、色值或文字配色覆盖面料携带的颜色。线稿的黑线和白底不是原有颜色或材质，不能将其当作成衣配色、面料或印花；区域旧继承字段 retain 不表示保留黑白线稿颜色。不得擅自增加未选辅料；未指定替换的线稿原有闭合结构保留，辅料不能改变线稿的口袋、领型、开合位置或背景。
${localInstructions.length ? `局部材料覆盖（优先于整体材料，不改变未标注部位）：\n${localInstructions.join('\n')}\n局部面料/颜色/辅料只作用于上述标注区域，不将样本边缘或背景复制到服装上。不因换面料改变该区域形状。显式局部色卡/色值/文字配色优先于局部面料颜色；没有局部覆盖的属性继续沿用整体设置。\n` : ''}补充成衣要求：${input.prompt}
${edits.length ? '明确的编号局部修改优先于相应区域的原结构；未涉及的属性和部位仍遵守结构锁定。' : ''}结构锁定和当前有效的面料、配色、辅料来源优先于补充要求中冲突的旧设置。`;
}

export function buildDesignPrompt(input, output, guide = null) {
  if (input.designMode === 'photo_to_sketch' || input.designMode === 'sketch_to_garment') return buildSketchFlowPrompt(input, output, guide);
  const mappings = input.references.map((reference, index) => {
    if (reference.role === '面料参考') return `Image ${index + 1}: ${reference.name}。用途：面料参考。image_id=${reference.id}。控制纹理、织法、光泽、厚薄、垂感以及参考中可见的印花或织纹图案；${input.style?.color?.mode === 'auto' ? '自动配色采用面料样本的实际颜色。' : '颜色遵循下述明确选择的配色来源。'}只复现实际可见图案，不发明图案。不继承该图的服装结构、廓形、人物或背景，也不把样本裁切边缘或背景形状当成服装形状。不参与服装局部区域编号。`;
    if (reference.role === '配色参考') return `Image ${index + 1}: ${reference.name}。用途：配色参考。image_id=${reference.id}。仅控制颜色；不继承面料、纹理、服装结构、廓形、图案、人物或背景。不参与服装局部区域编号。`;
    const regions = reference.regions.map((region, regionIndex) => ({
      region: regionIndex + 1, region_id: `R${index + 1}.${regionIndex + 1}`, box: { x: region.x, y: region.y, w: region.w, h: region.h }, part: region.part,
      placement: region.placement, influence: modeLabels[region.mode], priority: region.priority,
      color: inheritLabels[region.color], fabric: inheritLabels[region.fabric], note: region.note,
    }));
    return `Image ${index + 1}: ${reference.name}。用途：${reference.role}。image_id=${reference.id}。${reference.role === '主体款式参考' ? '决定整体品类、廓形和服装骨架，局部按下述框选说明调整。' : '仅参考下列区域；未框选时不借用该图任何设计细节。'}\n区域说明：${JSON.stringify(regions)}`;
  });
  const guideInstruction = guide ? `\n\nImage ${guide.requestImageIndex} 是额外的标注定位总览图，不是新的款式、颜色、面料或构图参考。它只汇总有框选区域的原图，面板 Image N 对应前面的第 N 张原图，编号 RN.M 对应该原图的第 M 个区域。例如 R2.1 只指第 2 张原图的第 1 个区域。用橙色框和编号定位后，回看相应原图的完整像素读取真实细节。总览中的框线、底色、编号、文字、排版和图像缩放均为辅助信息，绝不能画进最终结果。最终只输出一件完整服装，禁止复制总览拼贴布局。` : '';
  return `你是服装设计效果图生成器。根据结构化设计要求生成完整单件服装效果图，每张独立图片展示一件服装，正面平铺或产品展示视图。画面比例 ${output.aspectRatio}，${output.nativeSize?`目标分辨率 ${output.resolution}`:`目标尺寸 ${output.size}（${output.resolution}）`}。\n\n图片顺序和用途必须严格遵循以下映射，主体款式图不一定是第一张：\n${mappings.join('\n\n')}\n\n前 ${input.references.length} 张输入图片是未绘制标记的原图。区域坐标以图片按正常方向显示后的左上角为原点，以图片宽、高归一化到 0–1；x、y 为左上角，w、h 为区域宽、高。根据坐标寻找对应局部，不要把区域画框、编号或说明文字画到结果中。主体参考控制骨架，细节参考仅供指定局部、作用方式、位置和优先级使用。颜色与面料按各区域继承设置和目标设计决定。不要复制未指定区域、品牌、文字、人物、背景或原图构图，不要生成拼贴、分屏或水印。${guideInstruction}\n\n结构化设计要求：\n${input.prompt}${buildDesignStylePrompt(input.style, input.references)}`;
}

function parseModelJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { /* Some providers add a short preamble. */ }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw invalid('视觉模型未返回可识别的分析结果，请手动标注或稍后重试。', 502);
  try { return JSON.parse(match[0]); } catch { throw invalid('视觉模型返回的分析格式不正确，请手动标注或稍后重试。', 502); }
}

function safeAnalysis(result, selection) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid('视觉模型返回的分析格式不正确。', 502);
  const detail = region => ({ part: parts.has(region.part) ? region.part : '其他结构', placement: short(region.placement, 160) || '对应部位', note: short(region.note, 2000), confidence: Math.max(0, Math.min(1, Number(region.confidence) || 0)) });
  if (selection) return detail(result);
  if (!Array.isArray(result.regions)) throw invalid('视觉模型没有返回区域列表，请手动标注或稍后重试。', 502);
  const regions = [];
  for (const region of result.regions.slice(0, 32)) {
    try { regions.push({ ...normalizeDesignBox(region), ...detail(region) }); } catch { /* Discard invalid model boxes rather than drawing outside the canvas. */ }
  }
  return { garmentCategory: short(result.garmentCategory, 100), summary: short(result.summary, 2000), regions };
}

export function createDesignService(options = {}) {
  let settings = {}, settingsPath;
  let writes = Promise.resolve();
  const fetcher = options.fetch || fetch;
  const publicSettings = () => ({ baseUrl: settings.baseUrl || 'https://api.openai.com/v1', model: settings.model || '', configured: Boolean(settings.apiKey && settings.model), maskedKey: settings.apiKey ? `••••${settings.apiKey.slice(-4)}` : '', imported: settings.imported === true });
  async function persist(next) {
    const temporary = `${settingsPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, settingsPath); settings = next;
  }
  return {
    async init(storeDir) {
      settingsPath = path.join(storeDir, 'design-settings.json');
      try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let imported = {};
      const source = options.importPath === undefined ? DEFAULT_DESIGN_IMPORT_PATH : options.importPath;
      if (source) {
        try {
          const configs = JSON.parse(await readFile(source, 'utf8'));
          const config = Array.isArray(configs) ? configs.find(item => item.name === 'api') || configs[0] : configs;
          if (config?.api_key && config?.api_base_url && config?.model) imported = {
            apiKey: short(config.api_key, 10000), baseUrl: normalizeBaseUrl(config.api_base_url), model: short(config.model, 200), imported: true,
          };
        } catch { /* Setup is optional; missing old config must not prevent FPA from starting. */ }
      }
      await persist({ version: 1, ...imported });
    },
    settings: publicSettings,
    recognizeAsset(bytes, category) {
      return recognizeAsset({ bytes, category, config: { ...settings }, fetcher, timeoutMs: Math.min(options.timeoutMs?.() || 120000,120000) });
    },
    updateSettings(input) {
      const task = writes.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('视觉设置格式不正确。');
        const next = { ...settings, baseUrl: normalizeBaseUrl(input.baseUrl ?? publicSettings().baseUrl), model: short(input.model ?? settings.model, 200) };
        if (!next.model || /\s/.test(next.model)) throw invalid('请填写有效的视觉分析模型名称。');
        if (input.clearKey) next.apiKey = '';
        else if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.apiKey = short(input.apiKey, 10000);
        await persist(next); return publicSettings();
      });
      writes = task.catch(() => {}); return task;
    },
    async analyze(input) {
      if (!settings.apiKey || !settings.model) throw invalid('请先填写设计工作台的视觉分析接口设置。', 503);
      const selection = input.selection == null ? null : normalizeDesignBox(input.selection);
      const full = await validateDesignImage(input.imageDataUrl);
      if (selection) await validateDesignImage(input.cropDataUrl);
      const config = { ...settings };
      const base = normalizeBaseUrl(config.baseUrl);
      const endpoint = base.endsWith('/chat/completions') ? base : `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`;
      const instruction = selection
        ? `你是服装设计结构分析器。你将看到两张图：第一张是整件服装原图，第二张是用户框选区域的局部裁剪图。只返回一个 JSON 对象，不要 Markdown，不要解释。结合整图上下文和局部裁剪图，判断用户框选的具体服装部位并描述可迁移的结构细节。用户框选区域在整图中的归一化坐标为 x=${selection.x}、y=${selection.y}、w=${selection.w}、h=${selection.h}，坐标只用于定位上下文，不是硬性分类规则。部位只能从以下列表中选择：${[...parts].join('、')}。看到衣领、翻领、立领、衬衫领、领口等领部结构时，必须优先选择“领型”；看到口袋时，根据整件服装的实际结构位置和视觉证据判断是“胸袋”还是“下袋”，不要仅凭局部外观猜测。只有确实无法判断时才使用“其他结构”。JSON 格式必须是：{"part":"袖口","placement":"对应部位","note":"描述结构、比例、体积、工艺等，不描述品牌","confidence":0.92}。`
        : `你是服装设计结构分析器。分析这张服装参考图，只返回一个 JSON 对象，不要 Markdown，不要解释。识别图中清晰可见、适合迁移到新设计的局部区域，例如${[...parts].join('、')}。每个区域给出归一化坐标 x、y、w、h，范围 0 到 1，坐标原点为图片左上角。不要给整件服装一个大框；优先给 2 到 8 个有设计价值的局部框。JSON 格式必须是：{"garmentCategory":"夹克","summary":"...","regions":[{"part":"袖口","placement":"对应部位","x":0.1,"y":0.7,"w":0.2,"h":0.15,"note":"描述结构、比例、体积、工艺等，不描述品牌","confidence":0.92}]}。如果某区域不确定也不要猜。`;
      let response;
      try {
        response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(options.timeoutMs?.() || 180000),
          body: JSON.stringify({ model: config.model, temperature: 0.1, max_tokens: selection ? 700 : 1100,
            messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, { type: 'image_url', image_url: { url: `data:${full.mime};base64,${full.bytes.toString('base64')}` } },
              ...(selection ? [{ type: 'text', text: '下面是用户框选区域的局部裁剪图：' }, { type: 'image_url', image_url: { url: input.cropDataUrl } }] : [])] }] }) });
        if (!response.ok) throw invalid([401, 403].includes(response.status) ? '视觉分析密钥未通过验证，请检查分析接口设置。' : `视觉分析接口返回 HTTP ${response.status}，请检查模型和服务状态。`, response.status >= 400 && response.status <= 599 ? response.status : 502);
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        const text = Array.isArray(content) ? content.map(item => item.text || '').join('') : typeof content === 'string' ? content : '';
        return safeAnalysis(parseModelJson(text), selection);
      } catch (error) {
        if (error.status) throw error;
        throw invalid(/TimeoutError|AbortError/.test(error.name) ? '视觉分析等待超时，请稍后手动重试。' : '视觉分析连接中断或返回异常，请检查接口设置后手动重试。', 502);
      }
    },
  };
}
