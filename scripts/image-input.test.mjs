import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { openAIEdit } from './import-job-api.mjs';
import { prepareImageInputs } from './image-input.mjs';
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MAX_TASK_IMAGE_BYTES, imageLimitMessage } from '../src/image-limits.mjs';

test('参考项目的本地限额仅拦截超限原图，不产生网络请求', async t => {
  const raw = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const oversized = Buffer.concat([raw, Buffer.alloc(MAX_IMAGE_BYTES + 1 - raw.length)]);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => { requestCount++; throw new Error('Must not send oversized input'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(openAIEdit({ key: 'local-test', baseUrl: 'http://unused.invalid/v1', model: 'test', prompt: 'local size guard', images: [{ data: oversized }], size: '1024x1024' }), error => {
    assert.equal(error.failureKind, 'input_too_large');
    assert.equal(error.inputLimitSource, 'local');
    assert.equal(error.status, undefined, '本地限制不能伪装成服务商 HTTP 错误');
    return true;
  });
  assert.equal(requestCount, 0);
  const allowed = Buffer.concat([raw, Buffer.alloc(MAX_IMAGE_BYTES - raw.length)]);
  assert.equal((await prepareImageInputs([{ data: allowed }]))[0].data, allowed, '50MB 边界仍按原始字节发送');
  const perImage = Buffer.concat([raw, Buffer.alloc(Math.floor(MAX_TASK_IMAGE_BYTES / 3) + 1 - raw.length)]);
  await assert.rejects(prepareImageInputs([{ data: perImage }, { data: perImage }, { data: perImage }]), /128MB/);
  assert.equal(imageLimitMessage({ bytes: 10, width: MAX_IMAGE_SIDE, height: 1 }), '');
  assert.match(imageLimitMessage({ bytes: 10, width: MAX_IMAGE_SIDE + 1, height: 1 }), /尺寸/);
});

async function localGateway(t, handler) {
  const received = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      received.push(form);
      await handler(form, res);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { received, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test('原图通过真实 multipart 发送：JPEG、PNG、WebP 字节、EXIF 和 ICC 均保持不变', async t => {
  const create = () => sharp({ create: { width: 24, height: 40, channels: 3, background: '#826345' } });
  const source = [
    await create().jpeg().withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { Artist: 'original-photo' } }).toBuffer(),
    await create().png().withIccProfile('p3').toBuffer(),
    await create().webp({ lossless: true }).withMetadata().toBuffer(),
  ];
  const expected = [['image/jpeg', 'reference-0.jpg'], ['image/png', 'reference-1.png'], ['image/webp', 'reference-2.webp']];
  const images = source.map((data, index) => ({ data, name: `reference-${index}.wrong`, mime: 'image/png' }));
  const copies = source.map(data => Buffer.from(data));
  const gateway = await localGateway(t, (_form, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: source[1].toString('base64') }] }));
  });
  await openAIEdit({ key: 'local-test', baseUrl: gateway.baseUrl, model: 'user-exact-model', prompt: 'offline transport test', images, size: '1600x2000' });
  assert.equal(gateway.received.length, 1);
  const form = gateway.received[0];
  assert.equal(form.get('model'), 'user-exact-model');
  assert.equal(form.get('size'), '1600x2000');
  const files = form.getAll('image[]');
  assert.equal(files.length, source.length);
  for (const [index, file] of files.entries()) {
    assert.equal(file.type, expected[index][0]);
    assert.equal(file.name, expected[index][1]);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), source[index]);
    assert.deepEqual(source[index], copies[index]);
  }
  const exif = await sharp(Buffer.from(await files[0].arrayBuffer())).metadata();
  assert.equal(exif.orientation, 6);
  assert.ok(exif.exif.includes(Buffer.from('original-photo')));
  const unchanged = await prepareImageInputs(images, { maxTotalBytes: 1 });
  assert.deepEqual(unchanged.map(image => image.data), source, 'normal sending does not apply the retry budget');
});

test('HTTP 413 的 JSON 和 HTML 均保留明确失败类型，且不会自动发送第二笔请求', async t => {
  const pixel = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#826345' } }).png().toBuffer();
  for (const contentType of ['application/json', 'text/html']) {
    const gateway = await localGateway(t, (_form, res) => {
      res.statusCode = 413;
      res.setHeader('Content-Type', contentType);
      res.setHeader('x-request-id', 'upload-rejected-local');
      res.end(contentType === 'application/json' ? JSON.stringify({ error: { message: 'Payload Too Large', code: 'too_large' } }) : '<html>413 Request Entity Too Large</html>');
    });
    await assert.rejects(openAIEdit({ key: 'local-test', baseUrl: gateway.baseUrl, model: 'user-exact-model', prompt: 'offline 413 test', images: [{ data: pixel, name: 'source.png' }], size: '1600x2000' }), error => {
      assert.equal(error.status, 413);
      assert.equal(error.requestId, 'upload-rejected-local');
      assert.equal(error.failureKind, 'input_too_large');
      assert.notEqual(error.isLocalTimeout, true);
      return true;
    });
    assert.equal(gateway.received.length, 1);
  }
});

test('超时不会被误判为图片超限，也不会自动压缩重试', async t => {
  const pixel = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#826345' } }).png().toBuffer();
  const gateway = await localGateway(t, () => {});
  await assert.rejects(openAIEdit({ key: 'local-test', baseUrl: gateway.baseUrl, model: 'user-exact-model', prompt: 'offline timeout test', images: [{ data: pixel }], size: '1600x2000', timeoutMs: 80 }), error => {
    assert.equal(error.isLocalTimeout, true);
    assert.notEqual(error.failureKind, 'input_too_large');
    return true;
  });
  assert.equal(gateway.received.length, 1);
});

test('显式压缩仅制作内存副本，先保留完整尺寸，不改变原始图片和输出参数', async t => {
  const width = 512; const height = 384;
  const source = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).withMetadata({ orientation: 6 }).toBuffer();
  const original = Buffer.from(source);
  const [compressed] = await prepareImageInputs([{ data: source, name: 'original.png' }], { compressInput: true, maxTotalBytes: Math.floor(source.length * 0.85) });
  assert.ok(compressed.data.length < source.length);
  const metadata = await sharp(compressed.data).metadata();
  assert.equal(metadata.width, height);
  assert.equal(metadata.height, width);
  assert.ok(!metadata.orientation || metadata.orientation === 1);
  assert.ok(metadata.icc?.length);
  assert.deepEqual(source, original);
  const gateway = await localGateway(t, (_form, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: source.toString('base64') }] }));
  });
  await openAIEdit({ key: 'local-test', baseUrl: gateway.baseUrl, model: 'user-exact-model', prompt: 'offline explicit compression test', images: [{ data: source, name: 'original.png' }], size: '1600x2000', compressInput: true });
  assert.equal(gateway.received.length, 1);
  const form = gateway.received[0];
  const file = form.get('image[]');
  assert.equal(file.type, 'image/jpeg');
  assert.equal(file.name, 'original.jpg');
  assert.ok(file.size < source.length);
  assert.equal(form.get('model'), 'user-exact-model');
  assert.equal(form.get('size'), '1600x2000');
  assert.deepEqual(source, original);
});

test('压缩副本只有体积确实超预算才等比缩小，多图总大小不超过预算', async () => {
  const width = 384; const height = 256;
  const source = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  const original = Buffer.from(source);
  const maxTotalBytes = 40000;
  const compressed = await prepareImageInputs([{ data: source }, { data: source }], { compressInput: true, maxTotalBytes });
  assert.ok(compressed.reduce((total, image) => total + image.data.length, 0) <= maxTotalBytes);
  for (const image of compressed) {
    const metadata = await sharp(image.data).metadata();
    assert.ok(metadata.width < width);
    assert.ok(Math.abs(metadata.width / metadata.height - width / height) < 0.02);
  }
  assert.deepEqual(source, original);
});

test('透明参考图压缩保持 alpha，不铺白底且不改变可见颜色', async () => {
  const width = 160; const height = 120;
  const raw = Buffer.alloc(width * height * 4);
  for (let index = 0; index < raw.length; index += 4) {
    raw[index] = 92; raw[index + 1] = 135; raw[index + 2] = 174;
    raw[index + 3] = index % 12 === 0 ? 0 : index % 12 === 4 ? 127 : 255;
  }
  const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  const original = Buffer.from(source);
  const [compressed] = await prepareImageInputs([{ data: source }], { compressInput: true, maxTotalBytes: 10000 });
  const decoded = await sharp(compressed.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, width);
  assert.equal(decoded.info.height, height);
  for (let index = 0; index < raw.length; index += 4) {
    assert.equal(decoded.data[index + 3], raw[index + 3]);
    if (raw[index + 3]) for (let channel = 0; channel < 3; channel += 1) assert.ok(Math.abs(decoded.data[index + channel] - raw[index + channel]) <= 1);
  }
  assert.deepEqual(source, original);
});
