import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../public/design-workbench/full-paint-adapter.js', import.meta.url), 'utf8');
function harness() {
  const snapshots = [], dirtyEvents = [], loads = [], exports = [], geometry = [], acknowledgements = [];
  let listener, frame, key = null, dirty = false, busy = false, revision = 0, size = { width: 800, height: 1000 };
  const api = {
    async loadDocument(input) { loads.push(input); key = input.key; dirty = Boolean(input.dirty); size = { width: input.width || 800, height: input.height || 1000 }; },
    async exportProject() { const blob = new Blob([`${key}:${exports.length}`], { type: 'image/openraster' }); exports.push(blob); return blob; },
    isDirty: () => dirty, isBusy: () => busy, getSize: () => size,
    getRevision: () => revision,
    getDocumentInfo: () => ({ key }),
    acknowledgePersistence(token) { acknowledgements.push(token); return true; },
    hasVisibleContent: () => true, regionBounds: () => ({ x: .1, y: .2, w: .3, h: .4 }),
    capture: async () => new Blob([key], { type: 'image/png' }),
    setReadOnly() {}, setLocked() {}, setRegions() {}, fit() {},
  };
  const dom = () => ({ className: '', hidden: false, setAttribute() {}, append() {}, remove() {} });
  const document = { createElement(tag) { const item = dom(); if (tag === 'iframe') { frame = item; item.contentWindow = { FpaFullPaint: api, dispatchEvent() {} }; } return item; } };
  const window = { addEventListener(name, fn) { if (name === 'message') listener = fn; }, removeEventListener() {} };
  vm.runInNewContext(code, { window, document, location: { origin: 'http://unit.invalid' }, setTimeout: () => 1, clearTimeout() {}, Event, Blob });
  const board = new window.FpaPaintBoard({ viewport: dom(), shell: dom(), toolbar: dom(), onChange: draft => snapshots.push(draft), onDirty: () => dirtyEvents.push(key), onDocumentChange: value => geometry.push(value) });
  const message = data => listener({ origin: 'http://unit.invalid', source: frame.contentWindow, data });
  message({ type: 'fpa:paint-ready' });
  return { board, api, snapshots, dirtyEvents, loads, exports, geometry, acknowledgements,
    change(extra = {}) { dirty = true; revision++; message({ type: 'fpa:paint-change', key, ...extra }); },
    editBeforeNotification() { dirty = true; revision++; },
    busy(value) { busy = value; }, message,
  };
}
const source = key => ({ key, src: `data:image/png;base64,${key}`, width: 800, height: 1000 });

test('轻量画板提交使用原尺寸合成接口，原图引用不被预览替换', async () => {
  const h = harness(), original = Object.freeze(source('large'));
  let exports = 0;
  h.api.captureOriginal = async () => { exports++; return new Blob(['original-size']); };
  await h.board.loadSource(original);
  assert.equal(await (await h.board.exportBlob()).text(), 'original-size');
  assert.equal(exports, 1);
  assert.equal(h.board.source, original);
});

test('未编辑旧工程迁移预览后不继续携带旧尺寸工程', async () => {
  const h = harness();
  h.api.getQuickSettings = () => ({ sourceLayerId: 1, preview: { width: 5316, height: 7970, editWidth: 1366, editHeight: 2048 } });
  await h.board.loadSource(source('large'), { engine: 'weebpaint', dirty: false, project: new Blob(['old-full-size']) });
  assert.equal(h.board.getDraft().project, null);
  h.change(); await h.board.flushDraft();
  assert.equal(h.board.getDraft().quickSettings.preview.editHeight, 2048);
  assert.ok(h.board.getDraft().project instanceof Blob);
});

test('仅落盘确认清除原生未保存标记，不改变出图所需的编辑状态', async () => {
  const h = harness(); await h.board.loadSource(source('A')); h.change();
  assert.equal(h.board.persistenceToken(), null);
  await h.board.flushDraft();
  assert.equal(h.acknowledgements.length, 0);
  const token = h.board.persistenceToken();
  assert.equal(h.board.acknowledgePersistence(token), true);
  assert.equal(h.acknowledgements.length, 1);
  assert.equal(h.board.isDirty(), true);
});

test('旧快照确认不能覆盖新笔画、未完成操作或已切换的画板', async () => {
  for (const change of ['editBeforeNotification', 'busy', 'switch']) {
    const h = harness(); await h.board.loadSource(source('A')); h.change(); await h.board.flushDraft();
    const token = h.board.persistenceToken();
    if (change === 'busy') h.busy(true);
    else if (change === 'switch') await h.board.loadSource(source('B'));
    else h.editBeforeNotification();
    assert.equal(h.board.acknowledgePersistence(token), false);
    assert.equal(h.acknowledgements.length, 0);
  }
});

test('清空草稿落盘后可解除隐藏旧画板的刷新拦截', async () => {
  const h = harness(); await h.board.loadSource(source('A')); h.change(); await h.board.loadSource(null);
  const token = h.board.persistenceToken();
  assert.equal(token.sourceKey, null);
  assert.equal(h.board.acknowledgePersistence(token), true);
  assert.equal(h.board.source, null);
});

test('完整画板未编辑不重复编码，编辑工程作为 Blob 保存且源图保持独立', async () => {
  const h = harness(), original = Object.freeze(source('A'));
  await h.board.loadSource(original); await h.board.flushDraft();
  assert.equal(h.exports.length, 0);
  h.change(); await h.board.flushDraft();
  assert.equal(h.exports.length, 1);
  assert.equal(h.snapshots[0].engine, 'weebpaint');
  assert.notEqual(h.snapshots[0].project, h.exports[0]);
  assert.equal(await h.snapshots[0].project.text(), await h.exports[0].text());
  assert.equal(h.snapshots[0].sourceKey, original.key);
  assert.equal('src' in h.snapshots[0], false);
  await h.board.flushDraft(); assert.equal(h.exports.length, 1);
});

test('完整画板来源切换先保存原工程，返回同一来源恢复其分层工程', async () => {
  const h = harness(); await h.board.loadSource(source('A'));
  h.change(); await h.board.loadSource(source('B'));
  const originalProject = h.snapshots[0].project;
  assert.equal(h.snapshots[0].sourceKey, 'A');
  h.change(); await h.board.loadSource(source('A'));
  assert.equal(h.loads.at(-1).project, originalProject);
  assert.equal(h.loads.at(-1).dirty, true);
  assert.equal(h.board.getDraft().sourceKey, 'A');
  assert.equal(h.snapshots[1].sourceKey, 'B');
});

test('对称和底图来源随独立草稿保存，切换来源后恢复快捷设置', async () => {
  const h = harness();
  let quickSettings = { symmetry: true, sourceLayerId: 1 };
  h.api.getQuickSettings = () => ({ ...quickSettings });
  await h.board.loadSource(source('A'));
  h.change(); await h.board.flushDraft();
  assert.deepEqual(h.snapshots[0].quickSettings, quickSettings);
  await h.board.loadSource(source('B'));
  quickSettings = { symmetry: false, sourceLayerId: 5 };
  h.change(); await h.board.flushDraft();
  await h.board.loadSource(source('A'));
  assert.deepEqual(h.loads.at(-1).quickSettings, { symmetry: true, sourceLayerId: 1 });
});

test('快捷框选只接受当前可编辑来源，专注模式消息独立传递', async () => {
  const h = harness(), regions = [];
  let focused = 0;
  h.board.onRegion = box => regions.push(box);
  h.board.onToggleFocus = () => focused++;
  await h.board.loadSource(source('A'));
  const box = { x: .1, y: .2, w: .3, h: .4 };
  const message = key => h.message({ type: 'fpa:paint-region', key, box });
  message('A'); assert.equal(regions.length, 0);
  h.board.setRegionAvailable(true);
  message('B'); assert.equal(regions.length, 0);
  message('A'); assert.deepEqual(regions, [box]);
  h.board.setReadOnly(true); message('A'); assert.equal(regions.length, 1);
  h.board.setReadOnly(false); h.board.setLocked(true); message('A'); assert.equal(regions.length, 1);
  h.message({ type: 'fpa:paint-focus' }); assert.equal(focused, 1);
});

test('快速来源切换按顺序完成，最终文档与请求源一致', async () => {
  const h = harness();
  await Promise.all([h.board.loadSource(source('A')), h.board.loadSource(source('B')), h.board.loadSource(source('C'))]);
  await h.board.ensureReady();
  assert.deepEqual(h.loads.map(value => value.key), ['A', 'B', 'C']);
  assert.equal(h.board.getDraft().sourceKey, 'C');
});

test('原生文档更换与尺寸变化传递同一 sourceKey，来源载入不冒充用户修改', async () => {
  const h = harness(); await h.board.loadSource(source('A'));
  assert.equal(h.dirtyEvents.length, 0);
  h.message({ type: 'fpa:paint-change', key: 'B', sizeChanged: true });
  assert.equal(h.geometry.length, 0);
  h.change({ sizeChanged: true });
  assert.equal(h.geometry[0].sourceKey, 'A');
  assert.equal(h.geometry[0].width, 800);
  assert.equal(h.dirtyEvents.length, 1);
});

test('旧版笔迹传入迁移接口，不当作新 ORA 工程解码', async () => {
  const h = harness(), legacy = { sourceKey: 'A', version: 1, operations: [{ tool: 'line', points: [] }] };
  await h.board.loadSource(source('A'), legacy);
  assert.equal(h.loads[0].legacyDraft, legacy);
  assert.equal(h.loads[0].project, undefined);
});

test('未完成原生操作不能导出或保存半成品', async () => {
  const h = harness(); await h.board.loadSource(source('A')); h.change(); h.busy(true);
  await assert.rejects(h.board.exportBlob(), /完成当前/);
  await assert.rejects(h.board.flushDraft(), /完成当前/);
  assert.equal(h.exports.length, 0);
  h.busy(false);
  // A failed persistence attempt must remain retryable without switching source.
  await h.board.flushDraft();
  assert.equal(h.exports.length, 1);
});

test('第二次编辑后立即切图，在异步变更通知之前也保存最新工程', async () => {
  const h = harness(); await h.board.loadSource(source('A')); h.change(); await h.board.flushDraft();
  const firstProject = h.exports[0];
  h.editBeforeNotification(); await h.board.loadSource(source('B'));
  assert.equal(h.exports.length, 2);
  assert.notEqual(h.snapshots.at(-1).project, firstProject);
  assert.equal(h.snapshots.at(-1).sourceKey, 'A');
});
