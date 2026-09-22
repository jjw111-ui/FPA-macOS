import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { wardrobeStudioApi } from './studio-api.mjs';
import { buildDesignGuide, buildDesignPrompt, normalizeDesignInput } from './design-api.mjs';

const encode = (bytes, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const pixel = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#758f7a' } }).png().toBuffer();
const region = { x: 0.2, y: 0.3, w: 0.4, h: 0.2, part: '胸袋', placement: '左胸', mode: 'retain', priority: 'high', color: 'retain', fabric: 'retain', note: '仅胸袋改用深蓝色，保留袋口形状' };
const ref = (id, role, extra = {}) => ({ id, name: id, role, imageDataUrl: encode(pixel), regions: [], ...extra });
const main = () => ref('main', '主体款式参考');
const fabric = () => ref('fabric', '面料参考');
const color = () => ref('color', '配色参考');
const trim = () => ref('trim', '辅料参考', { placement: '门襟', note: '替换现有扣位，保留数量' });
const garment = (extra = {}) => ({ name: '线稿成衣', designMode: 'sketch_to_garment', prompt: '呈现真实成衣材质', references: [main(), fabric()], style: { version: 2, fabric: { mode: 'image' }, color: { mode: 'auto' } }, ...extra });
const photo = (extra = {}) => ({ name: '款式转线稿', designMode: 'photo_to_sketch', prompt: '保留可见款式结构', references: [main()], ...extra });
const output = { aspectRatio: '3:4', size: '1536x2048', resolution: '2K' };

async function harness(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-sketch-test-'));
  const calls = [], servers = [];
  const options = {
    env: { WARDROBE_DATA_DIR: 'data', OPENAI_API_KEY: 'unused-global-key', OPENAI_IMAGE_TIMEOUT_MS: '180000', OPENAI_IMAGE_CONCURRENCY: '1' },
    designConfigImportPath: null, designGenerationConfigImportPath: null,
    designFetch: async () => { throw new Error('Unexpected analysis request'); },
    designGenerationFetch: async () => { throw new Error('Unexpected external image request'); },
    imageEdit: async args => { calls.push(args); return Buffer.from(pixel); }, ...overrides,
  };
  let current;
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
    servers.push(server); current = { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${current.base}/api/studio/${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  async function settled() {
    for (let attempt = 0; attempt < 250; attempt++) {
      const state = (await request('state')).value;
      if (!state.jobs.some(job => ['queued', 'processing'].includes(job.status))) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Mock design queue did not settle');
  }
  t.after(async () => { for (const server of servers) await close(server); await rm(root, { recursive: true, force: true }); });
  await serve();
  const configured = await request('design/generation-settings', { protocol: 'openai', apiKey: 'mock-design-key', model: 'mock-design-model', baseUrl: 'http://design.mock.invalid/v1' }, 'PATCH');
  assert.equal(configured.status, 200);
  return { root, calls, request, settled,
    files: () => readdir(path.join(root, 'data/studio')),
    database: () => readFile(path.join(root, 'data/studio/studio.json'), 'utf8'),
    bytes: async url => Buffer.from(await (await fetch(current.base + url)).arrayBuffer()),
    restart: async () => { await close(current.server); await serve(); },
  };
}

test('局部面料、色卡与辅料只映射指定标注，原图和局部配置入库后完整保留', async t => {
  const h = await harness(t);
  const localStyle = { fabric: { mode: 'image', text: '仅换袖口' }, color: { mode: 'auto' } };
  const second = { fabric: { mode: 'text', text: '丝绒' }, color: { mode: 'custom', hex: '#FF0000' } };
  const refs = [ref('main', '主体款式参考', { regions: [{ ...region, note: '', localStyle }, { ...region, placement: '领口', localStyle: second }] }), fabric(), ref('cuff', '面料参考', { targetRegion: 1 }), ref('zip', '辅料参考', { targetRegion: 2, placement: '领口', note: '保留原长度' })];
  const input = garment({ references: refs });
  const normalized = await normalizeDesignInput(input), prompt = buildDesignPrompt(normalized, output);
  assert.match(prompt, /仅用于标注 R1.1，不得扩散到其他区域/);
  assert.match(prompt, /标注 R1.1.*Image 3.*跟随 Image 3 面料自身的实际颜色/);
  assert.match(prompt, /标注 R1.2.*丝绒.*sRGB #FF0000.*Image 4/);
  assert.match(prompt, /自动配色：采用 Image 2 面料参考/);
  assert.equal((await h.request('design/generate', input)).status, 202);
  const job = (await h.settled()).jobs[0]; assert.equal(job.status, 'complete');
  assert.deepEqual(job.references[0].regions[0].localStyle, localStyle);
  assert.equal(job.references[2].targetRegion, 1); assert.equal(job.references[3].targetRegion, 2);
  assert.deepEqual(h.calls[0].images.slice(0, 4).map(image => image.data), [pixel, pixel, pixel, pixel]);
  await h.restart(); assert.deepEqual((await h.request('state')).value.jobs[0].references, job.references);
  const cases = [
    { ...input, references: refs.map((ref, i) => i === 2 ? { ...ref, targetRegion: 3 } : ref) },
    { ...input, references: refs.filter((_, i) => i !== 2) },
    { ...input, references: [...refs.slice(0, 3), { ...refs[2], id: 'duplicate' }, refs[3]] },
    { ...input, references: refs.map((ref, i) => i === 0 ? { ...ref, regions: [{ ...region, localStyle: { fabric: { mode: 'text', text: 'cotton' }, color: { mode: 'auto' } } }, ref.regions[1]] } : ref) },
  ];
  const files = await h.files();
  for (const bad of cases) assert.equal((await h.request('design/generate', bad)).status, 400);
  assert.deepEqual(await h.files(), files); assert.equal(h.calls.length, 1);
});

test('款式转线稿提示词与真实成衣及旧改款规则隔离，保留结构和定位信息', async () => {
  const normalized = await normalizeDesignInput(photo({ references: [ref('main', '主体款式参考', { regions: [region] })] }));
  const guide = await buildDesignGuide(normalized.references);
  const prompt = buildDesignPrompt(normalized, output, guide);
  assert.match(prompt, /干净的黑白服装款式线稿/);
  assert.match(prompt, /去除人物、模特、背景、阴影、摄影光照、颜色、印花及材质纹理/);
  assert.match(prompt, /保持原款式结构、比例和可见视角/);
  assert.match(prompt, /隐藏或遮挡部分不得声称精确复原/);
  assert.match(prompt, /Image 2 是额外的标注定位总览图/);
  assert.match(prompt, /目标尺寸 1536x2048（2K）/);
  assert.doesNotMatch(prompt, /面料与配色来源锁定|服装设计效果图生成器|局部继承优先|转译到目标设计/);
  const mapped = JSON.parse(prompt.match(/区域说明：([^\n]+)/)[1])[0];
  assert.deepEqual(mapped.box, { x: 0.2, y: 0.3, w: 0.4, h: 0.2 });
  assert.equal(mapped.region_id, 'R1.1'); assert.equal(mapped.note, region.note);
});

test('线稿成衣锁定结构、分离面料配色辅料来源，局部规则不将黑白线稿当作材料', async () => {
  const normalized = await normalizeDesignInput(garment({ references: [ref('main', '主体款式参考', { regions: [region] }), fabric(), trim()] }));
  const prompt = buildDesignPrompt(normalized, output);
  assert.match(prompt, /Image 1 是唯一的款式结构依据/);
  assert.match(prompt, /补充风格只能改变材质表现或指定部位，不能重新设计服装/);
  assert.match(prompt, /自动配色：采用 Image 2 面料参考中实际可见的颜色/);
  assert.match(prompt, /Image 3: trim。用途：辅料参考/);
  assert.match(prompt, /指定部位“门襟”/);
  assert.match(prompt, /替换现有扣位，保留数量/);
  assert.match(prompt, /不得擅自增加未选辅料/);
  assert.match(prompt, /局部面料、拼接或局部配色以对应框选区域的部位和文字说明为准/);
  assert.match(prompt, /线稿的黑线和白底不是原有颜色或材质/);
  assert.doesNotMatch(prompt, /主体款式参考的原面料|主体款式参考的原配色|局部继承优先|正面平铺|服装款式线稿转换器/);
  const text = await normalizeDesignInput(garment({ references: [main()], style: { fabric: { mode: 'text', text: '纯棉斜纹' }, color: { mode: 'custom', hex: '#A1b2C3', text: '低饱和度' }, hardware: '现有拉链使用哑银表面' } }));
  const customPrompt = buildDesignPrompt(text, output);
  assert.match(customPrompt, /按文字指定面料：纯棉斜纹/); assert.match(customPrompt, /sRGB 色值 #A1b2C3/);
  assert.match(customPrompt, /五金说明（仅约束线稿已有或明确选择的辅料）/);
});

test('线稿成衣未选择面料或配色时沿用主体款式并允许直接生成', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const input = garment({
    references: [main()],
    style: { fabric: { mode: 'primary' }, color: { mode: 'auto' } },
  });
  const normalized = await normalizeDesignInput(input);
  const prompt = buildDesignPrompt(normalized, output);
  assert.match(prompt, /沿用 Image 1 主体线稿中可见的原面料/);
  assert.match(prompt, /沿用 Image 1 主体线稿中可见的原配色/);
  assert.equal((await h.request('design/generate', input)).status, 202);
  const job = (await h.settled()).jobs[0];
  assert.equal(job.status, 'complete');
  assert.equal(job.designStyle.fabric.mode, 'primary');
  assert.equal(job.designStyle.color.mode, 'auto');
});

test('局部标注中的颜色文字会作为必须执行的局部颜色指令发送', async () => {
  const input = await normalizeDesignInput(garment({ references: [ref('main', '主体款式参考', { regions: [{ ...region, mode: 'adapt', note: '红色' }] })], style: { fabric: { mode: 'primary' }, color: { mode: 'auto' } } }));
  const prompt = buildDesignPrompt(input, output);
  assert.match(prompt, /color_instruction.*红色/);
  assert.match(prompt, /标注 note 是必须执行的修改指令/);
  assert.match(prompt, /只把该编号区域改为红色/);
});

test('照片和线稿的明确局部改款指令覆盖对应结构，未标注部分及旧保留模式继续锁定', async () => {
  const edit = { ...region, mode: 'adapt', note: '下摆改成 A 字形', placement: '下摆' };
  for (const input of [photo({ references: [ref('main', '主体款式参考', { regions: [edit, region] })] }), garment({ references: [ref('main', '主体款式参考', { regions: [edit, region] }), fabric()] })]) {
    const normalized = await normalizeDesignInput(input), guide = await buildDesignGuide(normalized.references);
    const prompt = buildDesignPrompt(normalized, output, guide);
    const mapped = JSON.parse(prompt.match(/区域说明：([^\n]+)/)[1]);
    assert.equal(mapped[0].edit, '按说明修改此处'); assert.equal(mapped[0].note, edit.note);
    assert.equal(mapped[1].edit, '保留此处结构');
    assert.match(prompt, /局部修改优先/); assert.match(prompt, /未标注区域/);
    assert.match(prompt, /框线、编号、文字、排版和底色均不得出现在结果中/);
    assert.match(prompt, /黑白线稿阶段只执行结构修改/);
  }
  const unchanged = buildDesignPrompt(await normalizeDesignInput(photo({ references: [ref('main', '主体款式参考', { regions: [region] })] })), output);
  assert.doesNotMatch(unchanged, /局部修改优先/);
  assert.match(unchanged, /不重新设计或改变长度/);
});

test('两阶段由两次手动请求触发，原图字节与来源模式、材料、辅料及标注快照重启后保持', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const original = await sharp(pixel).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
  const fabricBytes = await sharp(pixel).webp({ lossless: true }).toBuffer();
  const uploaded = await h.request('design/generate', photo({ references: [ref('main', '主体款式参考', { imageDataUrl: encode(original, 'image/jpeg') })], ...output }));
  assert.equal(uploaded.status, 202);
  const first = (await h.settled()).jobs[0];
  assert.equal(first.designMode, 'photo_to_sketch'); assert.equal(first.status, 'complete');
  assert.equal(first.designStyle, undefined); assert.equal(first.sourceJobId, undefined); assert.equal(h.calls.length, 1, '完成线稿不自动触发成衣');
  assert.deepEqual(h.calls[0].images[0].data, original);
  const refs = [ref('main', '主体款式参考', { imageDataUrl: encode(original, 'image/jpeg'), regions: [region] }), ref('fabric', '面料参考', { imageDataUrl: encode(fabricBytes, 'image/webp') }), color(), trim()];
  const style = { version: 2, fabric: { mode: 'image', text: '胸袋采用相同织法' }, color: { mode: 'image', text: '采用色卡主色' }, colorRatio: '主色 90%', hardware: '哑银' };
  const submitted = await h.request('design/generate', garment({ sourceJobId: first.id, references: refs, style, ...output, count: 2 }));
  assert.equal(submitted.status, 202);
  const job = (await h.settled()).jobs[0], call = h.calls[1];
  assert.equal(job.status, 'complete'); assert.equal(job.designMode, 'sketch_to_garment'); assert.equal(job.sourceJobId, first.id);
  assert.deepEqual(job.designStyle, style); assert.deepEqual(job.references[0].regions, [region]);
  assert.equal(job.references[3].placement, '门襟'); assert.equal(job.references[3].note, '替换现有扣位，保留数量');
  assert.deepEqual(call.images.slice(0, 4).map(image => image.data), [original, fabricBytes, pixel, pixel]);
  assert.equal(call.images.length, 5); assert.equal(job.designGuide.requestImageIndex, 5);
  assert.deepEqual(job.designGuide.panels.map(panel => panel.referenceIndex), [1]);
  assert.equal(call.compressInput, false); assert.equal(call.model, 'mock-design-model'); assert.equal(call.key, 'mock-design-key');
  assert.equal(call.baseUrl, 'http://design.mock.invalid/v1'); assert.equal(call.timeoutMs, 180000); assert.equal(call.count, 2); assert.equal(call.size, '1536x2048');
  assert.match(call.prompt, /配色仅取自 Image 3 配色参考的颜色/);
  for (const [index, bytes] of [original, fabricBytes, pixel, pixel].entries()) {
    assert.deepEqual(await h.bytes(job.references[index].image), bytes);
    assert.equal(job.references[index].originalSha256, createHash('sha256').update(bytes).digest('hex'));
  }
  await h.restart();
  assert.deepEqual((await h.request('state')).value.jobs.find(item => item.id === job.id), job);
  assert.equal(h.calls.length, 2, '重启和历史恢复不自动出图');
});

test('新模式的非法来源、辅料、区域及材料设置在保存文件和排队之前拒绝', { timeout: 15000 }, async t => {
  const h = await harness(t), beforeFiles = await h.files(), beforeDb = await h.database();
  const bad = [
    garment({ designMode: 'unknown' }), garment({ designMode: null }),
    photo({ references: [main(), fabric()] }), photo({ references: [main(), ref('detail', '局部细节参考')] }), photo({ style: {} }),
    photo({ sourceJobId: 'abc' }), photo({ references: [ref('main', '主体款式参考', { regions: [{ ...region, x: 0.9 }] })] }),
    garment({ style: undefined }), garment({ style: null }), garment({ style: {} }),
    garment({ references: [main()], style: { fabric: { mode: 'text', text: '棉' }, color: { mode: 'auto' } } }),
    garment({ references: [main()], style: { fabric: { mode: 'text', text: '棉' }, color: { mode: 'custom', hex: '#FFF' } } }),
    garment({ references: [main(), fabric(), ref('detail', '局部细节参考')] }),
    garment({ references: [main(), trim(), fabric()] }), garment({ references: [fabric(), main()] }),
    garment({ references: [main(), fabric(), { ...trim(), placement: '' }] }),
    garment({ references: [main(), fabric(), { ...trim(), placement: '门'.repeat(161) }] }),
    garment({ references: [main(), fabric(), { ...trim(), note: '字'.repeat(2001) }] }),
    garment({ references: [main(), fabric(), { ...trim(), note: {} }] }),
    garment({ references: [main(), fabric(), { ...trim(), regions: [region] }] }),
    garment({ references: [main(), fabric(), { ...trim(), id: 'main' }] }),
    garment({ sourceJobId: '../unknown' }), garment({ sourceJobId: '' }), garment({ sourceJobId: 'nonexistent' }),
    { prompt: '参考改款', references: [main(), trim()] },
  ];
  for (const [index, input] of bad.entries()) {
    const result = await h.request('design/generate', input);
    assert.equal(result.status, 400, `bad[${index}] ${JSON.stringify(input).slice(0, 220)}`);
  }
  assert.equal(h.calls.length, 0); assert.deepEqual(await h.files(), beforeFiles); assert.equal(await h.database(), beforeDb);
});

test('来源任务必须是完成的款式转线稿；旧改款合同和提示词保持兼容', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const legacy = { name: '参考改款', prompt: '保留现有款式', references: [main()] };
  const implicit = await normalizeDesignInput(legacy), explicit = await normalizeDesignInput({ ...legacy, designMode: 'redesign' });
  assert.equal(buildDesignPrompt(implicit, output), buildDesignPrompt(explicit, output));
  assert.match(buildDesignPrompt(implicit, output), /主体款式图不一定是第一张/);
  assert.doesNotMatch(buildDesignPrompt(implicit, output), /线稿|辅料/);
  assert.equal((await h.request('design/generate', legacy)).status, 202);
  const prior = (await h.settled()).jobs[0];
  const beforeFiles = await h.files();
  assert.equal((await h.request('design/generate', garment({ sourceJobId: prior.id }))).status, 400);
  assert.deepEqual(await h.files(), beforeFiles); assert.equal(h.calls.length, 1);
});

test('待处理的线稿不能作为已确认来源，完成后才可手动生成成衣', { timeout: 15000 }, async t => {
  let release;
  const h = await harness(t, { imageEdit: async () => new Promise(resolve => { release = () => resolve(Buffer.from(pixel)); }) });
  t.after(() => release?.());
  const submitted = await h.request('design/generate', photo());
  assert.equal(submitted.status, 202);
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof release, 'function');
  const beforeFiles = await h.files();
  assert.equal((await h.request('design/generate', garment({ sourceJobId: submitted.value.id }))).status, 400);
  assert.deepEqual(await h.files(), beforeFiles);
  release();
  const state = await h.settled();
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].status, 'complete');
});
