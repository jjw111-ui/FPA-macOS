import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { wardrobeStudioApi } from './studio-api.mjs';

test('原格式素材入库、显示和生成均保留上传字节；仅明确超限允许压缩重试', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-original-upload-'));
  const calls = [];
  let failStatus;
  const plugin = wardrobeStudioApi({
    env: { OPENAI_API_KEY: 'offline-key', WARDROBE_DATA_DIR: 'data' },
    imageEdit: async args => {
      calls.push(args);
      if (failStatus) throw Object.assign(new Error('test upstream failure'), { status: failStatus });
      return args.images[0].data;
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
  async function request(route, data) {
    const response = await fetch(`${base}/api/studio/${route}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  }
  async function settled(id) {
    for (let i = 0; i < 200; i++) {
      const job = (await request('state')).value.jobs.find(job => job.id === id);
      if (job && !['queued', 'processing'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('Test job did not settle');
  }
  let asset;
  for (const format of ['jpeg', 'png', 'webp']) {
    let image = sharp({ create: { width: 80, height: 120, channels: 4, background: '#80604080' } });
    if (format === 'jpeg') image = image.flatten({ background: '#ffffff' }).withMetadata({ orientation: 6 });
    const original = await image.toFormat(format).toBuffer();
    const uploaded = await request('assets', {
      name: `original-${format}`, part: 'upperbody', mode: 'original',
      imageDataUrl: `data:image/${format};base64,${original.toString('base64')}`,
    });
    assert.equal(uploaded.status, 201);
    asset = uploaded.value;
    assert.ok(asset.image.endsWith(`.${format}`));
    assert.equal(asset.originalBytes, original.length);
    assert.equal(asset.originalMime, `image/${format}`);
    assert.equal(asset.originalSha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(asset.originalWidth, format === 'jpeg' ? 120 : 80);
    assert.equal(asset.originalHeight, format === 'jpeg' ? 80 : 120);
    const downloaded = await fetch(base + asset.image);
    assert.equal(downloaded.headers.get('content-type'), `image/${format}`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original, '入库不重编码，不删除原图色彩或方向信息');
    const job = (await request(`assets/${asset.id}/clean`, {})).value;
    assert.equal((await settled(job.id)).status, 'complete');
    assert.deepEqual(calls.at(-1).images[0].data, original, '生成读取原始字节');
    assert.ok(calls.at(-1).images[0].name.endsWith(`.${format}`));
    assert.equal(calls.at(-1).compressInput, false);
  }
  failStatus = 413;
  const limited = (await request(`assets/${asset.id}/clean`, {})).value;
  const failure = await settled(limited.id);
  assert.equal(failure.failureKind, 'input_too_large');
  const callCount = calls.length;
  assert.equal((await request('state')).value.jobs.find(job => job.id === limited.id).status, 'failed');
  assert.equal(calls.length, callCount, '明确超限也不自动发送第二笔请求');
  failStatus = undefined;
  assert.equal((await request(`jobs/${limited.id}/retry`, { compressInput: true })).status, 202);
  assert.equal((await settled(limited.id)).status, 'complete');
  assert.equal(calls.at(-1).compressInput, true);
  failStatus = 503;
  const unavailable = (await request(`assets/${asset.id}/clean`, {})).value;
  await settled(unavailable.id);
  const beforeInvalidRetry = calls.length;
  assert.equal((await request(`jobs/${unavailable.id}/retry`, { compressInput: true })).status, 400);
  assert.equal(calls.length, beforeInvalidRetry);
  failStatus = undefined;
  assert.equal((await request(`jobs/${unavailable.id}/retry`, {})).status, 202);
  await settled(unavailable.id);
  assert.equal(calls.at(-1).compressInput, false, '普通失败重试仍使用原图');
});
