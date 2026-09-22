import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { wardrobeStudioApi } from './studio-api.mjs';
import { buildDesignPrompt, normalizeDesignInput, validateDesignRequestBudget } from './design-api.mjs';
import { MAX_IMAGE_BYTES, MAX_TASK_IMAGE_BYTES } from '../src/image-limits.mjs';

const dataUrl = (bytes, type = 'png') => `data:image/${type};base64,${bytes.toString('base64')}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.4, part: '胸袋', placement: '左胸', mode: 'retain', priority: 'high', color: 'ignore', fabric: 'adapt', note: '保留立体袋盖结构' };

async function harness(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-design-test-'));
  const pixel = await sharp({ create: { width: 24, height: 36, channels: 3, background: '#678078' } }).png().toBuffer();
  const calls = [], servers = [];
  let service;
  const options = {
    env: { WARDROBE_DATA_DIR: 'data', OPENAI_API_KEY: 'test-image-key', OPENAI_API_BASE_URL: 'http://mock.invalid/v1', OPENAI_IMAGE_MODEL: 'exact-image-model', OPENAI_IMAGE_TIMEOUT_MS: '180000', OPENAI_IMAGE_CONCURRENCY: '1' },
    designConfigImportPath: null,
    designGenerationConfigImportPath: null,
    designFetch: async () => { throw new Error('Unexpected analysis call'); },
    designGenerationFetch: async () => { throw new Error('Unexpected Gemini generation call'); },
    imageEdit: async args => { calls.push(args); return Buffer.from(pixel); },
    ...overrides,
  };
  async function close(server) {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  async function serve() {
    const plugin = wardrobeStudioApi(options);
    await plugin.configResolved({ root });
    let handler;
    plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
    const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server); service = { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${service.base}/api/studio/${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  async function waitFor(predicate) {
    for (let n = 0; n < 250; n++) {
      const state = (await request('state')).value;
      if (predicate(state)) return state;
      await delay(10);
    }
    throw new Error('Local mock queue did not settle');
  }
  t.after(async () => {
    for (const server of servers) await close(server);
    await rm(root, { recursive: true, force: true });
  });
  await serve();
  assert.equal((await request('design/generation-settings', { apiKey: 'test-design-image-key', model: 'exact-image-model', baseUrl: 'http://design.mock.invalid/v1', protocol: 'openai' }, 'PATCH')).status, 200);
  return {
    root, pixel, calls, request, waitFor,
    input(extra = {}) { return { name: '设计测试', prompt: '保留主体廓形，将指定胸袋转移至左胸。', references: [{ id: 'main', name: '主体', role: '主体款式参考', imageDataUrl: dataUrl(pixel), regions: [] }], ...extra }; },
    settled: () => waitFor(state => !state.jobs.some(job => ['queued', 'processing'].includes(job.status))),
    async restart() { await close(service.server); await serve(); },
    async files() { return (await readdir(path.join(root, 'data/studio'))).sort(); },
    async bytes(url) { return Buffer.from(await (await fetch(service.base + url)).arrayBuffer()); },
  };
}

test('设计参考按用户顺序发送原始字节，主体可在任意位置，框选说明准确映射', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const detail = await sharp({ create: { width: 42, height: 60, channels: 3, background: '#e0b578' } }).jpeg({ quality: 94 }).withMetadata({ orientation: 6 }).toBuffer();
  const primary = await sharp(h.pixel).webp({ lossless: true }).toBuffer();
  const references = [
    { id: 'detail-first', name: '胸袋细节图', role: '局部细节参考', imageDataUrl: dataUrl(detail, 'jpeg'), regions: [region] },
    { id: 'primary-second', name: '夹克主体图', role: '主体款式参考', imageDataUrl: dataUrl(primary, 'webp'), regions: [] },
  ];
  const result = await h.request('design/generate', h.input({ references, aspectRatio: '2:3', resolution: '2K', quality: 'auto', outputFormat: 'webp' }));
  assert.equal(result.status, 202); assert.equal(result.value.kind, 'design');
  const state = await h.settled();
  const job = state.jobs.find(item => item.id === result.value.id);
  assert.equal(job.status, 'complete'); assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.size, '1344x2016'); assert.equal(call.model, 'exact-image-model'); assert.equal(call.timeoutMs, 180000);
  assert.equal(call.compressInput, false); assert.equal(call.images.length, 3);
  assert.deepEqual(call.images.slice(0, 2).map(image => image.data), [detail, primary], '原始 JPEG/EXIF 和 WebP 都不重编码，不添加框线');
  assert.equal(job.references.length, 2, '辅助图不混入原始 references');
  assert.equal(job.designGuide.requestImageIndex, 3);
  assert.deepEqual(await h.bytes(job.designGuide.image), call.images[2].data);
  assert.match(call.images[0].name, /\.jpeg$/); assert.match(call.images[1].name, /\.webp$/);
  assert.match(call.prompt, /Image 1: 胸袋细节图。用途：局部细节参考/);
  assert.match(call.prompt, /Image 2: 夹克主体图。用途：主体款式参考/);
  assert.match(call.prompt, /主体款式图不一定是第一张/);
  const mapped = JSON.parse(call.prompt.match(/区域说明：([^\n]+)/)[1])[0];
  assert.deepEqual(mapped.box, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  assert.equal(mapped.influence, '严格保留结构'); assert.equal(mapped.color, '忽略'); assert.equal(mapped.fabric, '转译到目标设计');
  assert.equal(mapped.placement, '左胸'); assert.equal(mapped.priority, 'high'); assert.equal(mapped.note, region.note);
  assert.equal(mapped.region_id, 'R1.1');
  assert.match(call.prompt, /Image 3 是额外的标注定位总览图/);
  assert.deepEqual(job.references.map(ref => ref.sourceReferenceId), references.map(ref => ref.id));
  for (const [index, bytes] of [detail, primary].entries()) {
    const ref = job.references[index];
    assert.equal(ref.originalBytes, bytes.length); assert.equal(ref.originalSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await h.bytes(ref.image), bytes);
  }
  assert.equal(state.assets.length, 0, '设计参考保存在任务中，不混入搭配素材库');
});

test('辅助总览只包含有标注的原图，编号不重排，EXIF 方向与归一化区域准确对应', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const red = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#df2020' } }).png().toBuffer();
  const oriented = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#2040df' } }).composite([{ input: red, left: 0, top: 0 }]).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).withMetadata({ orientation: 6 }).toBuffer();
  const regions = [{ ...region, x: 0.1, y: 0.3, w: 0.4, h: 0.2 }];
  const references = [
    h.input().references[0],
    { id: 'rotated', name: '旋转局部', role: '局部细节参考', imageDataUrl: dataUrl(oriented, 'jpeg'), regions },
    { id: 'third', name: '第三张局部', role: '局部细节参考', imageDataUrl: dataUrl(h.pixel), regions: [region, { ...region, x: 0.5 }] },
  ];
  const result = await h.request('design/generate', h.input({ references }));
  assert.equal(result.status, 202);
  const job = (await h.settled()).jobs[0], guide = job.designGuide;
  assert.deepEqual(guide.panels.map(panel => panel.referenceIndex), [2, 3]);
  assert.deepEqual(guide.panels.flatMap(panel => panel.regions.map(item => item.id)), ['R2.1', 'R3.1', 'R3.2']);
  assert.equal(guide.requestImageIndex, 4); assert.equal(h.calls[0].images.length, 4);
  assert.deepEqual(h.calls[0].images[1].data, oriented);
  const panel = guide.panels[0];
  assert.equal(panel.width / panel.height, 0.5, 'EXIF 旋转后原图为 100×200，而非 200×100');
  const bytes = await h.bytes(guide.image);
  assert.equal(guide.sha256, createHash('sha256').update(bytes).digest('hex'));
  const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelAt = (x, y) => Array.from(decoded.data.subarray((Math.round(y) * decoded.info.width + Math.round(x)) * 3, (Math.round(y) * decoded.info.width + Math.round(x)) * 3 + 3));
  const topPixel = pixelAt(panel.left + panel.width * 0.85, panel.top + panel.height * 0.1);
  const bottomPixel = pixelAt(panel.left + panel.width * 0.85, panel.top + panel.height * 0.9);
  assert.ok(topPixel[0] > 180 && topPixel[2] < 70, '旋转后的上半部仍为红色');
  assert.ok(bottomPixel[2] > 180 && bottomPixel[0] < 70, '旋转后的下半部仍为蓝色');
  const boxPixel = pixelAt(panel.left + panel.width * 0.3, panel.top + panel.height * 0.5);
  assert.ok(Math.abs(boxPixel[0] - 239) < 3 && Math.abs(boxPixel[1] - 107) < 3 && Math.abs(boxPixel[2] - 25) < 3, '区域下边框按已旋转图的归一化坐标绘制');
  assert.match(job.prompt, /"region_id":"R2.1"/); assert.match(job.prompt, /"region_id":"R3.2"/);
  assert.match(job.prompt, /绝不能画进最终结果/);
});

test('设计原图及辅助图有明确图片数与合计字节限制，不用压缩绕过限制', () => {
  const fake = bytes => ({ bytes: { length: bytes }, metadata: { width: 100, height: 100 } });
  assert.doesNotThrow(() => validateDesignRequestBudget(Array.from({ length: 10 }, () => fake(1024)), fake(2048)));
  assert.throws(() => validateDesignRequestBudget(Array.from({ length: 11 }, () => fake(1024)), fake(2048)), /10 张原图和 1 张标注定位图/);
  assert.throws(() => validateDesignRequestBudget([fake(MAX_IMAGE_BYTES + 1)]), error => error.status === 413);
  const refs = [fake(MAX_IMAGE_BYTES), fake(MAX_IMAGE_BYTES), fake(MAX_TASK_IMAGE_BYTES - MAX_IMAGE_BYTES * 2 - 16)];
  assert.doesNotThrow(() => validateDesignRequestBudget(refs, fake(16)));
  assert.throws(() => validateDesignRequestBudget(refs, fake(17)), error => error.status === 413 && /标注定位图合计/.test(error.message));
});

test('无框选任务不添加辅助图；标注任务手动重试复用快照，删除清理原图和辅助图', { timeout: 15000 }, async t => {
  let fail = false;
  const requests = [];
  const h = await harness(t, { imageEdit: async args => {
    requests.push(args);
    if (fail) throw new Error('mock provider error');
    return await sharp({ create: { width: 20, height: 30, channels: 3, background: '#556655' } }).png().toBuffer();
  } });
  const noRegions = await h.request('design/generate', h.input());
  let state = await h.settled();
  assert.equal(state.jobs[0].designGuide, undefined); assert.equal(requests[0].images.length, 1);
  assert.doesNotMatch(requests[0].prompt, /额外的标注定位总览图/);
  const filesBefore = await h.files();
  fail = true;
  const marked = h.input(); marked.references[0].regions = [region];
  const result = await h.request('design/generate', marked);
  state = await h.settled();
  const failed = state.jobs.find(job => job.id === result.value.id);
  assert.equal(failed.status, 'failed'); assert.equal(requests.length, 2);
  const snapshot = await h.bytes(failed.designGuide.image);
  await h.restart();
  assert.equal(requests.length, 2, '失败任务不自动重试');
  fail = false;
  assert.equal((await h.request(`jobs/${failed.id}/retry`, {})).status, 202);
  state = await h.settled();
  const completed = state.jobs.find(job => job.id === failed.id);
  assert.equal(completed.status, 'complete'); assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].images.map(image => image.data), requests[1].images.map(image => image.data));
  assert.deepEqual(requests[2].images.at(-1).data, snapshot);
  assert.deepEqual(completed.designGuide, failed.designGuide);
  assert.equal(requests[2].prompt, requests[1].prompt, '重试不重新渲染辅助图或改写提示词');
  assert.equal((await h.request(`jobs/${failed.id}`, undefined, 'DELETE')).status, 200);
  assert.deepEqual(await h.files(), filesBefore, '清除设计结果、任务专用原图以及辅助图，同时保留另一任务的文件');
  assert.ok((await h.request('state')).value.jobs.some(job => job.id === noRegions.value.id));
});

test('旧版带区域但没有辅助图的记录仍能查看和重试，不生成新快照或改写原提示词', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const submitted = await h.request('design/generate', h.input());
  await h.settled();
  const dbPath = path.join(h.root, 'data/studio/studio.json');
  const db = JSON.parse(await readFile(dbPath, 'utf8'));
  const legacy = db.jobs.find(job => job.id === submitted.value.id);
  legacy.references[0].regions = [region]; legacy.status = 'failed'; legacy.prompt = '旧版设计提示词：原图第 1 个区域，仅使用坐标定位。';
  delete legacy.designGuide;
  await writeFile(dbPath, JSON.stringify(db));
  await h.restart();
  assert.equal(h.calls.length, 1);
  assert.equal((await h.request(`jobs/${legacy.id}/retry`, {})).status, 202);
  const state = await h.settled();
  assert.equal(state.jobs[0].status, 'complete'); assert.equal(state.jobs[0].designGuide, undefined);
  assert.equal(h.calls[1].images.length, 1); assert.deepEqual(h.calls[1].images[0].data, h.pixel);
  assert.equal(h.calls[1].prompt, legacy.prompt);
});

test('无效参考、越界坐标和输出设置在写文件或调用编辑器前被拒绝', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const valid = h.input(), main = valid.references[0];
  const beforeFiles = await h.files();
  const beforeDb = await readFile(path.join(h.root, 'data/studio/studio.json'), 'utf8');
  const invalidInputs = [
    { references: [] }, { references: Array.from({ length: 11 }, () => main) },
    { references: [{ ...main, role: '局部细节参考' }] }, { references: [main, main] },
    { references: [{ ...main, role: 'unknown' }] }, { prompt: '' }, { resolution: '4K' },
    { references: [{ ...main, regions: [{ ...region, x: -0.1 }] }] },
    { references: [{ ...main, regions: [{ ...region, x: 0.9, w: 0.2 }] }] },
    { references: [{ ...main, regions: [{ ...region, h: 0 }] }] },
    { references: [{ ...main, regions: [{ ...region, y: '0.2' }] }] },
    { references: [{ ...main, regions: [{ ...region, mode: 'unknown' }] }] },
    { references: [{ ...main, regions: Array.from({ length: 33 }, () => region) }] },
    { references: [main, { ...main, role: '局部细节参考', imageDataUrl: 'data:image/png;base64,Zm9v' }] },
    { references: [{ ...main, imageDataUrl: dataUrl(h.pixel, 'jpeg') }] },
  ];
  for (const input of invalidInputs) assert.equal((await h.request('design/generate', { ...valid, ...input })).status, 400);
  assert.equal(h.calls.length, 0); assert.equal((await h.request('state')).value.jobs.length, 0);
  assert.deepEqual(await h.files(), beforeFiles);
  assert.equal(await readFile(path.join(h.root, 'data/studio/studio.json'), 'utf8'), beforeDb);
});

test('面料与配色图作为独立原图按序发送、与款式严格隔离，局部 retain 优先并保存有效来源快照', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const fabric = await sharp(h.pixel).jpeg({ quality: 94 }).withMetadata({ orientation: 6 }).toBuffer();
  const color = await sharp(h.pixel).webp({ lossless: true }).toBuffer();
  const primary = { ...h.input().references[0], regions: [{ ...region, fabric: 'retain', color: 'retain' }] };
  const references = [primary,
    { id: 'fabric', name: '面料微距', role: '面料参考', imageDataUrl: dataUrl(fabric, 'jpeg'), regions: [] },
    { id: 'color', name: '配色色卡', role: '配色参考', imageDataUrl: dataUrl(color, 'webp'), regions: [] },
  ];
  const style = { fabric: { mode: 'image', text: '哑光，不改变领口结构', hex: '#000000' }, color: { mode: 'image', text: '主色采用色卡最深色', hex: '#ABCDEF' }, colorRatio: '主色 80%，辅色 20%', hardware: '哑银拉链' };
  const submitted = await h.request('design/generate', h.input({ references, style, count: 2, quality: 'medium', outputFormat: 'webp', aspectRatio: '4:5', resolution: '2K', moderation: 'low' }));
  assert.equal(submitted.status, 202);
  const state = await h.settled(), job = state.jobs[0], call = h.calls[0];
  assert.deepEqual(call.images.slice(0, 3).map(image => image.data), [h.pixel, fabric, color]);
  assert.equal(call.images.length, 4); assert.equal(job.designGuide.requestImageIndex, 4);
  assert.deepEqual(job.designGuide.panels.map(panel => panel.referenceIndex), [1], '面料与配色不进入服装标注总览');
  assert.deepEqual(job.references.map(reference => reference.role), ['主体款式参考', '面料参考', '配色参考']);
  assert.equal(call.model, 'exact-image-model'); assert.equal(call.key, 'test-design-image-key');
  assert.equal(call.size, '1600x2000'); assert.equal(call.count, 2); assert.equal(call.quality, 'medium'); assert.equal(call.outputFormat, 'webp'); assert.equal(call.moderation, 'low');
  assert.match(call.prompt, /Image 2: 面料微距。用途：面料参考/);
  assert.match(call.prompt, /Image 3: 配色色卡。用途：配色参考/);
  assert.match(call.prompt, /面料仅取自 Image 2 面料参考的纹理、织法、光泽/);
  assert.match(call.prompt, /配色仅取自 Image 3 配色参考的颜色/);
  assert.match(call.prompt, /不继承其服装结构、廓形、人物或背景/);
  assert.match(call.prompt, /当前明确选择的配色来源优先于面料参考中携带的颜色/);
  assert.match(call.prompt, /不继承该图面料、纹理、服装结构/);
  assert.match(call.prompt, /局部继承优先/); assert.match(call.prompt, /只作用于该区域，不扩散到整件服装/);
  assert.match(call.prompt, /主色 80%，辅色 20%/); assert.match(call.prompt, /哑银拉链/);
  assert.doesNotMatch(call.prompt, /#ABCDEF|#000000/);
  assert.deepEqual(job.designStyle, { fabric: { mode: 'image', text: style.fabric.text }, color: { mode: 'image', text: style.color.text }, colorRatio: style.colorRatio, hardware: style.hardware });
  await h.restart();
  assert.deepEqual((await h.request('state')).value.jobs[0].designStyle, job.designStyle);
});

test('文字和自定义色值精确使用，切回主体模式丢弃隐藏值，缺少 style 的历史合同保持兼容', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const custom = await normalizeDesignInput(h.input({ style: { fabric: { mode: 'text', text: '  细密棉麻斜纹  ' }, color: { mode: 'custom', hex: '#a1B2c3', text: '保持低饱和度' }, colorRatio: '', hardware: '' } }));
  const prompt = buildDesignPrompt(custom, { aspectRatio: '3:4', size: '1536x2048', resolution: '2K' });
  assert.match(prompt, /按文字指定面料：细密棉麻斜纹/); assert.match(prompt, /sRGB 色值 #a1B2c3/); assert.match(prompt, /保持低饱和度/);
  assert.equal(custom.style.color.hex, '#a1B2c3');
  const textColor = await normalizeDesignInput(h.input({ style: { color: { mode: 'text', text: '深墨绿色', hex: 'invalid-hidden' } } }));
  assert.match(buildDesignPrompt(textColor, {}), /按文字指定配色：深墨绿色/);
  assert.doesNotMatch(buildDesignPrompt(textColor, {}), /invalid-hidden/);
  const primary = await normalizeDesignInput(h.input({ style: { fabric: { mode: 'primary', text: { inactive: true } }, color: { mode: 'primary', text: 'HIDDEN_COLOR', hex: 'invalid-hidden' } } }));
  assert.deepEqual(primary.style.fabric, { mode: 'primary' }); assert.deepEqual(primary.style.color, { mode: 'primary' });
  const primaryPrompt = buildDesignPrompt(primary, {});
  assert.match(primaryPrompt, /主体款式参考的原面料/); assert.match(primaryPrompt, /主体款式参考的原配色/);
  assert.doesNotMatch(primaryPrompt, /HIDDEN_COLOR|invalid-hidden|inactive/);
  const legacy = await normalizeDesignInput(h.input());
  assert.equal(legacy.style, undefined); assert.doesNotMatch(buildDesignPrompt(legacy, {}), /面料与配色来源锁定/);
  assert.equal((await h.request('design/generate', h.input())).status, 202);
  assert.equal((await h.settled()).jobs[0].designStyle, undefined);
});

test('自动面料配色随原始图片和版本保存，局部保留只作用于指定区域，重启不改变来源', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const fabric = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#254da1' } }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
  const references = [
    { ...h.input().references[0], regions: [{ ...region, color: 'retain', fabric: 'adapt' }] },
    { id: 'fabric', name: '蓝色面料', role: '面料参考', imageDataUrl: dataUrl(fabric, 'jpeg'), regions: [] },
  ];
  const style = { version: 2, fabric: { mode: 'image' }, color: { mode: 'auto', text: 'HIDDEN_COLOR', hex: '#FFFF00' } };
  const submitted = await h.request('design/generate', h.input({ references, style }));
  assert.equal(submitted.status, 202);
  const job = (await h.settled()).jobs[0], call = h.calls[0];
  assert.equal(job.status, 'complete'); assert.equal(h.calls.length, 1);
  assert.deepEqual(job.designStyle, { version: 2, fabric: { mode: 'image' }, color: { mode: 'auto' }, colorRatio: '', hardware: '' });
  assert.deepEqual(call.images.slice(0, 2).map(image => image.data), [h.pixel, fabric]);
  assert.equal(call.compressInput, false); assert.equal(call.model, 'exact-image-model'); assert.equal(call.baseUrl, 'http://design.mock.invalid/v1');
  assert.deepEqual(await h.bytes(job.references[1].image), fabric);
  assert.match(call.prompt, /自动配色：采用 Image 2 面料参考中实际可见的颜色/);
  assert.match(call.prompt, /保留结构不等于保留原色/);
  assert.match(call.prompt, /"color":"保留","fabric":"转译到目标设计"/);
  assert.match(call.prompt, /只作用于该区域，不扩散到整件服装/);
  assert.doesNotMatch(call.prompt, /HIDDEN_COLOR|#FFFF00/);
  await h.restart();
  assert.deepEqual((await h.request('state')).value.jobs[0].designStyle, job.designStyle);
  assert.equal(h.calls.length, 1, '重启不调用图像接口');
});

test('面料与配色来源错误、未启用图片、重复角色及过长提示词均在落盘或付费排队前拒绝', { timeout: 15000 }, async t => {
  const h = await harness(t), main = h.input().references[0];
  const fabric = { id: 'fabric', role: '面料参考', name: '面料', imageDataUrl: dataUrl(h.pixel), regions: [] };
  const color = { id: 'color', role: '配色参考', name: '色卡', imageDataUrl: dataUrl(h.pixel), regions: [] };
  const beforeFiles = await h.files(), beforeDb = await readFile(path.join(h.root, 'data/studio/studio.json'), 'utf8');
  const invalidInputs = [
    { style: null }, { style: [] }, { style: { fabric: 'image' } }, { style: { fabric: { mode: 'custom' } } },
    { style: { color: { mode: 'invalid' } } }, { style: { fabric: { mode: 'text', text: '' } } },
    { style: { color: { mode: 'text', text: 12 } } }, { style: { color: { mode: 'custom', hex: '#FFF' } } },
    { style: { color: { mode: 'custom', hex: '#12345G' } } }, { style: { fabric: { mode: 'image' } } },
    { style: { color: { mode: 'image' } } }, { style: { colorRatio: {} } }, { style: { hardware: 'a'.repeat(1001) } },
    { references: [main, fabric] }, { references: [main, color], style: { color: { mode: 'primary' } } },
    { references: [main, fabric], style: { fabric: { mode: 'text', text: 'cotton' } } },
    { references: [main, fabric, { ...fabric, id: 'fabric-2' }], style: { fabric: { mode: 'image' } } },
    { references: [main, color, { ...color, id: 'color-2' }], style: { color: { mode: 'image' } } },
    { references: [main, { ...fabric, regions: [region] }], style: { fabric: { mode: 'image' } } },
    { references: [fabric, main], style: { fabric: { mode: 'image' } } },
    { prompt: 123 }, { prompt: 'a'.repeat(64001) },
  ];
  for (const input of invalidInputs) assert.equal((await h.request('design/generate', h.input(input))).status, 400, JSON.stringify(input).slice(0, 150));
  assert.equal(h.calls.length, 0); assert.deepEqual(await h.files(), beforeFiles);
  assert.equal(await readFile(path.join(h.root, 'data/studio/studio.json'), 'utf8'), beforeDb);
});

test('设计生成与搭配共享队列，按开始时的模型和超时发送，失败及重启不自动重试', { timeout: 15000 }, async t => {
  const calls = []; let pixel;
  const h = await harness(t, { imageEdit: async args => new Promise((resolve, reject) => calls.push({ args, release: () => resolve(Buffer.from(pixel)), reject })) });
  pixel = h.pixel;
  t.after(() => { for (const call of calls) call.release(); });
  const asset = await h.request('assets', { name: '测试上衣', part: 'upperbody', imageDataUrl: dataUrl(pixel) });
  assert.equal(asset.status, 201);
  const outfit = await h.request('outfits', { assetIds: [asset.value.id] });
  assert.equal(outfit.status, 202);
  await h.waitFor(() => calls.length === 1);
  const design = await h.request('design/generate', h.input());
  assert.equal(design.status, 202);
  let state = await h.waitFor(state => state.queue.queued === 1);
  assert.deepEqual(state.queue, { running: 1, queued: 1, concurrency: 1 });
  assert.equal(calls.length, 1, '设计不会绕过搭配队列单独启动');
  assert.equal((await h.request('settings', { model: 'user-custom-image-model', timeoutMinutes: 5 }, 'PATCH')).status, 200);
  assert.equal((await h.request('design/generation-settings', { model: 'user-custom-design-model' }, 'PATCH')).status, 200);
  assert.equal(calls[0].args.model, 'exact-image-model'); assert.equal(calls[0].args.timeoutMs, 180000);
  calls[0].release();
  await h.waitFor(() => calls.length === 2);
  assert.equal(calls[1].args.model, 'user-custom-design-model'); assert.equal(calls[1].args.timeoutMs, 300000);
  assert.equal(calls[1].args.key, 'test-design-image-key'); assert.equal(calls[1].args.baseUrl, 'http://design.mock.invalid/v1');
  calls[1].reject(Object.assign(new Error('Local timeout test'), { isLocalTimeout: true }));
  state = await h.settled();
  const failed = state.jobs.find(job => job.id === design.value.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failureKind, 'client_timeout'); assert.equal(failed.resultUncertain, true);
  assert.equal(failed.attemptCount, 1); assert.equal(failed.requestTimeoutMs, 300000); assert.equal(failed.providerModel, 'user-custom-design-model');
  assert.equal(calls.length, 2);
  await h.restart();
  state = (await h.request('state')).value;
  assert.equal(state.jobs.find(job => job.id === design.value.id).status, 'failed'); assert.equal(calls.length, 2, '重启保留失败记录，不再次调用付费接口');
});

test('视觉配置脱敏并持久化，分析原图与裁剪只发送到指定聊天模型', { timeout: 15000 }, async t => {
  const analysisCalls = [];
  const h = await harness(t, { designFetch: async (url, init) => {
    const body = JSON.parse(init.body); analysisCalls.push({ url, init, body });
    const selection = body.messages[0].content.filter(item => item.type === 'image_url').length === 2;
    const result = selection ? { part: '领型', placement: '领口', note: '保留翻领', confidence: 0.95 } : { garmentCategory: '夹克', summary: '结构清晰', regions: [{ ...region, confidence: 0.9 }, { ...region, x: 2 }] };
    return Response.json({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` } }] });
  } });
  assert.equal((await h.request('design/settings')).value.configured, false);
  assert.equal((await h.request('design/analyze', { imageDataUrl: dataUrl(h.pixel) })).status, 503);
  const syntheticKey = 'local-vision-test-secret-9382';
  const settings = await h.request('design/settings', { apiKey: syntheticKey, model: 'custom-vision-model-exact', baseUrl: 'http://analysis.mock.invalid/v1/' }, 'PATCH');
  assert.equal(settings.status, 200); assert.equal(settings.value.configured, true); assert.equal(settings.value.maskedKey, '••••9382');
  assert.equal(Object.hasOwn(settings.value, 'apiKey'), false); assert.ok(!JSON.stringify(settings.value).includes(syntheticKey));
  assert.equal((await h.request('design/settings', { apiKey: '', model: 'custom-vision-model-exact' }, 'PATCH')).value.configured, true);
  await h.restart();
  const restored = await h.request('design/settings');
  assert.equal(restored.value.model, 'custom-vision-model-exact'); assert.equal(restored.value.maskedKey, '••••9382');
  const original = await sharp(h.pixel).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const crop = await sharp(h.pixel).resize(8, 12).png().toBuffer();
  const full = await h.request('design/analyze', { imageDataUrl: dataUrl(original, 'jpeg') });
  assert.equal(full.status, 200); assert.equal(full.value.regions.length, 1, '模型越界框不会返回给标注画布');
  const selection = await h.request('design/analyze', { imageDataUrl: dataUrl(original, 'jpeg'), cropDataUrl: dataUrl(crop), selection: region });
  assert.equal(selection.status, 200); assert.equal(selection.value.part, '领型');
  for (const call of analysisCalls) {
    assert.equal(call.url, 'http://analysis.mock.invalid/v1/chat/completions'); assert.equal(call.init.method, 'POST');
    assert.equal(call.body.model, 'custom-vision-model-exact'); assert.equal(call.init.headers.Authorization, `Bearer ${syntheticKey}`);
    assert.equal(call.body.messages[0].content.find(item => item.type === 'image_url').image_url.url, dataUrl(original, 'jpeg'));
    assert.equal(call.init.signal.aborted, false);
  }
  assert.deepEqual(analysisCalls[1].body.messages[0].content.filter(item => item.type === 'image_url').map(item => item.image_url.url), [dataUrl(original, 'jpeg'), dataUrl(crop)]);
  assert.equal(h.calls.length, 0, '视觉分析不调用生图编辑器');
  assert.equal((await h.request('state')).value.jobs.length, 0);
  assert.equal((await h.request('design/analyze', { imageDataUrl: dataUrl(original, 'jpeg'), cropDataUrl: dataUrl(crop), selection: { ...region, x: 2 } })).status, 400);
  assert.equal(analysisCalls.length, 2);
  assert.equal((await h.request('design/settings', { clearKey: true }, 'PATCH')).value.configured, false);
  await h.restart();
  assert.equal((await h.request('design/settings')).value.maskedKey, '');
});
