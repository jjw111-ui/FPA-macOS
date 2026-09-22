import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { wardrobeStudioApi } from './studio-api.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A gated local editor proves admission order and slot ownership without making
// generation requests or depending on arbitrary provider response timings.
async function harness(t, concurrency) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fpa-concurrency-'));
  const pixel = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#647567' } }).png().toBuffer();
  const calls = [];
  let active = 0, maximum = 0, closing = false, service;
  const servers = [];
  const env = {
    OPENAI_API_KEY: 'local-mock-key', OPENAI_API_BASE_URL: 'http://unused.invalid/v1',
    OPENAI_IMAGE_MODEL: 'model-before', OPENAI_IMAGE_TIMEOUT_MS: '180000',
    ...(concurrency === undefined ? {} : { OPENAI_IMAGE_CONCURRENCY: String(concurrency) }),
  };
  const editor = async args => {
    active++; maximum = Math.max(maximum, active);
    let done = false;
    const result = new Promise((resolve, reject) => {
      const call = {
        args, label: args.prompt.match(/TEST_JOB_([A-Z]+)/)?.[1],
        release() { if (!done) { done = true; resolve(args.count > 1 ? Array.from({ length: args.count }, () => Buffer.from(pixel)) : Buffer.from(pixel)); } },
        fail(error) { if (!done) { done = true; reject(error); } },
      };
      calls.push(call);
      if (closing) call.release();
    });
    try { return await result; } finally { active--; }
  };
  async function serve() {
    const plugin = wardrobeStudioApi({ env, imageEdit: editor });
    await plugin.configResolved({ root });
    let handler;
    plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
    const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    service = { server, base: `http://127.0.0.1:${server.address().port}/api/studio/` };
  }
  async function request(route, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(service.base + route, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, value: await response.json() };
  }
  async function waitFor(predicate, message = 'queue state did not converge') {
    for (let i = 0; i < 400; i++) {
      const state = (await request('state')).value;
      if (predicate(state)) return state;
      await delay(10);
    }
    throw new Error(message);
  }
  const settled = () => waitFor(state => !state.jobs.some(job => ['queued', 'processing'].includes(job.status)));
  async function close(server) {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  t.after(async () => {
    closing = true;
    for (const call of calls) call.release();
    try { if (service?.server.listening) await settled(); } finally {
      for (const server of servers) await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });
  await serve();
  async function upload(name, part = 'upperbody') {
    const result = await request('assets', { name, part, imageDataUrl: `data:image/png;base64,${pixel.toString('base64')}` });
    assert.equal(result.status, 201);
    return result.value;
  }
  const asset = await upload('测试上衣');
  return {
    root, calls, request, waitFor, settled, upload,
    get maximum() { return maximum; },
    async submit(label, extra = {}) {
      const result = await request('outfits', { name: label, direction: `TEST_JOB_${label}`, assetIds: [asset.id], ...extra });
      assert.equal(result.status, 202);
      return result.value;
    },
    async settings(input) {
      const result = await request('settings', input, 'PATCH');
      assert.equal(result.status, 200);
      return result.value;
    },
    async restart(editDatabase) {
      await close(service.server);
      if (editDatabase) {
        const dbPath = path.join(root, 'data/studio/studio.json');
        const db = JSON.parse(await readFile(dbPath, 'utf8'));
        editDatabase(db);
        await writeFile(dbPath, JSON.stringify(db));
      }
      await serve();
    },
  };
}

test('默认同时执行两个任务，额外任务按顺序等待，多张输出不增加请求数', { timeout: 20000 }, async t => {
  const h = await harness(t);
  assert.equal((await h.request('state')).value.settings.concurrency, 2);
  for (const concurrency of [0, 9, 1.5, 'invalid']) {
    assert.equal((await h.request('settings', { concurrency }, 'PATCH')).status, 400);
  }
  const a = await h.submit('A', { count: 4 });
  const b = await h.submit('B');
  const c = await h.submit('C');
  const d = await h.submit('D');
  let state = await h.waitFor(state => h.calls.length === 2 && state.queue?.queued === 2);
  assert.deepEqual(state.queue, { running: 2, queued: 2, concurrency: 2 });
  assert.equal(state.jobs.find(job => job.id === c.id).queuePosition, 1);
  assert.equal(state.jobs.find(job => job.id === d.id).queuePosition, 2);
  assert.deepEqual(h.calls.map(call => call.label).sort(), ['A', 'B']);
  h.calls.find(call => call.label === 'B').release();
  await h.waitFor(() => h.calls.length === 3);
  assert.equal(h.calls[2].label, 'C', '先完成的任务释放一个位置给排队首项');
  h.calls.find(call => call.label === 'A').release();
  await h.waitFor(() => h.calls.length === 4);
  assert.equal(h.calls[3].label, 'D');
  h.calls[2].release(); h.calls[3].release();
  state = await h.settled();
  assert.equal(h.maximum, 2);
  assert.equal(state.jobs.find(job => job.id === a.id).images.length, 4);
  assert.equal(state.jobs.find(job => job.id === b.id).attemptCount, 1);
  assert.equal(h.calls.length, 4, '每个任务只发一次请求，count 不会拆成重复付费请求');
});

test('提高并发立即开始等待任务，降低并发不打断进行中任务，设置和并行结果能持久化', { timeout: 20000 }, async t => {
  const h = await harness(t, 1);
  for (const label of ['A', 'B', 'C', 'D', 'E']) await h.submit(label);
  await h.waitFor(() => h.calls.length === 1);
  await h.settings({ concurrency: 3, model: 'model-after' });
  await h.waitFor(state => h.calls.length === 3 && state.queue?.running === 3);
  assert.equal(h.calls.find(call => call.label === 'A').args.model, 'model-before');
  assert.ok(h.calls.filter(call => call.label !== 'A').every(call => call.args.model === 'model-after'));
  assert.ok(h.calls.every(call => call.args.timeoutMs === 180000), '调整并发保留用户三分钟超时');
  const lowered = await h.settings({ concurrency: 1 });
  assert.equal(lowered.timeoutMinutes, 3);
  h.calls.find(call => call.label === 'B').release();
  let state = await h.waitFor(state => state.jobs.find(job => job.name === 'B').status === 'complete');
  assert.deepEqual(state.queue, { running: 2, queued: 2, concurrency: 1 });
  assert.equal(h.calls.length, 3);
  h.calls.find(call => call.label === 'C').release();
  state = await h.waitFor(state => state.jobs.find(job => job.name === 'C').status === 'complete');
  assert.equal(state.queue.running, 1); assert.equal(h.calls.length, 3);
  h.calls.find(call => call.label === 'A').release();
  await h.waitFor(() => h.calls.length === 4);
  assert.equal(h.calls[3].label, 'D'); h.calls[3].release();
  await h.waitFor(() => h.calls.length === 5);
  assert.equal(h.calls[4].label, 'E'); h.calls[4].release();
  state = await h.settled();
  const savedImages = state.jobs.map(job => job.image).sort();
  assert.equal(h.maximum, 3);
  await h.restart();
  state = (await h.request('state')).value;
  assert.equal(state.settings.concurrency, 1); assert.equal(state.settings.timeoutMinutes, 3);
  assert.deepEqual(state.jobs.map(job => job.image).sort(), savedImages);
  assert.ok(state.jobs.every(job => job.status === 'complete' && job.attemptCount === 1));
  assert.equal(h.calls.length, 5, '重启不重复请求已经生成的图片');
});

test('失败或超时释放位置，排队取消不发请求，手动重试加入队尾且重复点击不重复执行', { timeout: 20000 }, async t => {
  const h = await harness(t, 2);
  const a = await h.submit('A');
  await h.submit('B');
  const c = await h.submit('C');
  await h.submit('D');
  await h.submit('E');
  await h.waitFor(() => h.calls.length === 2);
  assert.equal((await h.request(`jobs/${c.id}/cancel`, {})).status, 200);
  assert.equal((await h.request(`jobs/${a.id}/cancel`, {})).status, 409);
  const timeout = Object.assign(new Error('mock local timeout'), { isLocalTimeout: true, timeoutMs: 180000 });
  h.calls.find(call => call.label === 'A').fail(timeout);
  let state = await h.waitFor(state => state.jobs.find(job => job.id === a.id).status === 'failed' && h.calls.length === 3);
  assert.equal(h.calls[2].label, 'D');
  assert.equal(state.jobs.find(job => job.id === a.id).failureKind, 'client_timeout');
  assert.equal(state.jobs.find(job => job.id === a.id).resultUncertain, true);
  const retries = await Promise.all([h.request(`jobs/${a.id}/retry`, {}), h.request(`jobs/${a.id}/retry`, {})]);
  assert.deepEqual(retries.map(result => result.status).sort(), [202, 409]);
  state = (await h.request('state')).value;
  assert.equal(state.jobs.find(job => job.name === 'E').queuePosition, 1);
  assert.equal(state.jobs.find(job => job.id === a.id).queuePosition, 2, '失败任务按重试时间重新排队');
  h.calls.find(call => call.label === 'B').release();
  await h.waitFor(() => h.calls.length === 4);
  assert.equal(h.calls[3].label, 'E');
  h.calls.find(call => call.label === 'D').release();
  await h.waitFor(() => h.calls.length === 5);
  assert.equal(h.calls[4].label, 'A');
  h.calls[3].release(); h.calls[4].release();
  state = await h.settled();
  assert.equal(state.jobs.find(job => job.id === c.id).status, 'cancelled');
  assert.equal(state.jobs.find(job => job.id === a.id).attemptCount, 2);
  assert.equal(h.calls.filter(call => call.label === 'A').length, 2);
  assert.equal(h.calls.filter(call => call.label === 'C').length, 0);
  assert.equal(h.maximum, 2);
});

test('重复点击同一素材只创建一次任务，场景、正脸与服装共用并发额度并回填各自素材', { timeout: 20000 }, async t => {
  const h = await harness(t, 2);
  const scene = await h.upload('测试场景', 'scene');
  const face = await h.upload('测试人脸', 'face');
  const garment = await h.upload('测试裤子', 'lowerbody');
  const tasks = [];
  for (const [asset, operation] of [[scene, 'scene'], [face, 'face'], [garment, 'clean']]) {
    const results = await Promise.all([
      h.request(`assets/${asset.id}/${operation}`, {}),
      h.request(`assets/${asset.id}/${operation}`, {}),
    ]);
    assert.ok(results.every(result => result.status === 202));
    assert.equal(results[0].value.id, results[1].value.id, `${operation} 的重复点击复用当前任务`);
    tasks.push(results[0].value.id);
  }
  let state = await h.waitFor(state => h.calls.length === 2 && state.queue?.queued === 1);
  assert.equal(state.jobs.length, 3);
  h.calls[0].release(); h.calls[1].release();
  await h.waitFor(() => h.calls.length === 3);
  h.calls[2].release();
  state = await h.settled();
  assert.equal(h.maximum, 2);
  for (const [asset, property, index] of [[scene, 'sceneImage', 0], [face, 'faceImage', 1], [garment, 'cleanedImage', 2]]) {
    const result = state.jobs.find(job => job.id === tasks[index]);
    assert.equal(result.status, 'complete'); assert.equal(result.attemptCount, 1);
    const saved = state.assets.find(item => item.id === asset.id);
    assert.equal(saved[property], result.image); assert.equal(saved.image, result.image);
  }
});

test('并行保存设置后内存、磁盘与重启配置一致', { timeout: 20000 }, async t => {
  const h = await harness(t);
  await Promise.all(Array.from({ length: 8 }, (_, index) => h.settings({
    concurrency: index + 1, model: `parallel-model-${index + 1}`,
  })));
  const before = (await h.request('state')).value.settings;
  const saved = JSON.parse(await readFile(path.join(h.root, 'data/studio/settings.json'), 'utf8'));
  assert.equal(Number(saved.OPENAI_IMAGE_CONCURRENCY), before.concurrency);
  assert.equal(saved.OPENAI_IMAGE_MODEL, before.model);
  await h.restart();
  const after = (await h.request('state')).value.settings;
  assert.equal(after.concurrency, before.concurrency);
  assert.equal(after.model, before.model);
  assert.equal(after.timeoutMinutes, 3);
  assert.equal(h.calls.length, 0);
});

test('重启后按持久化队列顺序恢复并遵守并发上限，进行中任务不自动重发', { timeout: 20000 }, async t => {
  const h = await harness(t, 2);
  for (const label of ['A', 'B', 'C', 'D']) {
    await h.submit(label);
    await h.waitFor(() => h.calls.some(call => call.label === label));
    h.calls.find(call => call.label === label).release();
    await h.settled();
  }
  await h.restart(db => {
    const order = { C: 1, A: 2, B: 3 };
    for (const job of db.jobs) {
      delete job.image; delete job.images;
      job.status = job.name === 'D' ? 'processing' : 'queued';
      job.queuedAt = '2026-01-01T00:00:00.000Z';
      job.queueSequence = order[job.name] || 0;
    }
  });
  let state = await h.waitFor(state => h.calls.length === 6 && state.queue?.running === 2);
  assert.deepEqual(h.calls.slice(4).map(call => call.label).sort(), ['A', 'C']);
  assert.equal(state.jobs.find(job => job.name === 'B').queuePosition, 1);
  const interrupted = state.jobs.find(job => job.name === 'D');
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.resultUncertain, true);
  assert.equal(interrupted.attemptCount, 1);
  h.calls[4].release(); h.calls[5].release();
  await h.waitFor(() => h.calls.length === 7);
  assert.equal(h.calls[6].label, 'B'); h.calls[6].release();
  state = await h.settled();
  assert.equal(h.calls.filter(call => call.label === 'D').length, 1);
  assert.ok(state.jobs.filter(job => job.name !== 'D').every(job => job.status === 'complete' && job.attemptCount === 2));
  assert.equal(h.maximum, 2);
});
