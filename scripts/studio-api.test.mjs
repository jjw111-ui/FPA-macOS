import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { wardrobeStudioApi, buildOutfitPrompt } from './studio-api.mjs';
import { openAIEdit } from './import-job-api.mjs';
import { startPortableServer } from './portable-server.mjs';
import { resolveOutputSettings } from '../src/output-settings.mjs';

const outputCases = [
  ['1:1', '1K', '1024x1024'], ['1:1', '2K', '2048x2048'],
  ['4:5', '1K', '1024x1280'], ['4:5', '2K', '1600x2000'],
  ['3:4', '1K', '1152x1536'], ['3:4', '2K', '1536x2048'],
  ['2:3', '1K', '1024x1536'], ['2:3', '2K', '1344x2016'],
  ['9:16', '1K', '864x1536'], ['9:16', '2K', '1152x2048'],
  ['9:21', '1K', '672x1568'], ['9:21', '2K', '1152x2688'],
  ['5:4', '1K', '1280x1024'], ['5:4', '2K', '2000x1600'],
  ['4:3', '1K', '1536x1152'], ['4:3', '2K', '2048x1536'],
  ['3:2', '1K', '1536x1024'], ['3:2', '2K', '2016x1344'],
  ['16:9', '1K', '1536x864'], ['16:9', '2K', '2048x1152'],
  ['21:9', '1K', '1568x672'], ['21:9', '2K', '2688x1152'],
];

test('分辨率与比例映射、旧记录还原和非法输入', () => {
  assert.deepEqual(resolveOutputSettings(), { aspectRatio: '2:3', resolution: '1K', size: '1024x1536' });
  for (const [aspectRatio, resolution, size] of outputCases) {
    const expected = { aspectRatio, resolution, size };
    assert.deepEqual(resolveOutputSettings({ aspectRatio, resolution }), expected);
    assert.deepEqual(resolveOutputSettings({ size }), expected, '旧记录仅有 size 时也能还原');
    assert.deepEqual(resolveOutputSettings(expected), expected);
  }
  assert.equal(resolveOutputSettings({ size: '1024x1536', resolution: '2K' }).size, '1344x2016');
  assert.deepEqual(resolveOutputSettings({ size: '2048x3072' }), { aspectRatio: '2:3', resolution: '2K', size: '1344x2016' }, '旧版超大尺寸迁移到正确 2K');
  assert.deepEqual(resolveOutputSettings({ size: '3072x2048' }), { aspectRatio: '3:2', resolution: '2K', size: '2016x1344' }, '旧版横图超大尺寸迁移到正确 2K');
  for (const input of [{ resolution: '4K' }, { resolution: '2k' }, { resolution: 2048 }, { aspectRatio: '7:5' }, { size: 'auto' }]) {
    assert.throws(() => resolveOutputSettings(input), /请选择/);
  }
});

test('二十二种尺寸实际传入编辑器，2K 重试与持久化，记录原始返回尺寸且不放大', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wardrobe-resolution-test-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });
  const pixel = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#60704b' } }).png().toBuffer();
  const square = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#60704b' } }).png().toBuffer();
  const calls = [];
  let failNext = false;
  const options = {
    env: { OPENAI_API_KEY: 'local-test-key', WARDROBE_DATA_DIR: 'data', OPENAI_IMAGE_MODEL: 'gpt-image-2', OPENAI_IMAGE_CONCURRENCY: '1' },
    imageEdit: async args => {
      calls.push(args);
      if (failNext) { failNext = false; throw new Error('test failure'); }
      const outputs = Array.from({ length: args.count || 1 }, () => {
        const result = Buffer.from(args.size === '1024x1024' ? square : pixel);
        Object.defineProperties(result, { requestId: { value: 'local-request-id' }, httpStatus: { value: 200 } });
        return result;
      });
      return outputs.length === 1 ? outputs[0] : outputs;
    },
  };
  async function serve() {
    const plugin = wardrobeStudioApi(options); await plugin.configResolved({ root });
    let handler; plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
    const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  let service = await serve();
  async function request(route, data) {
    const response = await fetch(`${service.base}/api/studio/${route}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, value: await response.json() };
  }
  async function settled() {
    for (let n = 0; n < 200; n++) {
      const state = (await request('state')).value;
      if (!state.jobs.some(j => ['queued', 'processing'].includes(j.status))) return state;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('queue did not complete');
  }
  const asset = (await request('assets', { name: '分辨率测试上衣', part: 'upperbody', imageDataUrl: `data:image/png;base64,${pixel.toString('base64')}` })).value;
  const assetIds = [asset.id];
  for (const settings of [{ resolution: '4K' }, { aspectRatio: '7:5' }, { size: 'bad' }, { count: 0 }, { count: 5 }, { outputFormat: 'gif' }, { moderation: 'high' }, { quality: 'ultra' }]) {
    const result = await request('outfits', { assetIds, ...settings });
    assert.equal(result.status, 400); assert.match(result.value.error, /请选择/);
  }
  assert.equal(calls.length, 0, '无效尺寸不会消耗生成额度');
  assert.equal((await request('state')).value.jobs.length, 0);
  const jobIds = [];
  for (const [aspectRatio, resolution, size] of outputCases) {
    const result = await request('outfits', { assetIds, aspectRatio, resolution });
    assert.equal(result.status, 202);
    assert.equal(result.value.size, size);
    jobIds.push(result.value.id);
  }
  let state = await settled();
  assert.deepEqual(calls.map(call => call.size), outputCases.map(row => row[2]));
  for (const [index, [aspectRatio, resolution, size]] of outputCases.entries()) {
    const job = state.jobs.find(job => job.id === jobIds[index]);
    assert.equal(job.status, 'complete');
    assert.equal(job.requestId, 'local-request-id'); assert.equal(job.httpStatus, 200); assert.equal(job.requestTimeoutMs, 300000);
    assert.deepEqual(resolveOutputSettings(job), { aspectRatio, resolution, size });
    assert.equal(job.actualSize, size === '1024x1024' ? size : '32x48');
    if (size === '1024x1024') assert.equal(job.sizeNotice, null);
    else assert.match(job.sizeNotice, /接口实际返回 32 × 48/);
    const saved = Buffer.from(await (await fetch(service.base + job.image)).arrayBuffer());
    const metadata = await sharp(saved).metadata();
    assert.equal(`${metadata.width}x${metadata.height}`, job.actualSize, '保留原生像素尺寸，不拉伸成请求的 2K');
    const source = size === '1024x1024' ? square : pixel;
    assert.deepEqual(await sharp(saved).raw().toBuffer(), await sharp(source).raw().toBuffer());
  }
  const multi = await request('outfits', { assetIds, aspectRatio: '2:3', resolution: '2K', quality: 'auto', count: 4, outputFormat: 'jpeg', moderation: 'low' });
  assert.equal(multi.status, 202);
  state = await settled();
  const multiJob = state.jobs.find(job => job.id === multi.value.id);
  assert.equal(calls.at(-1).count, 4); assert.equal(calls.at(-1).outputFormat, 'jpeg'); assert.equal(calls.at(-1).moderation, 'low'); assert.equal(calls.at(-1).quality, 'auto');
  assert.equal(multiJob.images.length, 4); assert.equal(multiJob.actualSizes.length, 4); assert.equal(multiJob.image, multiJob.images[0]);
  for (const image of multiJob.images) {
    const response = await fetch(service.base + image);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format, 'jpeg');
  }
  const webp = await request('outfits', { assetIds, outputFormat: 'webp' });
  state = await settled();
  const webpJob = state.jobs.find(job => job.id === webp.value.id);
  const webpResponse = await fetch(service.base + webpJob.image);
  assert.equal(webpResponse.headers.get('content-type'), 'image/webp');
  assert.equal((await sharp(Buffer.from(await webpResponse.arrayBuffer())).metadata()).format, 'webp');
  const legacy = await request('outfits', { assetIds, size: '1536x1024' });
  await settled();
  assert.equal(legacy.value.resolution, '1K'); assert.equal(legacy.value.aspectRatio, '3:2');
  assert.equal(calls.at(-1).size, '1536x1024');
  const oversizedLegacy = await request('outfits', { assetIds, size: '2048x3072' });
  await settled();
  assert.equal(oversizedLegacy.value.size, '1344x2016'); assert.equal(calls.at(-1).size, '1344x2016');
  failNext = true;
  const failed = (await request('outfits', { assetIds, aspectRatio: '2:3', resolution: '2K' })).value;
  state = await settled();
  assert.equal(state.jobs.find(job => job.id === failed.id).status, 'failed');
  await new Promise(resolve => { service.server.close(resolve); service.server.closeAllConnections(); });
  service = await serve();
  const callCount = calls.length;
  state = (await request('state')).value;
  assert.equal(state.jobs.find(job => job.id === failed.id).resolution, '2K');
  assert.equal(state.jobs.find(job => job.id === jobIds[1]).actualSize, '32x48');
  assert.equal(calls.length, callCount, '重启不自动重发或降级 2K 请求');
  assert.equal((await request(`jobs/${failed.id}/retry`, {})).status, 202);
  state = await settled();
  assert.equal(state.jobs.find(job => job.id === failed.id).status, 'complete');
  assert.equal(calls.at(-1).size, '1344x2016');
  assert.equal(calls.length, callCount + 1, '手动重试仅调用一次，不额外放大生成');
});

test('图像接口以 multipart size 发送全部 1K / 2K 尺寸，不请求真实服务', async t => {
  const pixel = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#60704b' } }).png().toBuffer();
  const received = [];
  let delayNext = false;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
      const count = Number(form.get('n'));
      received.push({ url: req.url, method: req.method, size: form.get('size'), model: form.get('model'), quality: form.get('quality'), count, outputFormat: form.get('output_format'), moderation: form.get('moderation'), imageCount: form.getAll('image[]').length });
      if (delayNext) { delayNext = false; await new Promise(resolve => setTimeout(resolve, 100)); }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('x-request-id', 'local-transport-request');
      res.end(JSON.stringify({ data: Array.from({ length: count }, () => ({ b64_json: pixel.toString('base64') })) }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const [, , size] of outputCases) {
  const result = await openAIEdit({ key: 'local-test-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'gpt-image-2', size, images: [{ name: 'test.png', data: pixel }], prompt: 'Local transport test' });
    assert.deepEqual(result, pixel);
    assert.equal(result.requestId, 'local-transport-request'); assert.equal(result.httpStatus, 200);
  }
  assert.deepEqual(received, outputCases.map(([, , size]) => ({ url: '/v1/images/edits', method: 'POST', size, model: 'gpt-image-2', quality: 'high', count: 1, outputFormat: 'png', moderation: 'auto', imageCount: 1 })));
  const multiple = await openAIEdit({ key: 'local-test-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'gpt-image-2', quality: 'auto', count: 4, outputFormat: 'webp', moderation: 'low', size: '1344x2016', images: [{ name: 'test.png', data: pixel }], prompt: 'Local multi-output test' });
  assert.equal(multiple.length, 4);
  assert.deepEqual(received.at(-1), { url: '/v1/images/edits', method: 'POST', size: '1344x2016', model: 'gpt-image-2', quality: 'auto', count: 4, outputFormat: 'webp', moderation: 'low', imageCount: 1 });
  delayNext = true;
  await assert.rejects(
    openAIEdit({ key: 'local-test-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'gpt-image-2', size: '1344x2016', images: [{ name: 'test.png', data: pixel }], prompt: 'Local timeout test', timeoutMs: 25 }),
    error => error.isLocalTimeout === true && error.timeoutMs === 25,
  );
});

test('OpenLux 严格使用用户填写的模型，不自动切换且按模型过滤扩展参数', async t => {
  const pixel = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#60704b' } }).png().toBuffer();
  const originalFetch = globalThis.fetch;
  let captured;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    const form = init.body;
    captured = {
      url,
      model: form.get('model'),
      prompt: form.get('prompt'),
      n: form.get('n'),
      responseFormat: form.get('response_format'),
      size: form.get('size'),
      format: form.get('format'),
      outputFormat: form.get('output_format'),
      quality: form.get('quality'),
      moderation: form.get('moderation'),
      imageCount: form.getAll('image').length,
    };
    return new Response(JSON.stringify({ data: [{ b64_json: pixel.toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'openlux-model-test' },
    });
  };
  const images = [{ name: 'one.png', data: pixel }, { name: 'two.png', data: pixel }];
  const result = await openAIEdit({
    key: 'local-test-key', baseUrl: 'https://api.openlux.ai/v1', model: 'gpt-image-2',
    prompt: 'exact model test', images, size: '1344x2016', outputFormat: 'webp', quality: 'high', moderation: 'low',
  });
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(captured, {
    url: 'https://api.openlux.ai/v1/images/edits', model: 'gpt-image-2', prompt: 'exact model test', n: '1', responseFormat: 'b64_json',
    size: null, format: null, outputFormat: null, quality: null, moderation: null, imageCount: 2,
  });
});

test('素材直传、旧衣橱兼容、搭配队列、重试和持久化', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wardrobe-studio-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pixel = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#60704b' } }).png().toBuffer();
  const imageDataUrl = `data:image/png;base64,${pixel.toString('base64')}`;
  const original = [{ id: 'import-legacy', name: '旧上衣', part: 'upperbody', image: '/api/import/library/legacy.png' }];
  await mkdir(path.join(root, 'data/imported'), { recursive: true });
  await writeFile(path.join(root, 'data/library.json'), JSON.stringify(original));
  await writeFile(path.join(root, 'data/imported/legacy.png'), pixel);
  let calls = [], inflight = 0, maxInflight = 0, shouldFail = false;
  const env = { OPENAI_API_KEY: 'test-only-key', OPENAI_API_BASE_URL: 'http://unused.invalid/v1', OPENAI_IMAGE_CONCURRENCY: '1' };
  const options = { env, imageEdit: async args => {
    inflight++; maxInflight = Math.max(maxInflight, inflight); calls.push(args);
    try { await new Promise(r => setTimeout(r, 35)); if (shouldFail) { shouldFail = false; throw new Error('upstream saturated'); } return pixel; } finally { inflight--; }
  } };
  async function serve() {
    const plugin = wardrobeStudioApi(options); await plugin.configResolved({ root });
    let handler; plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
    const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return { server, base: `http://127.0.0.1:${server.address().port}/api/studio/` };
  }
  let service = await serve();
  async function request(route, data, method = data ? 'POST' : 'GET') {
    const r = await fetch(service.base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: r.status, value: await r.json() };
  }
  async function settled() {
    for (let n = 0; n < 120; n++) { const state = (await request('state')).value; if (!state.jobs.some(j => ['queued', 'processing'].includes(j.status))) return state; await new Promise(r => setTimeout(r, 15)); } throw new Error('queue did not complete');
  }
  assert.equal((await request('state')).value.assets[0].name, '旧上衣');
  env.OPENAI_API_KEY = ' '; // Direct import must not require an API key or person reference.
  const top = (await request('assets', { name: '绿色上衣', part: 'upperbody', imageDataUrl, mode: 'original' })).value;
  assert.ok(top.id); assert.equal(calls.length, 0);
  assert.equal((await request('assets', { part: 'upperbody', imageDataUrl, mode: 'clean' })).status, 503);
  assert.equal((await request('assets', { part: 'face', imageDataUrl, mode: 'fullbody' })).status, 410);
  assert.equal((await request('assets', { part: '../bad', imageDataUrl })).status, 400);
  assert.equal((await request('assets', { part: 'face', imageDataUrl: 'data:image/png;base64,AAAA' })).status, 400);
  env.OPENAI_API_KEY = 'test-only-key';
  const face = (await request('assets', { name: '人脸', part: 'face', imageDataUrl })).value;
  const generatedFace = (await request('assets', { name: '生成人脸', part: 'face', imageDataUrl, mode: 'face' })).value;
  const generatedFaceState = (await settled()).assets.find(asset => asset.id === generatedFace.id);
  assert.ok(generatedFaceState.faceImage, '人脸上传选择生成正脸后应保存正脸参考图');
  assert.equal(generatedFaceState.originalImage, generatedFace.image, '生成正脸不应覆盖上传原图');
  const pose = (await request('assets', { name: '动作', part: 'pose', notes: '只用动作', imageDataUrl })).value;
  const body = (await request('assets', { name: '体型', part: 'person', imageDataUrl })).value;
  const pants = (await request('assets', { name: '裤子', part: 'lowerbody', imageDataUrl })).value;
  const innerLayer = (await request('assets', { name: '白色内搭', part: 'dress', imageDataUrl })).value;
  const secondInnerLayer = (await request('assets', { name: '黑色内搭', part: 'dress', imageDataUrl })).value;
  const accessory = (await request('assets', { name: '包', part: 'accessories_up', imageDataUrl })).value;
  const scene = (await request('assets', { name: '城市街景', part: 'scene', notes: '只参考背景和光线', imageDataUrl })).value;
  assert.equal((await request('assets', { name: '错误正脸', part: 'person', imageDataUrl, mode: 'face' })).status, 400);
  const input = { name: '测试搭配', assetIds: [top.id, pants.id, innerLayer.id, face.id, pose.id, body.id, accessory.id, scene.id], size: '1024x1536', scene: '摄影棚' };
  assert.equal((await request('outfits', { ...input, assetIds: [face.id] })).status, 400);
  assert.equal((await request('outfits', { ...input, assetIds: [top.id, top.id] })).status, 400);
  assert.equal((await request('outfits', { ...input, assetIds: [top.id, 'import-legacy'] })).status, 400);
  const duplicateInnerLayers = await request('outfits', { ...input, assetIds: [innerLayer.id, secondInnerLayer.id] });
  assert.equal(duplicateInnerLayers.status, 400);
  assert.match(duplicateInnerLayers.value.error, /内搭只能选择一个/);
  assert.equal((await request('outfits', { ...input, size: 'bad' })).status, 400);
  const submitted = await Promise.all([request('outfits', input), request('outfits', { ...input, name: '第二套' })]);
  assert.ok(submitted.every(result => result.status === 202), '内搭应能与上衣和下装同时提交');
  let state = await settled(); assert.equal(state.jobs.filter(j => j.status === 'complete').length, 3); assert.equal(maxInflight, 1);
  const outfitCall = calls.find(call => call.images.length === 8);
  assert.ok(outfitCall); assert.equal(outfitCall.size, input.size);
  assert.match(outfitCall.prompt, /Pose, limb placement and camera angle ONLY/); assert.match(outfitCall.prompt, /Body proportions only/);
  assert.match(outfitCall.prompt, /REFERENCE PRIORITY AND ISOLATION/);
  assert.match(outfitCall.prompt, /Clothing, accessories, logos, colors, lighting and backgrounds visible in person or pose references are forbidden/);
  assert.match(outfitCall.prompt, /Never use a person\/pose reference to fill, replace or complete a clothing slot/);
  assert.match(outfitCall.prompt, /FINAL CHECK BEFORE OUTPUT/);
  assert.match(outfitCall.prompt, /WARDROBE SOURCE LOCK/);
  assert.match(outfitCall.prompt, /erase all of those visually before dressing the model/);
  assert.match(outfitCall.prompt, /Scene, background, lighting and environment ONLY/);
  assert.match(outfitCall.prompt, /selected scene reference for the background/);
  assert.match(outfitCall.prompt, /Exact 内搭 product only/);
  assert.match(outfitCall.prompt, /inner layer \(内搭\) underneath any selected top and outerwear/);
  assert.match(outfitCall.prompt, /Do not replace the selected top or trousers with the inner layer/);
  assert.equal(state.assets.find(asset => asset.id === innerLayer.id).part, 'dress', '内搭应保留旧分类键以兼容现有素材');
  assert.equal((await fetch(service.base.replace('/api/studio/', '') + state.jobs[0].image)).status, 200);
  shouldFail = true; const failed = (await request('outfits', input)).value; state = await settled();
  assert.match(state.jobs.find(j => j.id === failed.id).error, /服务繁忙/);
  assert.equal((await request(`jobs/${failed.id}/retry`, {})).status, 202); state = await settled();
  assert.equal(state.jobs.find(j => j.id === failed.id).status, 'complete');
  await request(`assets/${top.id}/clean`, {}); state = await settled();
  const cleaned = state.assets.find(a => a.id === top.id); assert.ok(cleaned.cleanedImage); assert.equal(cleaned.originalImage, top.image);
  const sceneSource = await sharp({ create: { width: 1080, height: 1351, channels: 3, background: '#c8b9aa' } }).png().toBuffer();
  const sceneSourceDataUrl = `data:image/png;base64,${sceneSource.toString('base64')}`;
  const sceneCallIndex = calls.length;
  const generatedScene = (await request('assets', { name: '街景原图', part: 'scene', notes: '保持原色', imageDataUrl: sceneSourceDataUrl, mode: 'scene' })).value;
  state = await settled();
  const sceneJob = state.jobs.find(job => job.assetId === generatedScene.id);
  const storedScene = state.assets.find(asset => asset.id === generatedScene.id);
  assert.equal(sceneJob.kind, 'scene');
  assert.equal(sceneJob.name, '街景原图 · 场景提取');
  assert.equal(sceneJob.size, '1024x1280', '1080x1351 应使用最接近的 4:5 请求比例');
  assert.equal(sceneJob.sourceSize, '1080x1351');
  assert.equal(sceneJob.actualSize, '1080x1351', '纯场景图应恢复为原图精确尺寸');
  assert.equal(calls[sceneCallIndex].size, '1024x1280');
  assert.match(calls[sceneCallIndex].prompt, /pixel-faithful background cleanup/);
  assert.match(calls[sceneCallIndex].prompt, /Do not recolor, relight, restyle/);
  assert.ok(storedScene.sceneImage);
  assert.equal(storedScene.image, storedScene.sceneImage);
  assert.equal(storedScene.originalImage, generatedScene.originalImage, '生成纯场景图时必须保留上传原图');
  const sceneBytes = Buffer.from(await (await fetch(service.base.replace('/api/studio/', '') + storedScene.sceneImage)).arrayBuffer());
  const sceneMetadata = await sharp(sceneBytes).metadata();
  assert.deepEqual([sceneMetadata.width, sceneMetadata.height], [1080, 1351]);
  assert.equal((await request(`assets/${generatedScene.id}/clean`, {})).status, 400, '场景不能再误走单品整理');
  const originalSceneVersion = await request(`assets/${generatedScene.id}`, { part: 'scene', imageVersion: 'original' }, 'PATCH');
  assert.equal(originalSceneVersion.value.image, storedScene.originalImage);
  const generatedSceneVersion = await request(`assets/${generatedScene.id}`, { part: 'scene', imageVersion: 'scene' }, 'PATCH');
  assert.equal(generatedSceneVersion.value.image, storedScene.sceneImage);
  const restored = await request(`assets/${top.id}`, { part: 'upperbody', imageVersion: 'original' }, 'PATCH');
  assert.equal(restored.value.image, top.image);
  await request(`assets/${top.id}`, { name: '新名称', part: 'wholebody_up', notes: '外套' }, 'PATCH');
  await request(`assets/${face.id}`, undefined, 'DELETE');
  await request('assets/import-legacy', { name: '旧衣服新名称', part: 'upperbody' }, 'PATCH');
  await request('assets/import-legacy', undefined, 'DELETE');
  state = (await request('state')).value;
  assert.ok(!state.assets.some(a => a.id === face.id || a.id === 'import-legacy'));
  assert.ok(state.jobs[1].references.length); assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data/library.json'))), original);
  await new Promise(resolve => { service.server.close(resolve); service.server.closeAllConnections(); });
  service = await serve(); state = (await request('state')).value;
  assert.equal(state.assets.find(a => a.id === top.id).name, '新名称'); assert.ok(state.jobs.length >= 4);
  assert.equal((await fetch(service.base.replace('/api/studio/', '') + face.image)).status, 200, 'archiving preserves historical references');

  const baseline = calls.length;
  env.OPENAI_API_KEY = ' ';
  for (const part of ['face', 'person', 'pose']) {
    const result = await request('assets', { part, name: '直接上传人物参考', imageDataUrl, mode: 'original' });
    assert.equal(result.status, 201);
    assert.equal(result.value.image, result.value.originalImage);
    assert.equal((await request('assets', { part, imageDataUrl, mode: 'fullbody' })).status, 410);
    assert.equal((await request(`assets/${result.value.id}/fullbody`, {})).status, 410);
    assert.equal((await request('assets', { part, imageDataUrl, mode: 'clean' })).status, 400);
  }
  assert.equal(calls.length, baseline, 'person uploads and removed endpoints never invoke the image API');
  env.OPENAI_API_KEY = 'test-only-key';

  await new Promise(resolve => { service.server.close(resolve); service.server.closeAllConnections(); });
  const dbPath = path.join(root, 'data/studio/studio.json');
  const persisted = JSON.parse(await readFile(dbPath, 'utf8'));
  const historicalId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const failedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  persisted.jobs.push(
    { id: historicalId, kind: 'fullbody', status: 'complete', image: top.image, references: [body] },
    { id: failedId, kind: 'fullbody', status: 'failed', references: [body] }
  );
  persisted.assets.find(a => a.id === body.id).fullBodyImage = top.image;
  await writeFile(dbPath, JSON.stringify(persisted));
  service = await serve();
  state = (await request('state')).value;
  assert.ok(state.jobs.some(j => j.id === historicalId && j.image === top.image));
  assert.equal((await fetch(service.base.replace('/api/studio/', '') + top.image)).status, 200);
  assert.equal((await request(`jobs/${failedId}/retry`, {})).status, 410);
  assert.equal(calls.length, baseline);
  const historicalVersion = await request(`assets/${body.id}`, { part: 'person', imageVersion: 'fullbody' }, 'PATCH');
  assert.equal(historicalVersion.value.image, top.image, 'historical images remain selectable without generating');
});

test('提示词区分人脸、体型、姿势；不选人物时使用虚构模特', () => {
  const prompt = buildOutfitPrompt([{ id: 'a', part: 'upperbody', name: '上衣' }], {});
  assert.match(prompt, /fictional adult model/); assert.match(prompt, /Ignore its wearer and background/);
});

test('体型来自所选人物体型，人脸即便是旧全身图也只提供身份', () => {
  const face = { id: 'face', part: 'face', name: '人脸', image: '/old.png', fullBodyImage: '/old.png' };
  const body = { id: 'body', part: 'person', name: '上传体型' };
  const prompt = buildOutfitPrompt([face, body], {});
  assert.match(prompt, /Only facial identity and hair/);
  assert.match(prompt, /Do not borrow body proportions/);
  assert.match(prompt, /Body proportions only; facial identity comes from the face reference/);
  assert.match(prompt, /head-to-body ratio, shoulder width, torso length and leg proportions/);
  assert.doesNotMatch(prompt, /body proportions from this full-body reference/);
  assert.match(buildOutfitPrompt([body], {}), /Identity, hair and body proportions only/);
});

test('本地设置、无费用连接检测、画质、取消、归档、删除和中断恢复', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wardrobe-delivery-test-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      if (!server.listening) continue;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
    await rm(root, { recursive: true, force: true });
  });

  const pixel = await sharp({ create: { width: 24, height: 36, channels: 3, background: '#687a4d' } }).png().toBuffer();
  const imageDataUrl = `data:image/png;base64,${pixel.toString('base64')}`;
  let modelRequest;
  const modelServer = createServer((req, res) => {
    modelRequest = { url: req.url, authorization: req.headers.authorization };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('x-request-id', 'models-check-id');
    res.end(JSON.stringify({ data: [{ id: 'local-image-model' }] }));
  });
  servers.push(modelServer);
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));

  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const options = {
    env: {},
    imageEdit: async args => {
      calls.push(args);
      if (calls.length === 1) await firstGate;
      return pixel;
    },
  };

  async function serve() {
    const plugin = wardrobeStudioApi(options);
    await plugin.configResolved({ root });
    let handler;
    plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
    const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}/api/studio/` };
  }

  let service = await serve();
  async function request(route, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(service.base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, value: await response.json() };
  }

  const secret = 'delivery-secret-1234';
  const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  const saved = await request('settings', {
    apiKey: secret,
    baseUrl,
    model: 'local-image-model',
    quality: 'medium',
    timeoutMinutes: 5,
    concurrency: 1,
  }, 'PATCH');
  assert.equal(saved.status, 200);
  assert.equal(saved.value.maskedKey, '••••1234');
  assert.equal(saved.value.quality, 'medium');
  assert.equal(saved.value.timeoutMinutes, 5);
  assert.equal(Object.hasOwn(saved.value, 'apiKey'), false);
  const publicState = (await request('state')).value;
  assert.equal(JSON.stringify(publicState).includes(secret), false, '状态接口不得泄露完整密钥');
  const settingsFile = JSON.parse(await readFile(path.join(root, 'data/studio/settings.json'), 'utf8'));
  assert.equal(settingsFile.OPENAI_API_KEY, secret, '密钥仅保存在本地设置文件');

  const connection = await request('settings/test', {}, 'POST');
  assert.equal(connection.status, 200);
  assert.equal(connection.value.modelAvailable, true);
  assert.equal(connection.value.requestId, 'models-check-id');
  assert.deepEqual(modelRequest, { url: '/v1/models', authorization: `Bearer ${secret}` });
  assert.equal(calls.length, 0, '连接检测不得调用生图接口');

  const asset = (await request('assets', { name: '测试上衣', part: 'upperbody', imageDataUrl }, 'POST')).value;
  const first = (await request('outfits', { name: '标准画质', assetIds: [asset.id], quality: 'medium' }, 'POST')).value;
  for (let count = 0; count < 100 && calls.length === 0; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].quality, 'medium');
  assert.equal(calls[0].timeoutMs, 300000);

  const second = (await request('outfits', { name: '待取消', assetIds: [asset.id], quality: 'low' }, 'POST')).value;
  let state = (await request('state')).value;
  assert.equal(state.jobs.find(job => job.id === second.id).queuePosition, 1);
  assert.equal((await request(`jobs/${second.id}/cancel`, {}, 'POST')).status, 200);
  releaseFirst();
  for (let count = 0; count < 150; count++) {
    state = (await request('state')).value;
    if (!state.jobs.some(job => ['queued', 'processing'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(calls.length, 1, '取消的排队任务不得调用生图接口');
  assert.equal(state.jobs.find(job => job.id === first.id).status, 'complete');
  assert.equal(state.jobs.find(job => job.id === second.id).status, 'cancelled');

  assert.equal((await request(`jobs/${first.id}/archive`, { archived: true }, 'PATCH')).value.archived, true);
  assert.equal((await request(`jobs/${first.id}/archive`, { archived: false }, 'PATCH')).value.archived, false);
  assert.equal((await request(`jobs/${second.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await request('state')).value.jobs.some(job => job.id === second.id), false);

  await new Promise(resolve => { service.server.close(resolve); service.server.closeAllConnections(); });
  const dbPath = path.join(root, 'data/studio/studio.json');
  const persisted = JSON.parse(await readFile(dbPath, 'utf8'));
  const interruptedId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  persisted.jobs.push({
    id: interruptedId,
    kind: 'outfit',
    name: '重启中的任务',
    references: [asset],
    size: '1024x1536',
    aspectRatio: '2:3',
    resolution: '1K',
    quality: 'high',
    status: 'processing',
    createdAt: new Date().toISOString(),
  });
  await writeFile(dbPath, JSON.stringify(persisted));
  const callCount = calls.length;
  service = await serve();
  state = (await request('state')).value;
  const interrupted = state.jobs.find(job => job.id === interruptedId);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.resultUncertain, true);
  assert.equal(interrupted.failureKind, 'interrupted');
  assert.match(interrupted.error, /可能已扣费/);
  assert.equal(calls.length, callCount, '重启不得自动重发已进入处理中的请求');
});

test('便携服务器提供生产页面、本地 API、SPA 回退和旧素材', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-portable-server-test-'));
  const distDir = path.join(root, 'dist');
  const dataDir = path.join(root, 'portable-data');
  await mkdir(path.join(dataDir, 'imported'), { recursive: true });
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>FPA portable test</title><main>ready</main>');
  const legacy = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#556644' } }).png().toBuffer();
  await writeFile(path.join(dataDir, 'imported', 'legacy.png'), legacy);
  const service = await startPortableServer({ appRoot: root, distDir, dataDir, port: 5260, imageEdit: async () => legacy });
  t.after(async () => {
    if (service.server.listening) await new Promise(resolve => { service.server.close(resolve); service.server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });

  const home = await fetch(service.url);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /FPA portable test/);
  const fallback = await fetch(`${service.url}history/local-route`);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /FPA portable test/);
  const health = await (await fetch(`${service.url}api/studio/health`)).json();
  assert.deepEqual(health, { ok: true, app: 'fpa-local', version: 1 });
  const oldImage = Buffer.from(await (await fetch(`${service.url}api/import/library/legacy.png`)).arrayBuffer());
  assert.deepEqual(oldImage, legacy);

  const gzippedHome = await fetch(service.url, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gzippedHome.status, 200);
  assert.equal(gzippedHome.headers.get('content-encoding'), 'gzip');

  const testImg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#112233' } }).png().toBuffer();
  const assetRes = await fetch(`${service.url}api/studio/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试素材', part: 'upperbody', mode: 'original', imageDataUrl: `data:image/png;base64,${testImg.toString('base64')}` }),
  });
  assert.equal(assetRes.status, 201);
  const assetData = await assetRes.json();
  const fullImgRes = await fetch(`${service.url}${assetData.image.replace(/^\//, '')}`);
  assert.equal(fullImgRes.status, 200);
  assert.equal(fullImgRes.headers.get('content-type'), 'image/png');
  const thumbImgRes = await fetch(`${service.url}${assetData.image.replace(/^\//, '')}?w=thumb`);
  assert.equal(thumbImgRes.status, 200);
  assert.equal(thumbImgRes.headers.get('content-type'), 'image/webp');
  const thumbBuffer = Buffer.from(await thumbImgRes.arrayBuffer());
  const thumbMeta = await sharp(thumbBuffer).metadata();
  assert.equal(thumbMeta.format, 'webp');
  assert(thumbMeta.width <= 320 && thumbMeta.height <= 320);
});

