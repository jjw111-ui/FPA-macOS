import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sourceCode = await readFile(new URL('../public/design-workbench/sketch.js', import.meta.url), 'utf8');
const image = (id, extra = {}) => ({ id, name: id, src: `data:image/jpeg;base64,${Buffer.from(id).toString('base64')}`, thumbnail: `thumb-${id}`, width: 800, height: 1000, bytes: id.length, ...extra });
const operation = () => ({ tool: 'brush', color: '#222222', width: 4, symmetry: false, points: [{ x: 120, y: 200 }, { x: 320, y: 400 }] });
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ dirty = false, drawing = false, draftSourceKey, operations = [], visibleInk, includeSource = true } = {}) {
  const elements = new Map(), requests = [], loads = [], decoded = [], exported = [];
  const defaults = { fabricMode: 'text', fabricText: 'Cotton twill', colorMode: 'text', colorText: 'Gray', colorHex: '#687A5E' };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: defaults[id] || '', textContent: '', style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this[name] = value; }, replaceChildren() {}, append() {},
    });
    return elements.get(id);
  };
  const composite = image('composite', { src: 'data:image/png;base64,Y29tcG9zaXRl', bytes: 9 });
  const encoded = new Blob(['composite'], { type: 'image/png' });
  let activeSource = null;
  const board = {
    loadSource(source) { activeSource = source; loads.push(source); return Promise.resolve(); },
    ensureReady: async () => {},
    getDraft: () => ({ sourceKey: draftSourceKey ?? activeSource?.key, operations, settings: { includeSource } }),
    isDrawing: () => drawing,
    isDirty: () => dirty,
    hasVisibleInk: () => visibleInk ?? operations.some(item => item.tool !== 'clear'),
    exportBlob: async () => { exported.push(encoded); return encoded; },
    setReadOnly() {}, setRegionMode() {}, setLocked() {}, setRegionAvailable() {}, resize() {},
  };
  const sandbox = vm.createContext({
    console, URL, Blob, AbortController, AbortSignal, structuredClone,
    window: { addEventListener() {}, parent: { postMessage() {} }, confirm() { throw new Error('Unexpected browser confirmation'); } },
    document: { getElementById: element, querySelectorAll: () => [], createElement: tag => element(`created-${tag}`), createTextNode: text => ({ textContent: text }) },
    location: { origin: 'http://paint-test.invalid' },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {},
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', body: options.body });
      if (url === '/api/studio/design/generation-settings') return { ok: true, json: async () => ({ configured: true, protocol: 'openai' }) };
      throw new Error(`Unexpected network request: ${url}`);
    },
    outputReady: true, designOutputValues: () => ({ aspectRatio: '3:4', resolution: '1K', count: 1 }),
    applyOutputProtocol() {}, board, composite,
    decodeImage: async (blob, name) => { decoded.push({ blob, name }); return { ...composite, name }; },
  });
  const run = code => vm.runInContext(code, sandbox);
  run(sourceCode);
  // Image codecs and drawing are browser boundaries; integration functions keep
  // their actual source so validation, source selection, and request assembly run.
  run('paintBoard = board; imageFromBlob = decodeImage; ready = true;');
  const setState = value => { sandbox.nextState = value; run('state = { ...freshState(), ...nextState };'); };
  return { run, setState, elements, requests, loads, decoded, exported, composite, encoded };
}

test('局部材料按标注编号提交、图片仅传一次，关闭来源后不泄漏隐藏选项', () => {
  const h = harness();
  const local = { fabric: { mode: 'image', image: image('cuff'), text: '袖口' }, color: { mode: 'auto', text: '应被忽略' }, trims: [{ ...image('zip'), note: '红拉链' }] };
  h.setState({ sketch: image('source'), regions: [{ id: 'r1', x: .1, y: .1, w: .2, h: .2, note: '', placement: '', materials: local }] });
  assert.equal(h.run('validate()'), '');
  const request = h.run('buildRequest()');
  assert.equal(request.references.length, 3); assert.equal(request.references[1].targetRegion, 1); assert.equal(request.references[2].targetRegion, 1);
  assert.equal(request.references[0].regions[0].materials, undefined);
  assert.deepEqual(plain(request.references[0].regions[0].localStyle.color), { mode: 'auto' });
  assert.equal((JSON.stringify(request).match(/data:image/g) || []).length, 3);
  assert.doesNotMatch(JSON.stringify(h.run('captureDraft()')), /data:image/);
  assert.equal(h.run('captureDraft().state.regions[0].materials.trims[0].note'), '红拉链');
  assert.equal(h.run("buildRequest(currentMain(), 'photo_to_sketch').references.length"), 1);
  assert.equal(h.run("buildRequest(currentMain(), 'photo_to_sketch').references[0].regions[0].localStyle"), undefined);
  h.run("state.regions[0].materials.fabric.mode = 'inherit'; state.regions[0].materials.color.mode = 'inherit'; state.regions[0].materials.trims = [];");
  assert.equal(h.run('buildRequest().references.length'), 1);
});

test('同一画布按显式操作转换线稿或生成成衣，不再由旧入口决定请求类型', () => {
  for (const slot of ['photo', 'sketch']) {
    const h = harness(), original = image('source'); h.setState({ [slot]: original, entry: 'photo' });
    h.elements.set('fabricMode', { value: 'image' });
    assert.equal(h.run("validate('photo_to_sketch')"), '');
    assert.match(h.run('validate()'), /面料/);
    const request = h.run("buildRequest(currentMain(), 'photo_to_sketch')");
    assert.equal(request.designMode, 'photo_to_sketch'); assert.equal(request.references.length, 1);
    assert.equal(request.references[0].imageDataUrl, original.src); assert.equal(request.style, undefined);
    h.elements.set('fabricMode', { value: 'text' });
    assert.equal(h.run('buildRequest().designMode'), 'sketch_to_garment');
  }
});

test('转换结果解码失败不替换当前图、图层、材料或来源任务', async () => {
  const h = harness({ dirty: true, operations: [operation()] });
  h.setState({ sketch: image('working'), fabric: image('fabric'), candidates: ['/api/studio/files/result.png'], candidateJobId: 'new-job', sourceJobId: 'old-job', boards: { sketch: { sourceKey: 'working', operations: [operation()] }, photo: null } });
  h.run("imageFromUrl = async () => { throw new Error('offline'); };");
  const before = h.run('JSON.stringify(state)');
  await assert.rejects(h.run('applySketchCandidate(0)'), /offline/);
  assert.equal(h.run('JSON.stringify(state)'), before); assert.equal(h.exported.length, 0);
});

test('转换成功自动应用线稿，保留编辑后输入及材料，后续成衣引用正确任务', async () => {
  const h = harness({ dirty: true, operations: [operation()] });
  h.setState({ sketch: image('working'), fabric: image('fabric'), candidates: ['/api/studio/files/result.png'], candidateJobId: 'new-job', regions: [{ id: 'region', note: 'change', placement: '' }] });
  h.run("imageFromUrl = async () => ({ id: 'generated', src: 'data:image/png;base64,bmV3', name: 'line' });");
  await h.run('applySketchCandidate(0)');
  assert.equal(h.run('state.sketch.id'), 'generated'); assert.equal(h.run('state.photo.src'), h.composite.src);
  assert.equal(h.run('state.fabric.id'), 'fabric'); assert.equal(h.run('state.regions.length'), 0);
  assert.equal(h.run('buildRequest().sourceJobId'), 'new-job'); assert.equal(h.requests.length, 0);
});

test('失败任务保留画布和材料，成功任务图片载入失败后可免费重新载入', async () => {
  for (const status of ['failed', 'complete']) {
    const h = harness();
    h.setState({ sketch: image('working'), fabric: image('fabric'), activeJobId: 'conversion', activeJobMode: 'photo_to_sketch' });
    h.run(`api = async () => ({ jobs: [{ id: 'conversion', status: '${status}', image: '/api/studio/files/result.png', error: 'offline' }] }); renderAll = () => {}; imageFromUrl = async () => { throw new Error('offline'); };`);
    await h.run("pollJob('conversion')");
    assert.equal(h.run('state.sketch.id'), 'working'); assert.equal(h.run('state.fabric.id'), 'fabric');
    assert.equal(h.run('state.activeJobId'), null); assert.equal(h.run('busy'), false);
    if (status === 'complete') {
      assert.equal(h.run('state.candidates.length'), 1); assert.equal(h.run('state.sourceJobId'), null);
      assert.match(h.elements.get('generateStatus').textContent, /无需再次生成/);
      h.run("imageFromUrl = async () => ({ id: 'retried', src: 'data:image/png;base64,b2s=', name: 'line' });");
      await h.run('confirmSketch(0)');
      assert.equal(h.run('state.sketch.id'), 'retried'); assert.equal(h.run('state.sourceJobId'), 'conversion');
    }
    assert.equal(h.requests.length, 0);
  }
});

test('画板草稿只保存原图 ID 与独立笔迹，快照不重复保存原图 base64', () => {
  const h = harness(), sketch = image('sketch'), photo = image('photo'), fabric = image('fabric'), color = image('color');
  const trim = image('trim', { placement: 'Front placket', note: 'Keep button count' });
  const board = { sourceKey: sketch.id, operations: [operation()] };
  h.setState({ entry: 'sketch', sketch, photo, fabric, color, trims: [trim], boards: { photo: null, sketch: board } });
  const draft = h.run('captureDraft()');
  for (const [key, original] of Object.entries({ sketch, photo, fabric, color })) assert.deepEqual(plain(draft.state[key]), { id: original.id });
  assert.deepEqual(plain(draft.state.trims), [{ id: trim.id, placement: trim.placement, note: trim.note }]);
  assert.deepEqual(plain(draft.state.boards.sketch), board);
  assert.doesNotMatch(JSON.stringify(draft), /data:image\//);
  draft.state.boards.sketch.operations[0].points[0].x = 999;
  assert.equal(h.run('state.boards.sketch.operations[0].points[0].x'), 120);
  assert.equal(h.run('imageRecord(state.sketch).src'), sketch.src);
});

test('未编辑画板直接使用原始图片对象和字节，跳过 PNG 合成', async () => {
  const h = harness(), original = Object.freeze(image('original-jpeg'));
  h.setState({ entry: 'sketch', sketch: original });
  const main = await h.run('generationCanvas()');
  assert.equal(main, original);
  assert.equal(h.run('buildRequest(state.sketch).references[0].imageDataUrl'), original.src);
  assert.equal(h.exported.length, 0);
  assert.equal(h.decoded.length, 0);
  assert.equal(h.requests.length, 0);
});

test('编辑后的生成输入使用新合成图，原始图片及草稿来源保持不变', async () => {
  const h = harness({ dirty: true, operations: [operation()] }), original = Object.freeze(image('original'));
  h.setState({ entry: 'sketch', sketch: original, boards: { photo: null, sketch: { sourceKey: original.id, operations: [operation()] } } });
  const before = h.run('JSON.stringify(state)');
  const request = await h.run('(async () => buildRequest(await generationCanvas()))()');
  assert.equal(request.references[0].imageDataUrl, h.composite.src);
  assert.notEqual(request.references[0].imageDataUrl, original.src);
  assert.equal(request.designMode, 'sketch_to_garment');
  assert.equal(h.exported.length, 1);
  assert.equal(h.decoded[0].blob, h.encoded);
  assert.equal(h.run('state.sketch'), original);
  assert.equal(h.run('JSON.stringify(state)'), before);
});

test('画板来源不一致和未完成笔画均拒绝生成，不导出或提交半笔图像', async () => {
  const stale = harness({ dirty: true, draftSourceKey: 'previous-source' });
  stale.setState({ entry: 'sketch', sketch: image('current-source') });
  await assert.rejects(stale.run('generationCanvas()'), /画板仍在切换/);
  assert.equal(stale.exported.length, 0);
  assert.equal(stale.requests.length, 0);
  const drawing = harness({ dirty: true, drawing: true, operations: [operation()] });
  drawing.setState({ entry: 'sketch', sketch: image('current-source') });
  await assert.rejects(drawing.run('generationCanvas()'), /完成当前笔画/);
  await drawing.run('generate()');
  assert.equal(drawing.exported.length, 0);
  assert.equal(drawing.requests.length, 0);
  assert.match(drawing.elements.get('toast').textContent, /完成当前笔画/);
});

test('查看原款时生成仍选择已确认线稿，比较照片不会成为成衣主图', async () => {
  const h = harness(), sketch = image('confirmed-sketch'), photo = image('comparison-photo');
  h.setState({ entry: 'photo', sketch, photo });
  h.run('showSource = true;');
  assert.equal(h.run('previewSource().id'), `original:${photo.id}`);
  assert.equal(h.run('previewSource().slot'), undefined);
  const request = await h.run('(async () => buildRequest(await generationCanvas()))()');
  assert.equal(request.references[0].id, sketch.id);
  assert.equal(request.references[0].imageDataUrl, sketch.src);
  assert.equal(request.designMode, 'sketch_to_garment');
  assert.equal(h.loads.at(-1).key, sketch.id);
  assert.equal(h.run('showSource'), false);
  assert.equal(h.run('state.photo'), photo);
});

test('新建空白画板或清空笔迹后不提交生成任务', async () => {
  for (const operations of [[], [{ tool: 'clear' }], [operation(), { tool: 'clear' }]]) {
    const h = harness({ dirty: true, operations, visibleInk: false });
    h.setState({ entry: 'sketch', sketch: image('blank', { blankCanvas: true }) });
    await h.run('generate()');
    assert.equal(h.exported.length, 0);
    assert.equal(h.requests.some(request => request.method === 'POST'), false);
    assert.equal(h.run('state.activeJobId'), null);
    assert.equal(h.run('submitting'), false);
    assert.match(h.elements.get('generateStatus').textContent, /画板还是空白/);
  }
});

test('导入图片隐藏底图后若无可见笔迹，不合成或提交空白图片', async () => {
  const h = harness({ dirty: true, includeSource: false, visibleInk: false });
  h.setState({ entry: 'sketch', sketch: image('imported-sketch') });
  await h.run('generate()');
  assert.equal(h.exported.length, 0);
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  assert.equal(h.run('state.activeJobId'), null);
  assert.match(h.elements.get('generateStatus').textContent, /画板还是空白/);
});

test('替换来源清除旧画板笔迹和区域，同时保留面料选择', () => {
  const h = harness(), old = image('old'), next = image('new'), fabric = image('fabric');
  h.setState({ entry: 'sketch', sketch: old, photo: image('previous-photo'), fabric,
    boards: { photo: { sourceKey: 'previous-photo', operations: [operation()] }, sketch: { sourceKey: old.id, operations: [operation()] } },
    regions: [{ id: 'old-region', x: .1, y: .2, w: .3, h: .4 }], candidates: ['old-candidate'], results: ['old-result'], sourceJobId: 'old-job', next });
  h.run('showSource = true;');
  h.run('adoptSource(state.next); delete state.next;');
  assert.equal(h.run('state.sketch.id'), next.id);
  assert.equal(h.run('state.sketch.src'), next.src);
  assert.equal(h.run('state.photo'), null);
  assert.deepEqual(plain(h.run('state.boards')), { photo: null, sketch: null });
  for (const key of ['regions', 'candidates', 'results']) assert.equal(h.run(`state.${key}.length`), 0);
  assert.equal(h.run('state.sourceJobId'), null);
  assert.equal(h.run('showSource'), false);
  assert.equal(h.run('state.fabric'), fabric);
  assert.equal(h.requests.length, 0);
});

test('日常替换画板不再弹确认，兼容已编辑图层和旧笔迹草稿', () => {
  for (const options of [{}, { dirty: true }, { operations: [operation()] }, { includeSource: false }]) {
    const h = harness(options), original = image('original');
    h.setState({ sketch: original, boards: { photo: { dirty: true }, sketch: { operations: [operation()] } } });
    const before = h.run('JSON.stringify(state)');
    assert.equal(h.run('canReplaceBoard()'), true);
    assert.equal(h.run('JSON.stringify(state)'), before);
    assert.equal(h.requests.length, 0);
  }
});

test('草稿仅在 IndexedDB 事务成功后同步原生保存状态，失败继续保护刷新', async () => {
  for (const fail of [false, true]) {
    const h = harness({ dirty: true });
    h.setState({ sketch: image('original') });
    h.run(`
      let persistenceAcknowledged = 0, committed = false;
      board.persistenceToken = () => ({ revision: 1 });
      board.acknowledgePersistence = () => { if (!committed) throw new Error('Acknowledged before commit'); persistenceAcknowledged++; };
      database = { transaction() {
        const tx = { objectStore: () => ({ put() {} }) };
        Promise.resolve().then(() => { ${fail ? "tx.error = new Error('Disk full'); tx.onerror();" : 'committed = true; tx.oncomplete();'} });
        return tx;
      } };
      scheduleSave();
    `);
    assert.equal(await h.run('saveDraft()'), !fail);
    assert.equal(h.run('persistenceAcknowledged'), fail ? 0 : 1);
    assert.equal(h.run('typeof window.onbeforeunload'), fail ? 'function' : 'object');
    assert.equal(h.run('saveVersion === savedVersion'), !fail);
  }
});

test('未完成笔画、填色或变换仍阻止替换及清空，不显示浏览器确认', () => {
  const h = harness({ dirty: true, drawing: true });
  h.setState({ sketch: image('original') });
  const before = h.run('JSON.stringify(state)');
  assert.equal(h.run('canReplaceBoard()'), false);
  h.run('clearDraft()');
  assert.equal(h.run('JSON.stringify(state)'), before);
  assert.match(h.elements.get('toast').textContent, /请先完成当前笔画、填色或选区变换/);
  assert.equal(h.requests.length, 0);
});

test('清空线稿草稿直接执行并保存，不发起素材或生成记录删除请求', () => {
  const h = harness({ dirty: true });
  h.setState({ sketch: image('original'), fabric: image('fabric'), regions: [{ id: 'region' }] });
  // Rendering is a browser boundary; the real clear/reset/save flow still runs.
  h.run('renderAll = () => {}; showSource = true; selectedRegion = "region";');
  h.elements.set('designName', { value: '原草稿' });
  h.run('clearDraft()');
  assert.deepEqual(plain(h.run('state')), plain(h.run('freshState()')));
  assert.equal(h.run('showSource'), false);
  assert.equal(h.run('selectedRegion'), null);
  assert.equal(h.elements.get('designName').value, '');
  assert.ok(h.run('saveVersion') > 0);
  assert.equal(h.elements.get('generateStatus').textContent, '草稿已清空');
  assert.equal(h.requests.length, 0);
});

test('读取、提交、导出或生成中仍禁止清空草稿', () => {
  for (const guard of ['ready = false', 'busy = true', 'submitting = true', 'exporting = true', 'state.activeJobId = "job"']) {
    const h = harness();
    h.setState({ sketch: image('original') });
    h.run(guard);
    const before = h.run('JSON.stringify(state)');
    h.run('clearDraft()');
    assert.equal(h.run('JSON.stringify(state)'), before);
    assert.equal(h.requests.length, 0);
  }
});

test('移除设计参考图及其标注无需确认，只删除工作台草稿副本', async () => {
  const app = await readFile(new URL('../public/design-workbench/app.js', import.meta.url), 'utf8');
  const removeImage = app.slice(app.indexOf('function removeImage(id)'), app.indexOf('function fitCanvas()'));
  const deleted = [], first = image('first'), second = image('second');
  const state = { images: [first, second], annotations: [{ id: 'a', imageId: first.id }, { id: 'b', imageId: second.id }], activeImageId: first.id, primaryImageId: first.id, selectedAnnotationId: 'a' };
  const sandbox = vm.createContext({ state, savedRevision: 1, draftRevision: 1,
    selectedAnn: () => state.annotations.find(item => item.id === state.selectedAnnotationId),
    renderAll() {}, saveDraft: async () => {},
    storeRequest: async (...args) => deleted.push(args),
    confirm() { throw new Error('Unexpected browser confirmation'); },
  });
  vm.runInContext(removeImage + '\nremoveImage("first");', sandbox);
  await Promise.resolve();
  assert.deepEqual(state.images, [second]);
  assert.deepEqual(state.annotations, [{ id: 'b', imageId: second.id }]);
  assert.equal(state.activeImageId, second.id);
  assert.equal(state.primaryImageId, second.id);
  assert.equal(state.selectedAnnotationId, null);
  assert.deepEqual(deleted, [['images', 'delete', null, first.id]]);
});
