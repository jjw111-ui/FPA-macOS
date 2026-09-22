import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { buildDesignPrompt, normalizeDesignInput } from './design-api.mjs';

const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;

async function input(style, { fabric = false, color = false, region = false, version = 2 } = {}) {
  const pixel = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#56789a' } }).png().toBuffer();
  const references = [{ id: 'main', name: '主体', role: '主体款式参考', imageDataUrl: dataUrl(pixel), regions: region ? [{
    x: 0, y: 0, w: 1, h: 1, part: '袖型', placement: '左袖', mode: 'adapt', priority: 'medium', color: 'retain', fabric: 'adapt', note: '保留这一小块原色',
  }] : [] }];
  if (fabric) references.push({ id: 'fabric', name: '面料', role: '面料参考', imageDataUrl: dataUrl(pixel), regions: [] });
  if (color) references.push({ id: 'color', name: '配色', role: '配色参考', imageDataUrl: dataUrl(pixel), regions: [] });
  return normalizeDesignInput({ name: '颜色优先测试', prompt: '生成服装', references, style: { ...(version ? { version } : {}), ...style } });
}

const output = { aspectRatio: '1:1', size: '1024x1024', resolution: '1K' };

test('version 2 defaults to fabric color and visible material pattern when fabric image is enabled', async () => {
  const normalized = await input({ fabric: { mode: 'image' } }, { fabric: true, region: true });
  assert.equal(normalized.style.version, 2);
  assert.deepEqual(normalized.style.color, { mode: 'auto' });
  const prompt = buildDesignPrompt(normalized, output);
  assert.match(prompt, /自动配色：采用 Image 2 面料参考中实际可见的颜色/);
  assert.match(prompt, /印花或织纹图案/);
  assert.match(prompt, /不要发明图案/);
  assert.match(prompt, /领子、口袋、袖子、袖口/);
  assert.match(prompt, /color=retain/);
  assert.match(prompt, /只作用于该区域，不扩散到整件服装/);
  assert.doesNotMatch(prompt, /不继承[^。；\n]*颜色|不继承[^。；\n]*图案/);
  assert.match(prompt, /不要沿用主体图中的原有颜色或撞色色块/);
  assert.match(prompt, /样本裁切边缘或背景形状当成服装形状/);
});

test('version 2 auto falls back to primary colors without a fabric image', async () => {
  const normalized = await input({}, { fabric: false });
  assert.deepEqual(normalized.style.color, { mode: 'auto' });
  assert.match(buildDesignPrompt(normalized, output), /自动配色：未启用面料参考图，沿用 Image 1 主体款式参考的原配色/);
});

test('explicit color sources override automatic fabric color', async () => {
  const primary = await input({ fabric: { mode: 'image' }, color: { mode: 'primary' } }, { fabric: true });
  assert.match(buildDesignPrompt(primary, output), /明确配色选择优先于自动面料颜色/);

  const image = await input({ fabric: { mode: 'image' }, color: { mode: 'image' } }, { fabric: true, color: true });
  assert.match(buildDesignPrompt(image, output), /配色仅取自 Image 3 配色参考的颜色/);

  const custom = await input({ fabric: { mode: 'image' }, color: { mode: 'custom', hex: '#A1B2C3' } }, { fabric: true });
  assert.match(buildDesignPrompt(custom, output), /sRGB 色值 #A1B2C3/);

  const text = await input({ fabric: { mode: 'image' }, color: { mode: 'text', text: '深墨绿色' } }, { fabric: true });
  assert.match(buildDesignPrompt(text, output), /按文字指定配色：深墨绿色/);
  for (const normalized of [primary, image, custom, text]) {
    const prompt = buildDesignPrompt(normalized, output);
    assert.match(prompt, /当前明确选择的配色来源优先于面料参考中携带的颜色/);
    assert.match(prompt, /面料颜色按下述明确配色来源调整，保留材料纹理和图案特征/);
    assert.doesNotMatch(prompt, /自动配色采用面料样本的实际颜色|面料参考的实际颜色|所有面料面板[^。]*遵循面料参考的颜色/);
  }
});

test('legacy styles preserve primary default when color was omitted', async () => {
  const normalized = await input({ fabric: { mode: 'image' } }, { fabric: true, version: null });
  assert.deepEqual(normalized.style.color, { mode: 'primary' });
  assert.equal(normalized.style.version, undefined);
});

test('automatic mode strips inactive controls and respects an explicit fabric application limit', async () => {
  const normalized = await input({ fabric: { mode: 'image', text: '仅衣身使用此面料，领子沿用主体' }, color: { mode: 'auto', text: { inactive: true }, hex: 'invalid-hidden' } }, { fabric: true });
  assert.deepEqual(normalized.style.color, { mode: 'auto' });
  const prompt = buildDesignPrompt(normalized, output);
  assert.match(prompt, /仅衣身使用此面料，领子沿用主体/);
  assert.match(prompt, /若补充面料说明明确限定使用部位，则仅在该部位使用面料及其颜色/);
  assert.match(prompt, /fabric=retain 只保留材质，不自动保留该区域原色/);
  assert.doesNotMatch(prompt, /inactive|invalid-hidden/);
  assert.deepEqual((await input({ color: {} })).style.color, { mode: 'auto' });
});
