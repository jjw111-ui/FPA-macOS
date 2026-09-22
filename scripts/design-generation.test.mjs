import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { wardrobeStudioApi } from './studio-api.mjs';
import { createDesignGenerationService, geminiDesignGenerate } from './design-generation-api.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const encode = (bytes, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const resultFor = bytes => Response.json({ candidates: [{ content: { parts: [{ text: 'Generated' }, { inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }] }, { headers: { 'x-request-id': 'mock-gemini-request' } });

async function harness(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-design-generation-'));
  const pixel = await sharp({ create: { width: 18, height: 28, channels: 3, background: '#adc8be' } }).png().toBuffer();
  const calls = [], imageCalls = [];
  const studioOptions = {
    env: { OPENAI_API_KEY: 'outfit-only-key', OPENAI_API_BASE_URL: 'http://outfit.mock.invalid/v1', OPENAI_IMAGE_MODEL: 'outfit-only-model', OPENAI_IMAGE_TIMEOUT_MS: '180000', OPENAI_IMAGE_CONCURRENCY: '1' },
    designConfigImportPath: null, designGenerationConfigImportPath: null,
    designFetch: async () => { throw new Error('Unexpected analysis request'); },
    imageEdit: async input => { imageCalls.push(input); return Buffer.from(pixel); },
    designGenerationFetch: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return resultFor(pixel); },
    ...options,
  };
  const servers = []; let server, base;
  async function serve() {
    const plugin = wardrobeStudioApi(studioOptions);
    await plugin.configResolved({ root });
    let handler; plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
    server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server); base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close(current) { if (current.listening) await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); }); }
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${base}/api/studio/${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  async function waitFor(predicate) {
    for (let index = 0; index < 300; index++) {
      const state = (await request('state')).value;
      if (predicate(state)) return state;
      await delay(10);
    }
    throw new Error('Mock job did not settle');
  }
  t.after(async () => { for (const current of servers) await close(current); await rm(root, { recursive: true, force: true }); });
  await serve();
  return {
    root, pixel, calls, imageCalls, request, waitFor,
    input: references => ({ name: '独立设计', prompt: '保留结构', aspectRatio: '3:4', resolution: '2K', references: references || [{ id: 'primary', name: '主体', role: '主体款式参考', regions: [], imageDataUrl: encode(pixel) }] }),
    configure: settings => request('design/generation-settings', { apiKey: 'independent-design-secret-2468', baseUrl: 'http://design.mock.invalid', model: 'user-gemini-model-exact', protocol: 'gemini', ...settings }, 'PATCH'),
    settled: () => waitFor(state => !state.jobs.some(job => ['processing', 'queued'].includes(job.status))),
    async restart() { await close(server); await serve(); },
    async bytes(url) { return Buffer.from(await (await fetch(base + url)).arrayBuffer()); },
  };
}

test('设计独立出图设置从旧生成配置首次导入，保留空白密钥，清空后重启也不再导入', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-design-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = path.join(root, 'studio'), source = path.join(root, 'old-generation.json');
  await mkdir(store);
  await writeFile(source, JSON.stringify([{ name: 'api', api_key: 'synthetic-import-secret-1357', api_base_url: 'https://example.invalid', model: 'original-gemini-model' }]));
  let service = createDesignGenerationService({ importPath: source, fetch: async () => { throw new Error('No generation expected'); } });
  await service.init(store);
  assert.deepEqual(service.settings(), { baseUrl: 'https://example.invalid', model: 'original-gemini-model', protocol: 'gemini', configured: true, maskedKey: '••••1357', imported: true });
  assert.ok(!JSON.stringify(service.settings()).includes('synthetic-import-secret'));
  await service.updateSettings({ apiKey: '  ', model: 'my-edited-model', protocol: 'openai' });
  assert.equal(service.settings().maskedKey, '••••1357');
  await writeFile(source, JSON.stringify([{ name: 'api', api_key: 'different-secret', api_base_url: 'https://other.invalid', model: 'should-not-be-reimported' }]));
  service = createDesignGenerationService({ importPath: source }); await service.init(store);
  assert.equal(service.settings().model, 'my-edited-model'); assert.equal(service.settings().protocol, 'openai'); assert.equal(service.settings().maskedKey, '••••1357');
  await service.updateSettings({ clearKey: true });
  service = createDesignGenerationService({ importPath: source }); await service.init(store);
  assert.equal(service.settings().configured, false); assert.equal(service.settings().maskedKey, '');
  assert.throws(() => service.request(), error => error.status === 503);
});

test('设计生成不依赖全局密钥，使用独立 Gemini 协议发送原图和编号辅助图', { timeout: 15000 }, async t => {
  const h = await harness(t);
  assert.equal((await h.request('design/generate', h.input())).status, 503, '全局搭配配置不能代替独立设计配置');
  const configured = await h.configure();
  assert.equal(configured.status, 200); assert.equal(configured.value.protocol, 'gemini'); assert.equal(configured.value.maskedKey, '••••2468');
  assert.equal((await h.request('design/generation/settings')).value.model, 'user-gemini-model-exact', '兼容两种路由写法');
  const analysis = await h.request('design/settings', { apiKey: 'vision-only-secret', baseUrl: 'http://vision.mock.invalid/v1', model: 'vision-only-model' }, 'PATCH');
  assert.equal(analysis.status, 200);
  await h.request('settings', { clearKey: true }, 'PATCH');
  const original = await sharp(h.pixel).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
  const refs = [{ id: 'primary', name: '原始方向图片', role: '主体款式参考', imageDataUrl: encode(original, 'image/jpeg'), regions: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, part: '领型' }] }];
  const submitted = await h.request('design/generate', h.input(refs));
  assert.equal(submitted.status, 202);
  const state = await h.settled(), job = state.jobs[0], call = h.calls[0];
  assert.equal(job.status, 'complete'); assert.equal(state.configured, false); assert.equal(h.imageCalls.length, 0); assert.equal(h.calls.length, 1);
  assert.equal(call.url, 'http://design.mock.invalid/v1beta/models/user-gemini-model-exact:generateContent');
  assert.equal(call.init.headers.Authorization, 'Bearer independent-design-secret-2468');
  assert.deepEqual(call.body.generationConfig.imageConfig, { aspectRatio: '3:4', imageSize: '2K' });
  assert.deepEqual(call.body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  const parts = call.body.contents[0].parts;
  assert.match(parts[0].text, /R1.1/);
  assert.equal(parts[1].inlineData.mimeType, 'image/jpeg'); assert.deepEqual(Buffer.from(parts[1].inlineData.data, 'base64'), original);
  assert.deepEqual(Buffer.from(parts[2].inlineData.data, 'base64'), await h.bytes(job.designGuide.image));
  assert.equal(parts.length, 3); assert.equal(job.providerModel, 'user-gemini-model-exact'); assert.equal(job.providerProtocol, 'gemini');
  assert.equal(job.requestTimeoutMs, 180000); assert.equal(job.requestId, 'mock-gemini-request');
  assert.equal(job.actualSize, '18x28', '接口返回的小图不放大为 2K');
  assert.equal((await h.request('design/settings')).value.model, 'vision-only-model');
  assert.equal((await h.request('state')).value.settings.model, 'outfit-only-model');
  const beforeCount = state.jobs.length;
  assert.equal((await h.request('design/generate', { ...h.input(), count: 5 })).status, 400);
  assert.equal((await h.request('state')).value.jobs.length, beforeCount); assert.equal(h.calls.length, 1);
});

test('显式 OpenAI 出图协议使用独立 key/model；独立清空密钥不会影响搭配', { timeout: 15000 }, async t => {
  const h = await harness(t);
  await h.configure({ protocol: 'openai', baseUrl: 'http://design-openai.mock.invalid', model: 'my-openai-image-model' });
  await h.request('design/generation-settings', { apiKey: '', model: 'my-openai-image-model' }, 'PATCH');
  assert.equal((await h.request('design/generate', h.input())).status, 202);
  await h.settled();
  assert.equal(h.calls.length, 0); assert.equal(h.imageCalls.length, 1);
  assert.equal(h.imageCalls[0].key, 'independent-design-secret-2468'); assert.equal(h.imageCalls[0].model, 'my-openai-image-model');
  assert.equal(h.imageCalls[0].baseUrl, 'http://design-openai.mock.invalid/v1');
  assert.deepEqual(h.imageCalls[0].images[0].data, h.pixel);
  await h.request('design/generation-settings', { clearKey: true }, 'PATCH');
  assert.equal((await h.request('design/generate', h.input())).status, 503);
  const asset = await h.request('assets', { name: '上衣', part: 'upperbody', imageDataUrl: encode(h.pixel) });
  assert.equal((await h.request('outfits', { assetIds: [asset.value.id] })).status, 202);
  await h.settled();
  assert.equal(h.imageCalls[1].key, 'outfit-only-key'); assert.equal(h.imageCalls[1].model, 'outfit-only-model');
  assert.equal(h.imageCalls[1].baseUrl, 'http://outfit.mock.invalid/v1');
  assert.equal((await h.request('design/generation-settings', { protocol: 'automatic' }, 'PATCH')).status, 400);
});

test('Gemini 面料与配色参考保持原始字节顺序，辅助图排最后，输出参数及独立模型保持原样', { timeout: 15000 }, async t => {
  const h = await harness(t);
  await h.configure({ model: 'user-style-image-model' });
  const fabric = await sharp(h.pixel).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const color = await sharp(h.pixel).webp({ lossless: true }).toBuffer();
  const input = h.input();
  input.references[0].regions = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, part: '领型' }];
  input.references.push({ id: 'fabric', name: '面料', role: '面料参考', imageDataUrl: encode(fabric, 'image/jpeg'), regions: [] }, { id: 'color', name: '色卡', role: '配色参考', imageDataUrl: encode(color, 'image/webp'), regions: [] });
  input.style = { fabric: { mode: 'image' }, color: { mode: 'image' }, colorRatio: '主色 90%', hardware: '黑色五金' };
  input.aspectRatio = '4:5'; input.resolution = '1K'; input.outputFormat = 'jpeg'; input.quality = 'medium'; input.moderation = 'low';
  assert.equal((await h.request('design/generate', input)).status, 202);
  const job = (await h.settled()).jobs[0], call = h.calls[0];
  assert.equal(job.status, 'complete'); assert.equal(job.outputFormat, 'jpeg'); assert.equal(job.quality, 'medium'); assert.equal(job.moderation, 'low');
  assert.equal(job.providerModel, 'user-style-image-model'); assert.equal(job.providerProtocol, 'gemini');
  assert.deepEqual(call.body.generationConfig.imageConfig, { aspectRatio: '4:5', imageSize: '1K' });
  const imageParts = call.body.contents[0].parts.filter(part => part.inlineData);
  assert.equal(imageParts.length, 4);
  assert.deepEqual(imageParts.slice(0, 3).map(part => Buffer.from(part.inlineData.data, 'base64')), [h.pixel, fabric, color]);
  assert.deepEqual(Buffer.from(imageParts[3].inlineData.data, 'base64'), await h.bytes(job.designGuide.image));
  assert.deepEqual(job.designGuide.panels.map(panel => panel.referenceIndex), [1]);
  assert.match(call.body.contents[0].parts[0].text, /配色仅取自 Image 3/);
  assert.match(call.body.contents[0].parts[0].text, /面料仅取自 Image 2/);
  assert.equal(h.imageCalls.length, 0);
});

test('Gemini 服务错误保留请求编号、不自动重试；清空全局密钥后仍能手动重试原快照', { timeout: 15000 }, async t => {
  const calls = []; let success = false, pixel;
  const h = await harness(t, { designGenerationFetch: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return success ? resultFor(pixel) : Response.json({ error: { message: 'Upstream echoed a secret that must not be exposed', status: 'RESOURCE_EXHAUSTED' } }, { status: 503, headers: { 'x-request-id': 'error-503-id' } });
  } });
  pixel = h.pixel;
  await h.configure();
  const submitted = await h.request('design/generate', {...h.input(),resolution:'4K',count:2,safetyPreset:'block_all',googleSearch:true});
  let state = await h.settled();
  const failed = state.jobs.find(job => job.id === submitted.value.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.httpStatus, 503); assert.equal(failed.requestId, 'error-503-id');
  assert.ok(!JSON.stringify(failed).includes('Upstream echoed')); assert.equal(calls.length, 1);
  await h.restart();
  assert.equal(calls.length, 1);
  await h.request('settings', { clearKey: true }, 'PATCH');
  success = true;
  assert.equal((await h.request(`jobs/${failed.id}/retry`, {})).status, 202);
  state = await h.settled();
  assert.equal(state.jobs[0].status, 'complete'); assert.equal(state.jobs[0].attemptCount, 2);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].body, calls[0].body);
});

test('Gemini 4K、多张、安全预设和搜索一次请求提交；返回几张就保存几张，不放大或补发', async t=>{
  const calls=[];let pixel;
  const h=await harness(t,{designGenerationFetch:async(url,init)=>{
    calls.push(JSON.parse(init.body));
    return Response.json({candidates:[0,1].map(()=>({content:{parts:[{inlineData:{mimeType:'image/png',data:pixel.toString('base64')}}]}}))});
  }});pixel=h.pixel;await h.configure();
  const options=(await h.request('design/output-options')).value;
  assert.equal(options.gemini.presets.length,10);assert.deepEqual(options.gemini.resolutions,['1K','2K','4K']);
  assert.deepEqual(options.resolutions,['1K','2K'],'搭配/OpenAI尺寸不扩大');
  const response=await h.request('design/generate',{...h.input(),resolution:'4K',count:3,safetyPreset:'off',googleSearch:true});
  assert.equal(response.status,202);
  const job=(await h.settled()).jobs[0],body=calls[0];
  assert.equal(calls.length,1);assert.equal(body.generationConfig.candidateCount,3);
  assert.deepEqual(body.generationConfig.imageConfig,{aspectRatio:'3:4',imageSize:'4K'});
  assert.deepEqual(body.tools,[{google_search:{searchTypes:{webSearch:{}}}}]);
  assert.equal(body.safetySettings.length,4);assert.ok(body.safetySettings.every(item=>item.threshold==='OFF'));
  assert.equal(job.safetyPreset,'off');assert.equal(job.googleSearch,true);assert.equal(job.resolution,'4K');assert.equal(job.nativeSize,true);
  assert.equal(job.status,'complete');assert.equal(job.images.length,2);assert.deepEqual(job.actualSizes,['18x28','18x28']);
  assert.match(job.sizeNotice,/请求 3 张，接口实际返回 2 张/);assert.match(job.prompt,/目标分辨率 4K/);assert.ok(!job.prompt.includes('目标尺寸'));
  assert.deepEqual(await h.bytes(job.images[0]),pixel);assert.deepEqual(await h.bytes(job.images[1]),pixel);
  await h.request('design/generate',{...h.input(),safetyPreset:'default',googleSearch:false});await h.settled();
  assert.equal(calls.length,2);assert.equal(calls[1].tools,undefined);assert.equal(calls[1].safetySettings,undefined);
});

test('Gemini 参数白名单与协议切换校验在写盘前完成，不向 OpenAI 泄漏搜索或安全字段',async t=>{
  const h=await harness(t);await h.configure();
  const before=await readFile(path.join(h.root,'data/studio/studio.json'),'utf8');
  for(const invalid of [{safetyPreset:'anything'},{googleSearch:'true'},{count:0},{count:1.5},{resolution:'8K'},{aspectRatio:'9:21'}])assert.equal((await h.request('design/generate',{...h.input(),...invalid})).status,400);
  assert.equal(await readFile(path.join(h.root,'data/studio/studio.json'),'utf8'),before);assert.equal(h.calls.length,0);
  await h.configure({protocol:'openai'});
  for(const invalid of [{resolution:'4K'},{safetyPreset:'off'},{googleSearch:true}])assert.equal((await h.request('design/generate',{...h.input(),...invalid})).status,400);
  assert.equal(h.imageCalls.length,0);assert.equal((await h.request('state')).value.jobs.length,0);
});

test('Gemini 超时、中断、413 只返回一次失败，没有协议或模型降级', { timeout: 10000 }, async () => {
  const pixel = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#778877' } }).png().toBuffer();
  const args = { key: 'mock', baseUrl: 'http://unreachable.mock.invalid/v1', model: 'exact-model', prompt: 'mock', aspectRatio: '1:1', resolution: '1K', images: [{ name: 'image.png', data: pixel }], timeoutMs: 20 };
  let calls = 0;
  await assert.rejects(geminiDesignGenerate(args, { fetch: async (url, init) => {
    calls++; assert.match(url, /\/v1beta\/models\/exact-model:generateContent$/);
    return await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } }), error => error.isLocalTimeout === true && error.timeoutMs === 20);
  assert.equal(calls, 1);
  await assert.rejects(geminiDesignGenerate(args, { fetch: async () => { calls++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); } }), error => error.networkCode === 'ECONNRESET' && !error.isLocalTimeout);
  await assert.rejects(geminiDesignGenerate(args, { fetch: async () => { calls++; return new Response('upload limit', { status: 413 }); } }), error => error.status === 413 && error.failureKind === 'input_too_large');
  assert.equal(calls, 3);
});
