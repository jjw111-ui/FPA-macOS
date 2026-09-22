import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { wardrobeStudioApi } from './studio-api.mjs';

test('配饰可原图入库或上传即整理：原图保留、细节说明传入、结果回填、失败不自动重试', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-accessory-'));
  const original = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#403020' } }).jpeg().toBuffer();
  const generated = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fafafa' } }).png().toBuffer();
  const calls = [];
  let fail = false;
  const plugin = wardrobeStudioApi({
    env: { OPENAI_API_KEY: 'offline-test-key', OPENAI_IMAGE_MODEL: 'exact-accessory-model', OPENAI_IMAGE_TIMEOUT_MS: '180000', WARDROBE_DATA_DIR: 'data' },
    imageEdit: async args => {
      calls.push(args);
      if (fail) throw Object.assign(new Error('mock service unavailable'), { status: 503 });
      return generated;
    },
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
    const response = await fetch(`${base}/api/studio/${route}`, { method, headers: { 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json();
    assert.ok(response.ok, body.error);
    return body;
  }
  async function settled() {
    for (let n = 0; n < 200; n++) {
      const state = await request('state');
      if (!state.jobs.some(job => ['queued', 'processing'].includes(job.status))) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Accessory job did not settle');
  }
  const imageDataUrl = `data:image/jpeg;base64,${original.toString('base64')}`;
  const direct = await request('assets', { part: 'accessories_up', name: '原图帽子', mode: 'original', imageDataUrl });
  assert.equal(direct.part, 'accessories_up');
  assert.equal(direct.image, direct.originalImage);
  assert.equal(calls.length, 0, '直接保存不使用图像接口');
  assert.equal((await request('state')).jobs.length, 0);

  const uploaded = await request('assets', { part: 'accessories_up', name: '黑色单肩包', notes: '只提取黑色包，保留银色扣件和完整肩带', mode: 'clean', imageDataUrl });
  let state = await settled();
  const job = state.jobs.find(item => item.assetId === uploaded.id);
  const saved = state.assets.find(item => item.id === uploaded.id);
  assert.equal(calls.length, 1);
  assert.equal(job.name, '黑色单肩包 · 配饰整理');
  assert.equal(job.status, 'complete');
  assert.equal(saved.part, 'accessories_up');
  assert.equal(saved.image, saved.cleanedImage);
  assert.equal(saved.cleanedImage, job.image);
  assert.notEqual(saved.cleanedImage, saved.originalImage);
  assert.equal(saved.originalImage, uploaded.originalImage);
  assert.deepEqual(Buffer.from(await (await fetch(base + saved.originalImage)).arrayBuffer()), original);
  assert.deepEqual(calls[0].images[0].data, original);
  assert.match(calls[0].prompt, /isolated accessory product photograph/);
  assert.match(calls[0].prompt, /只提取黑色包，保留银色扣件和完整肩带/);
  assert.match(calls[0].prompt, /bag handles and straps, buckles, zippers, metal hardware/);
  assert.equal(calls[0].model, 'exact-accessory-model');
  assert.equal(calls[0].timeoutMs, 180000);
  assert.equal(calls[0].compressInput, false);
  const restored = await request(`assets/${uploaded.id}`, { part: 'accessories_up', imageVersion: 'original' }, 'PATCH');
  assert.equal(restored.image, saved.originalImage);
  const selected = await request(`assets/${uploaded.id}`, { part: 'accessories_up', imageVersion: 'cleaned' }, 'PATCH');
  assert.equal(selected.image, saved.cleanedImage);

  await request(`assets/${direct.id}/clean`, {});
  state = await settled();
  assert.equal(state.jobs.find(item => item.assetId === direct.id).name, '原图帽子 · 配饰整理');
  assert.equal(calls.length, 2, '已入库配饰也可以单独整理');
  fail = true;
  const failedUpload = await request('assets', { part: 'accessories_up', name: '眼镜', mode: 'clean', imageDataUrl });
  state = await settled();
  const failedAsset = state.assets.find(item => item.id === failedUpload.id);
  assert.equal(state.jobs.find(item => item.assetId === failedUpload.id).status, 'failed');
  assert.equal(failedAsset.image, failedAsset.originalImage);
  assert.equal(failedAsset.cleanedImage, undefined);
  assert.equal(calls.length, 3, '失败不自动重试，原图仍可使用');
});
