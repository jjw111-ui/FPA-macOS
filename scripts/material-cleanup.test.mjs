import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { CATEGORIES, wardrobeStudioApi } from './studio-api.mjs';

async function harness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-material-'));
  const original = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#685e4f' } }).jpeg().toBuffer();
  const generated = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f9f9f9' } }).png().toBuffer();
  const calls = [];
  let failNext = false;
  const plugin = wardrobeStudioApi({
    env: { OPENAI_API_KEY: 'offline-env-key', OPENAI_IMAGE_MODEL: 'env-image-model', WARDROBE_DATA_DIR: 'data' },
    imageEdit: async args => {
      calls.push(args);
      if (failNext) { failNext = false; throw Object.assign(new Error('mock service unavailable'), { status: 503 }); }
      return generated;
    },
    designImageEdit: async () => { throw new Error('Material cleanup must use the main image API'); },
  });
  await plugin.configResolved({ root });
  let handler;
  plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${base}/api/studio/${route}`, {
      method, headers: { 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, value: await response.json() };
  }
  async function success(route, data, method) {
    const result = await request(route, data, method);
    assert.ok(result.status < 400, result.value.error);
    return result.value;
  }
  async function settled() {
    for (let n = 0; n < 200; n++) {
      const state = await success('state');
      if (!state.jobs.some(job => ['queued', 'processing'].includes(job.status))) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Material jobs did not settle');
  }
  return {
    root, calls, original, generated, request, success, settled,
    imageDataUrl: `data:image/jpeg;base64,${original.toString('base64')}`,
    imageBytes: async image => Buffer.from(await (await fetch(base + image)).arrayBuffer()),
    failNext() { failNext = true; },
  };
}

for (const [part, label, name, notes, promptChecks] of [
  ['fabric', '面料', '米色细斜纹', '保留细斜纹方向和原图色差，不增加织纹', [
    /faithful fabric swatch reference/, /exact color, texture, weave or knit structure/,
    /original relative scale/, /Remove garment form/, /Do not invent weave/,
    /do not extrapolate hidden areas, synthesize a new seamless pattern/,
  ]],
  ['trims', '辅料', '银色拉链', '保留拉头刻字、链齿和布带', [
    /isolated garment trim reference/, /buttons, a zipper, a label, cord/,
    /exact item shape, proportions, material, color/, /zipper teeth and puller/,
    /do not invent, rewrite, mirror or reverse text/, /never add pieces/,
  ]],
]) {
  test(`${label}原图与整理入库、主图接口配置、历史记录、版本和失败保留`, async t => {
    const h = await harness(t);
    assert.equal(CATEGORIES[part], label);
    await h.success('settings', {
      apiKey: 'offline-main-key', baseUrl: 'https://main-image.invalid/v1/',
      model: 'configured-main-image-model', quality: 'medium', timeoutMinutes: 3,
    }, 'PATCH');
    const direct = await h.success('assets', { part, name: `原图${name}`, mode: 'original', imageDataUrl: h.imageDataUrl });
    assert.equal(direct.part, part);
    assert.equal(direct.kind, 'reference', '设计材料不能成为服装单品');
    assert.equal(direct.image, direct.originalImage);
    assert.equal(h.calls.length, 0, '原图入库不调用图像服务');
    assert.equal((await h.success('state')).jobs.length, 0);

    const uploaded = await h.success('assets', { part, name, notes, mode: 'clean', imageDataUrl: h.imageDataUrl });
    let state = await h.settled();
    const job = state.jobs.find(item => item.assetId === uploaded.id);
    const saved = state.assets.find(item => item.id === uploaded.id);
    assert.equal(job.kind, 'clean');
    assert.equal(job.name, `${name} · ${label}整理`);
    assert.equal(job.status, 'complete');
    assert.equal(job.references[0].part, part);
    assert.equal(job.providerModel, 'configured-main-image-model');
    assert.equal(saved.part, part);
    assert.equal(saved.kind, 'reference');
    assert.equal(saved.image, saved.cleanedImage);
    assert.equal(saved.cleanedImage, job.image);
    assert.deepEqual(job.images, [saved.cleanedImage]);
    assert.equal(job.actualSize, '64x64');
    assert.notEqual(saved.cleanedImage, saved.originalImage);
    assert.equal(saved.originalImage, uploaded.originalImage);
    assert.deepEqual(await h.imageBytes(saved.originalImage), h.original);
    assert.deepEqual(await sharp(await h.imageBytes(saved.cleanedImage)).raw().toBuffer(), await sharp(h.generated).raw().toBuffer());

    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call.key, 'offline-main-key');
    assert.equal(call.baseUrl, 'https://main-image.invalid/v1');
    assert.equal(call.model, 'configured-main-image-model');
    assert.equal(call.quality, 'medium');
    assert.equal(call.timeoutMs, 180000);
    assert.equal(call.count, 1);
    assert.equal(call.size, '1024x1024');
    assert.equal(call.outputFormat, 'png');
    assert.equal(call.compressInput, false);
    assert.deepEqual(call.images[0].data, h.original);
    assert.ok(call.prompt.includes(name));
    assert.ok(call.prompt.includes(notes));
    for (const check of promptChecks) assert.match(call.prompt, check);

    const restored = await h.success(`assets/${uploaded.id}`, { part, notes, imageVersion: 'original' }, 'PATCH');
    assert.equal(restored.image, saved.originalImage);
    const selected = await h.success(`assets/${uploaded.id}`, { part, notes, imageVersion: 'cleaned' }, 'PATCH');
    assert.equal(selected.image, saved.cleanedImage);
    const database = JSON.parse(await readFile(path.join(h.root, 'data/studio/studio.json'), 'utf8'));
    const persisted = database.assets.find(item => item.id === uploaded.id);
    assert.equal(persisted.part, part);
    assert.equal(persisted.kind, 'reference');
    assert.equal(persisted.originalImage, uploaded.originalImage);
    assert.equal(persisted.cleanedImage, job.image);
    assert.equal(persisted.image, job.image);

    const manual = await h.request(`assets/${direct.id}/clean`, {});
    assert.equal(manual.status, 202);
    state = await h.settled();
    assert.equal(state.jobs.find(item => item.id === manual.value.id).name, `原图${name} · ${label}整理`);
    assert.equal(state.assets.find(item => item.id === direct.id).image, state.jobs.find(item => item.id === manual.value.id).image);
    await h.success(`assets/${uploaded.id}/clean`, {});
    await h.settled();
    assert.deepEqual(h.calls.at(-1).images[0].data, h.original, '再次整理仍读取原图，不串用生成结果');

    h.failNext();
    const failed = await h.success('assets', { part, name: `失败${name}`, mode: 'clean', imageDataUrl: h.imageDataUrl });
    state = await h.settled();
    const failedAsset = state.assets.find(item => item.id === failed.id);
    assert.equal(state.jobs.find(item => item.assetId === failed.id).status, 'failed');
    assert.equal(failedAsset.image, failedAsset.originalImage);
    assert.equal(failedAsset.cleanedImage, undefined);
    assert.deepEqual(await h.imageBytes(failedAsset.originalImage), h.original);
    assert.equal(h.calls.length, 4, '失败不自动重试');
  });
}

test('面辅料拒绝穿搭生成和不支持的整理方式，未配置接口仍可保存原图', async t => {
  const h = await harness(t);
  const garment = await h.success('assets', { part: 'upperbody', imageDataUrl: h.imageDataUrl });
  for (const part of ['fabric', 'trims']) {
    const material = await h.success('assets', { part, mode: 'original', imageDataUrl: h.imageDataUrl });
    for (const assetIds of [[material.id], [garment.id, material.id]]) {
      const result = await h.request('outfits', { assetIds });
      assert.equal(result.status, 400);
      assert.match(result.value.error, /面料和辅料仅供设计参考，不能作为穿搭素材/);
    }
    for (const mode of ['scene', 'face', 'unsupported']) {
      const upload = await h.request('assets', { part, mode, imageDataUrl: h.imageDataUrl });
      assert.equal(upload.status, 400);
    }
    for (const action of ['scene', 'face']) {
      const result = await h.request(`assets/${material.id}/${action}`, {});
      assert.equal(result.status, 400);
    }
    const reclassified = await h.success(`assets/${garment.id}`, { part }, 'PATCH');
    assert.equal(reclassified.kind, 'reference');
    const blocked = await h.request('outfits', { assetIds: [garment.id] });
    assert.equal(blocked.status, 400, '从服装改为面辅料后也不能进入穿搭');
    assert.match(blocked.value.error, /仅供设计参考/);
    await h.success(`assets/${garment.id}`, { part: 'upperbody' }, 'PATCH');
  }
  assert.equal(h.calls.length, 0);
  let state = await h.success('state');
  assert.equal(state.jobs.length, 0);
  assert.equal(state.assets.length, 3, '无效模式不会新增素材');
  await h.success('settings', { clearKey: true }, 'PATCH');
  for (const part of ['fabric', 'trims']) {
    const original = await h.success('assets', { part, mode: 'original', imageDataUrl: h.imageDataUrl });
    assert.equal(original.image, original.originalImage);
    const clean = await h.request('assets', { part, mode: 'clean', imageDataUrl: h.imageDataUrl });
    assert.equal(clean.status, 503);
    assert.match(clean.value.error, /接口密钥/);
    assert.equal((await h.request(`assets/${original.id}/clean`, {})).status, 503);
  }
  state = await h.success('state');
  assert.equal(state.assets.length, 5);
  assert.equal(state.jobs.length, 0);
  assert.equal(h.calls.length, 0);
});
