import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createQuiverService, quiverImage, safeQuiverSvg, QUIVER_TIMEOUT_MS } from './quiver-api.mjs';
import { wardrobeStudioApi } from './studio-api.mjs';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180" viewBox="0 0 120 180"><rect width="120" height="180" fill="white"/><path d="M20 10H100L95 170H70L60 90L50 170H25Z" fill="none" stroke="black"/></svg>';
const temp = async t => { const directory = await mkdtemp(path.join(os.tmpdir(), 'fpa-quiver-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };

test('Quiver 保存独立设置、掩码密钥和默认参数，连接检查不出图', async t => {
  const directory = await temp(t), calls = [];
  const service = createQuiverService({ fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ data: [{ id: 'arrow-2', supported_operations: ['svgs.generations'] }] }); } });
  await service.init(directory);
  assert.throws(() => service.request(), /系统设置/);
  await service.updateSettings({ baseUrl: 'https://api.quiver.ai', apiKey: 'test-secret-1234', model: 'arrow-2', reasoningEffort: 'xhigh' });
  await service.updateSettings({ apiKey: '  ' });
  assert.equal(service.settings().maskedKey, '••••1234');
  assert.ok(!JSON.stringify(service.settings()).includes('test-secret'));
  assert.equal((await service.test()).models[0].id, 'arrow-2');
  assert.equal(calls[0].url, 'https://api.quiver.ai/v1/models');
  assert.equal(calls[0].init.body, undefined);
  const restored = createQuiverService(); await restored.init(directory);
  assert.equal(restored.request().model, 'arrow-2'); assert.equal(restored.request().reasoningEffort, 'xhigh');
  await assert.rejects(restored.updateSettings({ model: 'unknown' }), /模型/);
  await restored.updateSettings({ clearKey: true }); assert.throws(() => restored.request(), /系统设置/);
});

test('Quiver 默认允许最长等待 10 分钟', () => {
  assert.equal(QUIVER_TIMEOUT_MS, 600000);
});

test('Quiver 保留可发送原图，只缩小超限副本；SVG 支持标准命名空间并阻止主动内容', async () => {
  const original = await sharp({ create: { width: 20, height: 30, channels: 3, background: 'white' } }).png().toBuffer();
  assert.equal(await quiverImage(original), original);
  const large = await sharp({ create: { width: 4400, height: 2200, channels: 3, background: 'white' } }).png().toBuffer();
  const resized = await quiverImage(large), meta = await sharp(resized).metadata();
  assert.equal(meta.width, 4096); assert.equal(meta.height, 2048); assert.equal((await sharp(large).metadata()).width, 4400);
  assert.equal(safeQuiverSvg(svg.replace('<svg ', '<svg xmlns:xlink="https://www.w3.org/1999/xlink" ')), svg.replace('<svg ', '<svg xmlns:xlink="https://www.w3.org/1999/xlink" '));
  assert.equal(safeQuiverSvg(svg.replace('</svg>', '<defs><path id="ink" d="M0 0h1"/></defs><use href="#ink"/></svg>')), /<use href="#ink"/.test(svg.replace('</svg>', '<defs><path id="ink" d="M0 0h1"/></defs><use href="#ink"/></svg>')) ? svg.replace('</svg>', '<defs><path id="ink" d="M0 0h1"/></defs><use href="#ink"/></svg>') : '');
  for (const body of ['<script>alert(1)</script>', '<image href="https://example.com/a.png"/>', '<foreignObject/>', '<g onclick="foo()"/>', '<!DOCTYPE svg>', '<style>@import "x"</style>', '<path style="fill:url(https://example.com/x)"/>']) assert.throws(() => safeQuiverSvg(svg.replace('</svg>', `${body}</svg>`)), /不支持/);
});

test('Quiver 队列出图、原图保留、SVG 下载、参数重试与删除独立于其他接口', async t => {
  const root = await temp(t), calls = []; let fail = false;
  const plugin = wardrobeStudioApi({ env: {}, designConfigImportPath: null, designGenerationConfigImportPath: null,
    imageEdit: async () => { throw new Error('must not call outfit'); }, designGenerationFetch: async () => { throw new Error('must not call design'); },
    quiverFetch: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return fail ? Response.json({ code: 'service_unavailable' }, { status: 503 }) : Response.json({ id: 'quiver-test-id', data: [{ svg, mime_type: 'image/svg+xml' }] }); },
  });
  await plugin.configResolved({ root }); let handler;
  plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(`${base}/api/studio/${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, value: await res.json() };
  };
  const settled = async id => { for (let i = 0; i < 300; i++) { const job = (await request('state')).value.jobs.find(item => item.id === id); if (job && !['queued', 'processing'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('job timeout'); };
  const original = await sharp({ create: { width: 30, height: 45, channels: 3, background: 'white' } }).png().toBuffer();
  const input = { designMode: 'photo_to_sketch', sketchProvider: 'quiver', quiver: { model: 'arrow-2', reasoningEffort: 'xhigh' }, name: '矢量裤装', prompt: '保留口袋', count: 1, references: [{ id: 'primary', name: '裤装', role: '主体款式参考', regions: [], imageDataUrl: `data:image/png;base64,${original.toString('base64')}` }] };
  assert.equal((await request('design/generate', input)).status, 503);
  assert.equal((await request('design/quiver-settings', { apiKey: 'mock-quiver-only' }, 'PATCH')).status, 200);
  assert.equal((await request('design/generation-settings')).value.configured, false);
  assert.equal((await request('design/generate', { ...input, designMode: 'sketch_to_garment' })).status, 400);
  assert.equal((await request('design/generate', { ...input, quiver: { model: 'bad' } })).status, 400);
  const response = await request('design/generate', input); assert.equal(response.status, 202);
  const job = await settled(response.value.id); assert.equal(job.status, 'complete', job.error);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.quiver.ai/v1/svgs/generations');
  assert.equal(calls[0].body.model, 'arrow-2'); assert.equal(calls[0].body.reasoning_effort, 'xhigh');
  assert.deepEqual(Buffer.from(calls[0].body.references[0].base64, 'base64'), original);
  assert.deepEqual(calls[0].body.attributes.viewBox, { minX: 0, minY: 0, width: 30, height: 45 });
  assert.ok(!calls[0].body.prompt.includes('undefined')); assert.equal(job.providerProtocol, 'quiver');
  assert.match(calls[0].body.instructions, /same visual style and level of finish as the Quiver web experience/);
  assert.match(calls[0].body.instructions, /user conversation prompt as the instruction/);
  assert.match(calls[0].body.instructions, /Extract the requested garment itself/);
  const vector = await fetch(base + job.vectorImages[0]); assert.match(vector.headers.get('content-type'), /svg/); assert.match(vector.headers.get('content-disposition'), /attachment/); assert.equal(await vector.text(), svg);
  const preview = Buffer.from(await (await fetch(base + job.image)).arrayBuffer()); assert.equal((await sharp(preview).metadata()).format, 'png');
  fail = true; const failed = await request('design/generate', input), failedJob = await settled(failed.value.id); assert.equal(failedJob.status, 'failed'); assert.equal(calls.length, 2);
  fail = false; assert.equal((await request(`jobs/${failedJob.id}/retry`, {})).status, 202); assert.equal((await settled(failedJob.id)).status, 'complete');
  assert.equal(calls.length, 3); assert.equal(calls[2].body.reasoning_effort, 'xhigh');
  assert.equal((await request(`jobs/${job.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await fetch(base + job.vectorImages[0])).status, 404);
});
