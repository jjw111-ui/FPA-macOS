'use strict';
const $ = id => document.getElementById(id);
function node(tag, className = '', text = '') { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; }
const formIds = ['designName', 'designNote', 'fabricMode', 'fabricText', 'colorMode', 'colorText', 'colorHex', 'outputAspect', 'outputResolution', 'outputCount', 'outputModeration', 'outputSafety', 'outputSearch', 'sketchProvider'];
const freshState = () => ({ inspectorTab: 'product', photo: null, sketch: null, fabric: null, color: null, trims: [], regions: [], boards: { photo: null, sketch: null }, candidates: [], candidateIndex: 0, candidateJobId: null, appliedCandidateUrl: null, results: [], sourceJobId: null, activeJobId: null, activeJobMode: null });
let state = freshState(), revision = 0, ready = false, busy = false, submitting = false, polling = null, saveTimer = null, toastTimer = null, database = null, saveChain = Promise.resolve(), saveVersion = 0, showSource = false, selectedRegion = null, drawing = false, pointerStart = null;
let savedVersion = 0;
let paintBoard = null, exporting = false;
const storedImageIds = new Set();
const categories = { upperbody: '上衣', wholebody_up: '外套', lowerbody: '下装', dress: '内搭', shoes: '鞋子', accessories_up: '配饰', fabric: '面料', trims: '辅料', person: '人物体型', face: '人物人脸', pose: '人物姿势', scene: '场景' };
const picker = { target: 'source', assets: [], selected: new Set(), page: 0, request: 0, loading: false, previewCache: new Map(), previewController: null };
const clamp = (number, min = 0, max = 1) => Math.max(min, Math.min(max, number));
const notifyParent = (type, rest = {}) => window.parent.postMessage({ type, ...rest }, location.origin);
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500); }
function status(message, error = false) { $('generateStatus').textContent = message; $('generateStatus').classList.toggle('error', error); }
async function api(path, options = {}) { const response = await fetch(`/api/studio/${path}`, { signal: AbortSignal.timeout(20000), ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `请求失败（${response.status}）`); return result; }
function allowedFileUrl(path) { const url = new URL(path, location.origin); if (url.origin !== location.origin || !/^\/api\/(?:studio\/files|import\/library)\/[\w.-]+$/.test(url.pathname) || url.search || url.hash) throw new Error('参考图片地址无效，请重新选择图片'); return url.href; }
function readFile(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); }); }
function loadImage(src) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('图片无法显示，请换一张 PNG、JPEG 或 WebP 图片')); image.src = src; }); }
async function imageFromBlob(blob, name) {
  if (!/^image\/(png|jpeg|webp)$/i.test(blob.type)) throw new Error('请使用 PNG、JPEG 或 WebP 图片');
  if (blob.size > 50 * 1024 * 1024) throw new Error('单张原图不能超过 50 MB');
  const src = await readFile(blob), image = await loadImage(src), width = image.naturalWidth, height = image.naturalHeight;
  if (width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw new Error('图片尺寸过大，请使用单边不超过 16384 像素、总像素不超过 6710 万的图片');
  const canvas = document.createElement('canvas'), scale = Math.min(1, 280 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale)); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return { id: crypto.randomUUID(), name, src, thumbnail: canvas.toDataURL('image/webp', .78), width, height, bytes: blob.size };
}
async function imageFromUrl(url, name) { const response = await fetch(allowedFileUrl(url), { signal: AbortSignal.timeout(20000) }); if (!response.ok) throw new Error(`图片“${name}”读取失败（${response.status}）`); return imageFromBlob(await response.blob(), name); }
function openDatabase() { return new Promise((resolve, reject) => { const request = indexedDB.open('fpa-sketch-workbench', 2); request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts'); if (!db.objectStoreNames.contains('images')) db.createObjectStore('images'); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function readStore(storeName, key) { return new Promise((resolve, reject) => { const transaction = database.transaction(storeName, 'readonly'), request = transaction.objectStore(storeName).get(key); transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
function imageMeta(image) { return image ? { id: image.id, ...(image.placement !== undefined ? { placement: image.placement } : {}), ...(image.note !== undefined ? { note: image.note } : {}) } : null; }
function regionImages(region, active = false) { const local = region.materials; return local ? [(!active || local.fabric.mode === 'image') && local.fabric.image, (!active || local.color.mode === 'image') && local.color.image, ...local.trims].filter(Boolean) : []; }
function draftImages(source = state) { return [source.photo, source.sketch, source.fabric, source.color, ...(source.trims || []), ...(source.regions || []).flatMap(region => regionImages(region))].filter(Boolean); }
function imageRecord(image) { const { id, name, src, thumbnail, width, height, bytes, blankCanvas } = image; return { id, name, src, thumbnail, width, height, bytes, ...(blankCanvas ? { blankCanvas: true } : {}) }; }
function cloneBoardSnapshot(board) {
  if (!board) return null;
  const copyOperation = operation => operation ? { ...operation, points: Array.isArray(operation.points) ? operation.points.map(point => ({ ...point })) : operation.points } : operation;
  return { ...board, operations: Array.isArray(board.operations) ? board.operations.map(copyOperation) : board.operations, redo: Array.isArray(board.redo) ? board.redo.map(copyOperation) : board.redo, quickSettings: board.quickSettings ? { ...board.quickSettings, ...(board.quickSettings.preview ? { preview: { ...board.quickSettings.preview } } : {}) } : board.quickSettings };
}
function captureDraft() {
  // Do not synchronously structuredClone the embedded editor's OpenRaster Blob
  // on every annotation keystroke. IndexedDB performs its own structured clone
  // when the snapshot is written; keeping the Blob reference here removes a
  // noticeable main-thread pause while preserving the exact project snapshot.
  const boards = Object.fromEntries(['photo', 'sketch'].map(slot => [slot, cloneBoardSnapshot(state.boards?.[slot])]));
  return { version: 2, state: { ...state, boards, photo: imageMeta(state.photo), sketch: imageMeta(state.sketch), fabric: imageMeta(state.fabric), color: imageMeta(state.color), trims: state.trims.map(imageMeta), regions: state.regions.map(region => ({ ...region, ...(region.materials ? { materials: { fabric: { ...region.materials.fabric, image: imageMeta(region.materials.fabric.image) }, color: { ...region.materials.color, image: imageMeta(region.materials.color.image) }, trims: region.materials.trims.map(imageMeta) } } : {}) })), candidates: [...state.candidates], results: [...state.results] }, form: Object.fromEntries(formIds.map(id => [id, $(id).value])) };
}
async function hydrateDraft(draft) {
  const restored = { ...freshState(), ...draft.state };
  restored.boards = { photo: null, sketch: null, ...restored.boards };
  if (draft.version === 1 || draft.version === 2) {
    const images = new Map();
    await Promise.all(draftImages(restored).map(async meta => { const image = await readStore('images', meta.id); if (!image?.src) throw new Error(`草稿原图缺失（${meta.id}）`); images.set(meta.id, image); storedImageIds.add(meta.id); }));
    for (const key of ['photo', 'sketch', 'fabric', 'color']) if (restored[key]) restored[key] = { ...images.get(restored[key].id), ...restored[key] };
    restored.trims = restored.trims.map(meta => ({ ...images.get(meta.id), ...meta }));
    for (const region of restored.regions || []) if (region.materials) {
      for (const kind of ['fabric', 'color']) { const meta = region.materials[kind].image; if (meta) region.materials[kind].image = { ...images.get(meta.id), ...meta }; }
      region.materials.trims = region.materials.trims.map(meta => ({ ...images.get(meta.id), ...meta }));
    }
  }
  restored.regions = (restored.regions || []).map(region => ({ ...region, id: region.id || crypto.randomUUID() }));
  // Old two-step drafts remain usable without forcing a new upload or conversion.
  if (restored.candidates.length && !restored.candidateJobId) restored.candidateJobId = restored.sourceJobId;
  if (!restored.sketch) restored.sourceJobId = null;
  return restored;
}
function scheduleSave(delay = 250, options = {}) { if (!ready) return; saveVersion++; clearTimeout(saveTimer); $('draftStatus').textContent = '草稿待保存'; window.onbeforeunload = event => { if (saveVersion !== savedVersion) { event.preventDefault(); event.returnValue = ''; return ''; } }; const flushBoard = options.flushBoard !== false; saveTimer = setTimeout(() => saveDraft(flushBoard), typeof delay === 'number' ? delay : 250); }
async function saveDraft(flushBoard = true) {
  clearTimeout(saveTimer); saveTimer = null;
  // Text/settings edits do not need to export the embedded OpenRaster project.
  // Still flush immediately when the paint engine reports an unsaved revision,
  // so a metadata-only save can never overwrite a newer stroke.
  const pendingBoard = !flushBoard && paintBoard?.persistenceToken && !paintBoard.persistenceToken();
  try { if (flushBoard || pendingBoard) await paintBoard?.flushDraft?.(); }
  catch (error) { $('draftStatus').textContent = '画板尚未保存'; status(error.message, true); return false; }
  // Copy only small metadata. Immutable original data URLs are referenced here;
  // only previously unseen image IDs are copied into IndexedDB.
  const snapshot = captureDraft(), version = saveVersion, images = draftImages().map(imageRecord);
  const paintToken = paintBoard?.persistenceToken?.();
  saveChain = saveChain.catch(() => false).then(async () => {
    try {
      if (!database) database = await openDatabase();
      const newImages = images.filter(image => !storedImageIds.has(image.id));
      await new Promise((resolve, reject) => { const transaction = database.transaction(['drafts', 'images'], 'readwrite'); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); for (const image of newImages) transaction.objectStore('images').put(image, image.id); transaction.objectStore('drafts').put(snapshot, 'current'); });
      for (const image of newImages) storedImageIds.add(image.id);
      paintBoard?.acknowledgePersistence?.(paintToken);
      savedVersion = Math.max(savedVersion, version); if (version === saveVersion) { $('draftStatus').textContent = '草稿已保存'; window.onbeforeunload = null; } return true;
    } catch { if (version === saveVersion) { $('draftStatus').textContent = '草稿保存失败，请勿关闭页面'; toast('草稿保存失败，请勿刷新或关闭页面。当前编辑内容仍保留。'); } return false; }
  });
  return saveChain;
}
function setForm(form = {}) { for (const id of formIds) { if (form[id] === undefined) continue; const input = $(id), value = String(form[id]); if (input.tagName === 'SELECT' && !Array.from(input.options).some(option => option.value === value)) { const option = node('option', '', value); option.value = value; input.append(option); } input.value = value; } const hex = normalizeHex($('colorHex').value); if (hex) $('colorPicker').value = hex; }
function compile() { renderStyleFields(); scheduleSave(450, { flushBoard: false }); updateControls(); }
function renderInspectorTab() {
  const selected = state.inspectorTab === 'output' ? 'output' : 'product';
  state.inspectorTab = selected;
  document.querySelectorAll('[data-inspector-tab]').forEach(button => { const active = button.dataset.inspectorTab === selected; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  document.querySelectorAll('[data-inspector-panel]').forEach(panel => { panel.hidden = panel.dataset.inspectorPanel !== selected; });
  if (selected === 'local') $('regionsDetails').open = true;
}
function selectInspectorTab(tab) {
  state.inspectorTab = tab; renderInspectorTab();
  const inspector = document.querySelector('.sketch-inspector'); if (inspector) inspector.scrollTop = 0;
  scheduleSave();
}
function setMaterialsOpen(open) {
  const workspace = $('workspace');
  open = Boolean(open) || !workspace.classList.contains('is-paint-focused');
  workspace.classList.toggle('is-materials-open', open);
  $('materialsPanelBtn').setAttribute('aria-pressed', String(open));
}
function currentMain() { return state.sketch || state.photo; }
function canAnnotate() { return Boolean(currentMain()) && !showSource; }
function referenceImages() { return [currentMain(), $('fabricMode').value === 'image' && state.fabric, $('colorMode').value === 'image' && state.color, ...state.trims, ...state.regions.flatMap(region => regionImages(region, true))].filter(Boolean); }
function localTarget(target) { const [prefix, id, kind] = target.split(':'); if (prefix !== 'region') return null; const region = state.regions.find(item => item.id === id); if (!region || !['fabric', 'color', 'trims'].includes(kind)) throw new Error('这处标注已移除，请重新选择'); return { region, kind, local: regionMaterials(region) }; }
function capacity(target) { if (target === 'source') return 1; const scoped = localTarget(target), count = referenceImages().length, replacing = scoped ? scoped.kind !== 'trims' && scoped.local[scoped.kind].mode === 'image' && Boolean(scoped.local[scoped.kind].image) : target !== 'trims' && Boolean(state[target]) && $(target + 'Mode').value === 'image'; return Math.max(0, 10 - count + Number(replacing)); }
function invalidate() { revision++; clearTimeout(polling); polling = null; state.activeJobId = null; state.activeJobMode = null; state.results = []; drawing = false; pointerStart = null; }
function adoptSource(image) { invalidate(); state.boards = { photo: null, sketch: null }; state.sourceJobId = null; state.candidateJobId = null; state.appliedCandidateUrl = null; state.candidates = []; state.candidateIndex = 0; state.regions = []; selectedRegion = null; showSource = false; state.photo = null; state.sketch = image; status(''); }
function installImage(target, image) {
  const scoped = localTarget(target);
  if (scoped) { const { local, kind } = scoped; if (kind === 'trims') local.trims.push({ ...image, note: '' }); else { local[kind].image = image; local[kind].mode = 'image'; if (kind === 'fabric' && local.color.mode === 'inherit') local.color.mode = 'auto'; } }
  else if (target === 'source') adoptSource(image); else if (target === 'trims') state.trims.push({ ...image, placement: '', note: '' }); else { state[target] = image; $(target + 'Mode').value = 'image'; }
}
function setSketchMenu(open) { $('sketchConvertOptions').hidden = !open; $('convertSketchBtn').setAttribute('aria-expanded', String(open)); }
function updateControls() {
  const locked = busy || submitting || exporting || !ready, pending = Boolean(state.activeJobId);
  if (locked || pending || !currentMain()) setSketchMenu(false);
  $('generateBtn').disabled = locked || pending || !currentMain(); $('generateBtn').textContent = pending && state.activeJobMode === 'sketch_to_garment' ? '生成中…' : '生成真实成衣';
  $('materials').disabled = locked || pending || !currentMain(); $('materials').hidden = false;
  $('localEdits').disabled = locked || pending || !canAnnotate();
  $('annotationDock').disabled = locked || pending || !canAnnotate();
  const vector = $('sketchProvider').value === 'quiver';
  $('workflowHint').textContent = vector ? '输入一句对话式要求即可，例如“夹克”；参考图仍作为主要依据。' : '整体设置用于整件衣服；标注里的面料、配色和辅料只用于对应部位。';
  $('designNoteLabel').textContent = vector ? '对话指令（可选）' : '整体设计要求（可选）';
  $('designNote').placeholder = vector ? '例如：夹克；也可以写更完整的款式要求' : '描述整体效果；具体部位请在画布上标注';
  // This button is the local, always-available entry point for the current
  // line-art canvas -> garment workflow. Quiver is selected only from the
  // top “转为线稿” menu, so it must not replace the garment generation action.
  $('vectorGenerateBtn').hidden = !currentMain(); $('vectorGenerateBtn').textContent = pending && state.activeJobMode === 'sketch_to_garment' ? '生成中…' : '生成真实成衣'; $('vectorGenerateBtn').disabled = locked || pending;
  document.querySelectorAll('#candidateList button').forEach(button => button.disabled = locked || pending);
  document.querySelectorAll('.sketch-topbar button:not(#generateBtn),.sketch-library input,.sketch-library button,#emptyNewCanvasBtn').forEach(element => element.disabled = locked || pending);
  $('convertSketchBtn').disabled = locked || pending || !currentMain(); $('convertSketchBtn').textContent = submitting ? '正在提交…' : pending && state.activeJobMode === 'photo_to_sketch' ? '转换中…' : '转为线稿 ▾';
  $('exportCanvasBtn').disabled = locked || !previewSource();
  paintBoard?.setLocked(locked || pending);
  paintBoard?.setRegionAvailable(canAnnotate());
  $('workspace').setAttribute('aria-busy', String(locked)); $('referenceCount').textContent = `${referenceImages().length} / 10 张参考图`;
}
function previewSource() { if (showSource && state.photo) return { ...state.photo, id: `original:${state.photo.id}`, name: '转换前（只读）', readOnly: true }; if (state.sketch) return { ...state.sketch, slot: 'sketch', name: state.sketch.blankCanvas ? '手绘画板' : '设计画板' }; return state.photo ? { ...state.photo, slot: 'photo', name: '设计画板' } : null; }
function fitCanvas() { paintBoard?.resize(); }
function renderSourceLibrary() {
  const items = [['photo', state.photo], ['sketch', state.sketch]].filter(([, image]) => image && !image.blankCanvas);
  $('sourceCount').textContent = `${items.length} 项`;
  $('sourceDescription').textContent = '照片或线稿都可直接编辑。新导入会替换当前画布。';
  $('sourceList').replaceChildren(...items.map(([slot, source]) => {
    const active = slot === 'sketch' ? !showSource : !state.sketch || Boolean(showSource);
    const card = node('div', `thumb${active ? ' active' : ''}`), button = node('button', 'thumb-select');
    button.type = 'button'; button.setAttribute('aria-pressed', String(active));
    const label = slot === 'photo' && state.sketch ? '转换前' : '当前画布';
    button.setAttribute('aria-label', `查看${label}`);
    if (source.blankCanvas) button.append(node('div', 'sketch-blank-thumb'));
    else { const image = node('img'); image.src = source.thumbnail || source.src; image.alt = label; button.append(image); }
    const info = node('div', 'thumb-info'); info.append(node('strong', '', label), node('span', '', `${source.blankCanvas ? '画布' : '原图'} ${source.width} × ${source.height}`)); button.append(info);
    button.onclick = () => {
      if (busy || submitting || exporting || state.activeJobId || !canReplaceBoard()) return;
      showSource = slot === 'photo' && Boolean(state.sketch || state.candidates.length); drawing = false; renderPreview(); updateControls();
    };
    card.append(button); return card;
  }));
}
function renderPreview() {
  const preview = previewSource(); $('emptyPreview').hidden = Boolean(preview); $('canvasShell').hidden = !preview; $('previewTitle').textContent = preview?.name || '线稿画板';
  paintBoard?.setReadOnly(Boolean(preview?.readOnly));
  paintBoard?.setRegionAvailable(canAnnotate());
  paintBoard?.loadSource(preview ? { key: preview.id, src: preview.src, width: preview.width, height: preview.height, blankCanvas: preview.blankCanvas } : null, preview?.slot ? state.boards[preview.slot] : null).then(() => {
    if (previewSource()?.id === preview?.id) renderBoardHint();
  }).catch(error => status(error.message, true));
  $('emptyTitle').textContent = '上传照片或线稿，也可直接手绘'; $('uploadSourceText').textContent = '＋ 上传照片 / 线稿';
  renderBoardHint();
  $('viewSourceBtn').hidden = !(state.photo && state.sketch); $('viewSourceBtn').textContent = showSource ? '返回当前画布' : '查看转换前';
  $('candidateSection').hidden = !state.candidates.length || state.candidates.length === 1 && Boolean(state.appliedCandidateUrl);
  $('candidateList').replaceChildren(...state.candidates.map((src, index) => { const button = node('button', 'sketch-candidate'), image = node('img'), applied = state.appliedCandidateUrl === src; button.type = 'button'; button.disabled = busy || submitting || exporting || Boolean(state.activeJobId); button.setAttribute('aria-pressed', String(applied)); image.src = src; image.alt = `线稿 ${index + 1}`; button.append(image, document.createTextNode(`${applied ? '当前' : '使用'}线稿 ${index + 1}`)); button.onclick = () => { if (!applied) confirmSketch(index); }; return button; }));
  renderSourceLibrary(); renderRegionOverlay(); requestAnimationFrame(fitCanvas);
}
function renderBoardHint() {
  const source = previewSource();
  if (!source) { $('boardHint').textContent = '尚未打开文档'; return; }
  // Both the legacy embedded editor and the lightweight canvas adapter expose
  // the same document contract. The lightweight adapter intentionally has no
  // iframe `api`, so use its source/loading state instead of requiring it.
  if (paintBoard?.loading || paintBoard?.source?.key !== source.id) {
    $('boardHint').textContent = '正在载入画板…'; return;
  }
  const size = paintBoard.getDocumentSize(), preview = paintBoard.api?.getQuickSettings?.()?.preview;
  if (preview) {
    const output = paintBoard.api.getOutputSize?.() || { width: preview.width, height: preview.height };
    $('boardHint').textContent = `编辑预览 ${size.width} × ${size.height} · 原图 ${preview.width} × ${preview.height}${output.width !== preview.width || output.height !== preview.height ? ` · 输出 ${output.width} × ${output.height}` : ' · 原尺寸出图'}`;
  } else {
    const legacy = !source.blankCanvas && paintBoard.getDraft()?.project && Math.max(size.width, size.height) > 2048;
    $('boardHint').textContent = `${size.width} × ${size.height} 像素 · ${legacy ? '原尺寸草稿（未缩小）' : source.readOnly ? '只读预览' : '分层画板'}`;
  }
}
function removeButton(label, action) { const button = node('button', 'sketch-remove', '×'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.onclick = action; return button; }
function renderMaterialPreview(kind) { const host = $(kind + 'Preview'), image = state[kind]; host.hidden = !image; if (!image) { host.replaceChildren(); return; } const picture = node('img'); picture.src = image.thumbnail || image.src; picture.alt = kind === 'fabric' ? '面料样本' : '配色色卡'; host.replaceChildren(picture, node('span', '', image.name), removeButton(`移除${kind === 'fabric' ? '面料' : '色卡'}`, () => { state[kind] = null; renderMaterialPreview(kind); compile(); })); }
function renderStyleFields() {
  const fabricMode = $('fabricMode').value, colorMode = $('colorMode').value;
  $('fabricImageFields').hidden = fabricMode !== 'image'; $('fabricTextLabel').textContent = fabricMode === 'text' ? '面料说明' : '面料补充说明（可选）';
  $('colorMode').querySelector('option[value="auto"]').disabled = false;
  $('colorImageFields').hidden = colorMode !== 'image'; $('colorCustomFields').hidden = colorMode !== 'custom'; $('colorTextFields').hidden = colorMode === 'auto';
}
function renderTrims() {
  $('trimsList').replaceChildren(...state.trims.map(trim => { const item = node('div', 'sketch-trim'), preview = node('div', 'sketch-material-preview'), image = node('img'); image.src = trim.thumbnail || trim.src; image.alt = '辅料参考'; preview.append(image, node('span', '', trim.name), removeButton(`移除辅料 ${trim.name}`, () => { state.trims = state.trims.filter(value => value.id !== trim.id); renderTrims(); compile(); })); item.append(preview);
    for (const [key, label, placeholder, limit] of [['placement', '应用部位', '例如：门襟 / 袖口 / 左胸', 160], ['note', '补充说明（可选）', '例如：哑光黑，保留现有位置', 2000]]) { const id = `trim-${trim.id}-${key}`, title = node('label', '', label), input = node('input', 'input'); title.htmlFor = id; input.id = id; input.value = trim[key] || ''; input.placeholder = placeholder; input.maxLength = limit; input.oninput = () => { trim[key] = input.value; scheduleSave(); }; item.append(title, input); } return item;
  }));
}
function regionMaterials(region) { return region.materials ||= { fabric: { mode: 'inherit', text: '', image: null }, color: { mode: 'inherit', text: '', hex: '#687A5E', image: null }, trims: [] }; }
function hasRegionMaterials(region) { const local = region.materials; return Boolean(local && (local.fabric.mode !== 'inherit' || local.color.mode !== 'inherit' || local.trims.length)); }
function renderRegionMaterials(region) {
  const local = regionMaterials(region), host = node('div', 'sketch-local-materials');
  const refresh = () => { renderRegions(); updateControls(); scheduleSave(); };
  const field = (label, control, name) => { const title = node('label', '', label); title.htmlFor = control.id = `region-${region.id}-${name}`; host.append(title, control); };
  const picture = (image, remove) => { const row = node('div', 'sketch-material-preview'), img = node('img'); img.src = image.thumbnail || image.src; img.alt = image.name; row.append(img, node('span', '', image.name), removeButton(`移除 ${image.name}`, remove)); host.append(row); };
  const uploads = (kind, label) => {
    const row = node('div', 'sketch-upload-row'), uploadLabel = node('label', 'btn file-button'), input = node('input'), library = node('button', 'btn', '素材库');
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.multiple = kind === 'trims'; input.id = `region-${region.id}-${kind}-file`; input.setAttribute('aria-label', `上传此处${label}`);
    const target = `region:${region.id}:${kind}`; input.onchange = () => upload(target, input.files); uploadLabel.append(input, node('span', '', `上传${label}`)); library.type = 'button'; library.id = `region-${region.id}-${kind}-library`; library.onclick = () => openPicker(target); row.append(uploadLabel, library); host.append(row);
  };
  for (const [kind, title, options] of [
    ['fabric', '此处面料', [['inherit', '沿用整体面料'], ['image', '单独选面料图片'], ['text', '单独描述面料']]],
    ['color', '此处配色', [['inherit', '沿用整体配色'], ['auto', '跟随此处面料颜色'], ['image', '单独选色卡'], ['custom', '自选颜色 / HEX'], ['text', '单独描述配色']]],
  ]) {
    const value = local[kind], select = node('select', 'select');
    for (const [key, label] of options) { const option = node('option', '', label); option.value = key; select.append(option); }
    select.value = value.mode; select.onchange = () => { value.mode = select.value; if (kind === 'fabric' && value.mode === 'image' && local.color.mode === 'inherit') local.color.mode = 'auto'; refresh(); }; field(title, select, `${kind}-mode`);
    if (value.mode === 'image') { uploads(kind, kind === 'fabric' ? '面料' : '色卡'); if (value.image) picture(value.image, () => { value.image = null; refresh(); }); }
    if (value.mode === 'custom') {
      const row = node('div', 'sketch-color-fields'), picker = node('input'), hex = node('input', 'input'); picker.type = 'color'; picker.value = normalizeHex(value.hex) || '#687A5E'; picker.setAttribute('aria-label', '此处颜色'); hex.value = value.hex || ''; hex.maxLength = 7; hex.setAttribute('aria-label', '此处 HEX 色值'); hex.id = `region-${region.id}-color-hex`; picker.oninput = () => { value.hex = hex.value = picker.value.toUpperCase(); scheduleSave(); }; hex.oninput = () => { value.hex = hex.value; const parsed = normalizeHex(hex.value); if (parsed) picker.value = parsed; scheduleSave(); }; row.append(picker, hex); host.append(row);
    }
    if (['image', 'text', 'custom'].includes(value.mode)) { const input = node('textarea', 'textarea'); input.rows = 2; input.maxLength = 2000; input.value = value.text || ''; input.placeholder = kind === 'fabric' ? '例如：只将袖口替换为罗纹' : '例如：只用色卡里的酒红色'; input.oninput = () => { value.text = input.value; scheduleSave(); }; field(value.mode === 'text' ? `${title}说明` : '补充说明（可选）', input, `${kind}-text`); }
  }
  host.append(node('label', '', '此处辅料（可选）')); uploads('trims', '辅料');
  for (const trim of local.trims) { picture(trim, () => { local.trims = local.trims.filter(item => item.id !== trim.id); refresh(); }); const input = node('input', 'input'); input.value = trim.note || ''; input.maxLength = 2000; input.placeholder = '例如：红色拉链，保留原有长度'; input.setAttribute('aria-label', `${trim.name} 此处应用说明`); input.oninput = () => { trim.note = input.value; scheduleSave(); }; host.append(input); }
  return host;
}
function selectRegion(id, focus = true) {
  if (!state.regions.some(region => region.id === id)) return;
  selectedRegion = id; selectInspectorTab('product'); setMaterialsOpen(true); $('regionsDetails').open = true; $('globalMaterials').open = false;
  renderRegions();
  requestAnimationFrame(() => {
    document.querySelector('#regionsList .sketch-region-editor')?.scrollIntoView({ block: 'start' });
    if (focus) { const input = $(`region-${id}-note`); input?.scrollIntoView({ block: 'nearest' }); input?.focus({ preventScroll: true }); }
  });
}
function newRegion(box) { if (state.regions.length >= 32) return toast('最多添加 32 处局部区域'); const region = { id: crypto.randomUUID(), ...box, part: '其他结构', placement: '', note: '', mode: 'adapt', priority: 'high', color: 'adapt', fabric: 'adapt' }; state.regions.push(region); selectedRegion = region.id; renderRegions(); selectRegion(region.id); scheduleSave(); }
function renderRegionOverlay() {
  if (paintBoard?.setRegions) {
    paintBoard.setRegions(canAnnotate() ? state.regions.map(({ materials, ...region }, index) => ({ ...region, name: String(index + 1) })) : [], selectedRegion);
    return;
  }
  paintBoard?.setRegionMode(drawing && Boolean(state.sketch) && !showSource);
  const layer = $('regionLayer'); layer.classList.toggle('drawing', drawing && Boolean(state.sketch) && !showSource); layer.replaceChildren(); if (!state.sketch || showSource) return;
  state.regions.forEach((region, index) => { const button = node('button', `sketch-region-box${region.id === selectedRegion ? ' active' : ''}`); button.type = 'button'; Object.assign(button.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }); button.append(node('span', '', String(index + 1))); button.setAttribute('aria-label', `区域 ${index + 1} ${region.placement || ''}`); button.onclick = () => { selectedRegion = region.id; $('regionsDetails').open = true; renderRegions(); $(`region-${region.id}-placement`)?.focus(); }; layer.append(button); });
  $('drawRegionBtn').setAttribute('aria-pressed', String(drawing));
}
function renderRegions() {
  $('regionCount').textContent = `${state.regions.length} 处`;
  $('regionsEmpty').hidden = Boolean(state.regions.length);
  $('inspector-panel-local').hidden = !state.regions.length;
  $('annotationDock').classList.toggle('has-regions', Boolean(state.regions.length));
  if (!state.regions.some(region => region.id === selectedRegion)) selectedRegion = state.regions[0]?.id || null;
  renderRegionOverview();
  $('regionsList').replaceChildren(...state.regions.flatMap((region, index) => { if (region.id !== selectedRegion) return []; const item = node('div', 'sketch-region-editor active'), heading = node('div', 'sketch-section-heading'); item.dataset.regionId = region.id;
    const locate = node('span', 'sketch-region-locate', `标注 ${index + 1}`); heading.append(locate); item.append(heading);
    const modeLabel = node('label', '', '修改方式'), mode = node('select', 'select'); modeLabel.htmlFor = mode.id = `region-${region.id}-mode`;
    for (const [value, label] of [['adapt', '按说明修改此处'], ['retain', '保留结构，仅调整材质配色']]) { const option = node('option', '', label); option.value = value; mode.append(option); }
    mode.value = region.mode === 'adapt' ? 'adapt' : 'retain'; mode.onchange = () => { region.mode = mode.value; scheduleSave(); }; item.append(modeLabel, mode);
    item.append(renderRegionMaterials(region));
    const details = node('details', 'sketch-region-details'); details.append(node('summary', '', '部位与范围（可选）'));
    const placementLabel = node('label', '', '应用部位'), placement = node('input', 'input'); placementLabel.htmlFor = placement.id = `region-${region.id}-placement`; placement.value = region.placement || ''; placement.maxLength = 160; placement.placeholder = '例如：左肩带，可不填写'; placement.oninput = () => { region.placement = placement.value; renderRegionOverview(); renderRegionOverlay(); scheduleSave(); }; details.append(placementLabel, placement);
    const coordinates = node('div', 'sketch-region-coordinates');
    for (const [key, label] of [['x', '左 %'], ['y', '上 %'], ['w', '宽 %'], ['h', '高 %']]) { const title = node('label', '', label), input = node('input', 'input'); input.type = 'number'; input.min = key === 'w' || key === 'h' ? '1' : '0'; input.max = '100'; input.step = '1'; input.value = String(Math.round(region[key] * 100)); input.setAttribute('aria-label', `区域 ${index + 1} ${label}`); input.onchange = () => { region[key] = clamp(Number(input.value) / 100, key === 'w' || key === 'h' ? .01 : 0, key === 'x' || key === 'y' ? .99 : 1); region.w = Math.min(region.w, 1 - region.x); region.h = Math.min(region.h, 1 - region.y); renderRegionOverlay(); scheduleSave(); }; title.append(input); coordinates.append(title); } details.append(coordinates); item.append(details); return item;
  })); renderRegionOverlay();
}
function renderRegionOverview() {
  const overview = $('regionOverview'); if (!overview) return;
  overview.hidden = !state.regions.length;
  // Keep the dock focused on one annotation at a time. All regions remain in
  // state and on-canvas as numbered boxes, but only the selected region gets
  // an editor here; this prevents five or more inputs from becoming a tall,
  // visually noisy stack below the canvas.
  const current = state.regions.find(region => region.id === selectedRegion) || state.regions[0];
  const ids = current ? [current.id] : [];
  if (JSON.stringify([...overview.children].map(row => row.dataset.regionId)) !== JSON.stringify(ids)) {
    if (!current) { overview.replaceChildren(); return; }
    const index = state.regions.indexOf(current);
    const row = node('div', 'sketch-annotation-row'); row.dataset.regionId = current.id;
    const button = node('button', 'sketch-region-choice'); button.type = 'button'; button.dataset.regionId = current.id;
    button.onclick = () => selectRegion(current.id);
    const input = node('textarea', 'textarea'); input.id = `region-${current.id}-note`; input.rows = 1; input.maxLength = 2000; input.placeholder = '填写这处的修改内容';
    input.oninput = () => { current.note = input.value; renderRegionOverlay(); scheduleSave(); };
    const remove = removeButton('删除标注', () => { const position = state.regions.indexOf(current); state.regions.splice(position, 1); selectedRegion = state.regions[Math.min(position, state.regions.length - 1)]?.id || null; renderRegions(); scheduleSave(); });
    row.append(button, input, remove); overview.replaceChildren(row);
  }
  [...overview.children].forEach((row, index) => {
    const region = state.regions.find(item => item.id === row.dataset.regionId), [button, input, remove] = row.children;
    if (!region) return;
    const regionIndex = state.regions.indexOf(region);
    row.classList.toggle('active', region.id === selectedRegion);
    button.textContent = String(regionIndex + 1); button.title = `标注 ${regionIndex + 1}${region.placement ? `：${region.placement}` : ''}`; button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(region.id === selectedRegion));
    input.setAttribute('aria-label', `标注 ${regionIndex + 1} 修改内容`); if (input.value !== (region.note || '')) input.value = region.note || '';
    remove.title = `删除区域 ${regionIndex + 1}`; remove.setAttribute('aria-label', remove.title);
  });
}
function renderAll() { renderInspectorTab(); renderStyleFields(); renderMaterialPreview('fabric'); renderMaterialPreview('color'); renderTrims(); renderRegions(); renderPreview(); updateControls(); }
function canReplaceBoard() {
  if (paintBoard?.isDrawing()) { toast('请先完成当前笔画、填色或选区变换'); return false; }
  return true;
}
function clearDraft() {
  if (!ready || busy || submitting || exporting || state.activeJobId || !canReplaceBoard()) return;
  invalidate(); state = freshState(); showSource = false; selectedRegion = null;
  setForm({ designName: '', designNote: '', fabricMode: 'primary', fabricText: '', colorMode: 'auto', colorText: '', colorHex: '#687A5E' });
  status('草稿已清空'); renderAll(); scheduleSave();
}
async function generationCanvas() {
  const source = currentMain(); if (!source) throw new Error('请先导入图片或新建画板');
  // Use exactly the source and coordinate system shown by the editor. Comparison
  // previews never become the generation input, and untouched originals bypass PNG export.
  showSource = false; drawing = false; renderPreview(); await paintBoard.ensureReady();
  if (paintBoard.isDrawing()) throw new Error('请先完成当前笔画');
  const draft = paintBoard.getDraft();
  if (draft.sourceKey !== source.id) throw new Error('画板仍在切换，请稍后再试');
  if ((source.blankCanvas || draft.settings?.includeSource === false || draft.engine === 'weebpaint' && paintBoard.isDirty()) && !await paintBoard.hasVisibleInk()) throw new Error('画板还是空白，请先画出款式线稿或显示底图');
  if (!paintBoard.isDirty()) return source;
  status('正在按画板原尺寸合成线稿…');
  return imageFromBlob(await paintBoard.exportBlob(), `${source.name} · 画板`);
}
function openNewCanvas() { if (busy || submitting || exporting || !ready || state.activeJobId) return; $('newCanvasError').textContent = ''; $('newCanvasDialog').showModal(); }
async function createBlankCanvas(event) {
  event?.preventDefault(); if (busy || submitting || exporting || !ready || state.activeJobId) return;
  const automatic = !event;
  if (automatic && (state.photo || state.sketch || state.candidates.length || state.results.length)) return;
  const width = automatic ? 1200 : Number($('newCanvasWidth').value), height = automatic ? 1600 : Number($('newCanvasHeight').value);
  if (![width, height].every(value => Number.isInteger(value) && value >= 256 && value <= 4096)) { $('newCanvasError').textContent = '宽高请填写 256–4096 的整数像素'; return; }
  if (!canReplaceBoard()) return;
  busy = true; updateControls(); $('createCanvasBtn').disabled = true;
  try {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('画板创建失败，请尝试较小尺寸')), 'image/png'));
    const source = await imageFromBlob(blob, `手绘线稿 ${width}×${height}`); source.blankCanvas = true;
    adoptSource(source); $('newCanvasDialog').close(); renderAll(); scheduleSave();
    status(automatic ? '' : '画板已创建，画出线稿后选择面料生成成衣');
  } catch (error) { if (automatic) status(error.message, true); else $('newCanvasError').textContent = error.message; }
  finally { busy = false; $('createCanvasBtn').disabled = false; updateControls(); }
}
async function exportCanvas() {
  if (busy || submitting || exporting || !previewSource()) return;
  if (paintBoard.isDrawing()) return toast('请先完成当前笔画，再导出');
  exporting = true; updateControls();
  try {
    await paintBoard.ensureReady(); const blob = await paintBoard.exportBlob(), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${($('designName').value.trim() || 'FPA-线稿').replace(/[<>:"/\\|?*]/g, '_')}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('已导出当前画板 PNG，不含框选标记');
  } catch (error) { toast(error.message); }
  finally { exporting = false; updateControls(); }
}
function setRegionDrawing(value) {
  if (!state.sketch || showSource || busy || submitting || state.activeJobId) { drawing = false; } else drawing = typeof value === 'boolean' ? value : !drawing;
  if (drawing) $('regionsDetails').open = true;
  renderRegionOverlay();
}
function initPaintBoard() {
  paintBoard = new window.FpaPaintBoard({ viewport: $('canvasWrap'), shell: $('canvasShell'), image: $('canvasImage'), overlay: $('regionLayer'), toolbar: $('paintToolbar'),
    onChange(draft) {
      const slot = ['photo', 'sketch'].find(key => state[key]?.id === draft.sourceKey);
      if (!slot) return;
      state.boards[slot] = draft;
      renderBoardHint();
    }, onDirty: () => scheduleSave(1200), onDocumentChange: change => {
      renderBoardHint();
      if (currentMain()?.id === change.sourceKey && state.regions.length) {
        state.regions = []; selectedRegion = null; renderRegions();
        status('画板尺寸或文档已改变，原局部区域已清除，请按新画面重新选区');
      }
    }, onExitFocus: () => { if ($('workspace').classList.contains('is-paint-focused')) $('focusCanvasBtn').click(); },
    onToggleFocus: () => $('focusCanvasBtn').click(),
    onNewCanvas: openNewCanvas,
    onRegion: box => newRegion(box), onRegionSelect: id => selectRegion(id),
    onError: error => status(error.message || String(error), true), onRegionTool: setRegionDrawing });
}
async function upload(target, files) {
  if (!files.length || busy || submitting || exporting || !ready || state.activeJobId) return; const list = (localTarget(target)?.kind || target) === 'trims' ? [...files] : [files[0]];
  if (target === 'source' && !canReplaceBoard()) return;
  if (list.length > capacity(target)) return toast('参考图合计最多 10 张，请先移除不用的图片');
  busy = true; updateControls(); const token = revision;
  try { const images = []; for (const file of list) images.push(await imageFromBlob(file, file.name)); if (token !== revision) return; for (const image of images) installImage(target, image); renderAll(); scheduleSave(); } catch (error) { if (token === revision) toast(error.message); } finally { busy = false; document.querySelectorAll('input[type="file"]').forEach(input => input.value = ''); updateControls(); }
}
function normalizeHex(value) { const match = String(value || '').trim().match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i); return match ? '#' + (match[1].length === 3 ? [...match[1]].map(char => char + char).join('') : match[1]).toUpperCase() : ''; }
function designStyle() { const selectedFabric = $('fabricMode').value, fabric = { mode: selectedFabric === 'image' && !state.fabric ? 'primary' : selectedFabric }, color = { mode: $('colorMode').value }; if ($('fabricText').value.trim()) fabric.text = $('fabricText').value.trim(); if (color.mode !== 'auto' && $('colorText').value.trim()) color.text = $('colorText').value.trim(); if (color.mode === 'custom') color.hex = normalizeHex($('colorHex').value); return { version: 2, fabric, color }; }
function validate(designMode = 'sketch_to_garment') {
  if (!outputReady && !(designMode === 'photo_to_sketch' && $('sketchProvider').value === 'quiver')) return '请先重新读取出图选项'; if (!currentMain()) return '请先导入款式照片或线稿';
  const incomplete = state.regions.find(region => !region.note.trim() && !hasRegionMaterials(region));
  if (incomplete) { selectRegion(incomplete.id); return '请填写这处标注的修改要求'; }
  if (designMode === 'sketch_to_garment') for (const [index, region] of state.regions.entries()) {
    const local = region.materials; if (!local) continue;
    for (const kind of ['fabric', 'color']) { const value = local[kind], label = kind === 'fabric' ? '面料' : '配色';
      if (value.mode === 'image' && !value.image || value.mode === 'text' && !value.text?.trim() || value.mode === 'custom' && !normalizeHex(value.hex)) { selectRegion(region.id); return `请补全标注 ${index + 1} 的${label}`; }
    }
    if (local.color.mode === 'auto' && local.fabric.mode !== 'image' && !(local.fabric.mode === 'inherit' && $('fabricMode').value === 'image' && state.fabric)) return `标注 ${index + 1} 没有可跟随颜色的面料图片`;
  }
  if (designMode === 'sketch_to_garment') { const style = designStyle(); if (style.fabric.mode === 'text' && !style.fabric.text) return '请填写面料说明'; if (style.color.mode === 'image' && !state.color) return '请上传配色色卡'; if (style.color.mode === 'custom' && !style.color.hex) return '请输入有效 HEX 色值，例如 #687A5E'; if (style.color.mode === 'text' && !style.color.text) return '请填写配色说明，或填写“自由配色”'; if (state.trims.some(trim => !trim.placement.trim())) return '请填写每张辅料的应用部位'; }
  const images = designMode === 'sketch_to_garment' ? referenceImages() : [currentMain()]; if (images.length > 10) return '参考图合计最多 10 张'; if (images.reduce((sum, image) => sum + (image.bytes || Math.floor(image.src.split(',')[1].length * 3 / 4)), 0) > 128 * 1024 * 1024) return '参考原图合计不能超过 128 MB'; return '';
}
function buildRequest(main = currentMain(), designMode = 'sketch_to_garment') {
  const garment = designMode === 'sketch_to_garment', vector = !garment && $('sketchProvider').value === 'quiver';
  const prompt = garment ? '根据当前画布生成单件真实成衣产品图。输入可以是款式照片或线稿。局部标注中选择按说明修改的区域，允许按文字调整结构；其余部位保留当前款式结构。材料和配色按当前来源设置执行，辅料只应用在指定部位。保持原视角，干净背景，真实织物纹理和自然光影，不添加人物、文字或额外款式。' : vector ? ($('designNote').value.trim() || 'apparel') : '将当前款式画布转为清晰的黑白服装技术线稿。按编号标注修改明确要求调整的结构，未标注部分保留原款轮廓与工艺细节。保持原图视角，白色背景、干净黑色线条、无填色、无材质纹理、无阴影、无人物、无文字标注，只画同一件服装。';
  const references = [{ id: main.id, name: main.name, role: '主体款式参考', imageDataUrl: main.src, regions: state.regions.map(({ id, materials, ...region }, index) => ({ ...region, placement: region.placement.trim() || `标注 ${index + 1} 所示部位`, ...(garment && materials ? { localStyle: Object.fromEntries(['fabric', 'color'].map(kind => { const value = materials[kind]; return [kind, { mode: value.mode, ...(['image', 'text', 'custom'].includes(value.mode) && value.text?.trim() ? { text: value.text.trim() } : {}), ...(value.mode === 'custom' ? { hex: normalizeHex(value.hex) } : {}) }]; })) } : {}) })) }];
  if (garment) {
    // A cleared material slot can still have the old select value while the
    // image object is gone. Treat that as the default primary source instead
    // of dereferencing null during request construction.
    for (const [kind, role] of [['fabric', '面料参考'], ['color', '配色参考']]) {
      const image = state[kind];
      if ($(kind + 'Mode').value === 'image' && image?.id && image.src) references.push({ id: image.id, name: image.name, role, imageDataUrl: image.src, regions: [] });
    }
    references.push(...state.trims.filter(image => image?.id && image.src).map(image => ({ id: image.id, name: image.name, role: '辅料参考', imageDataUrl: image.src, regions: [], placement: (image.placement || '').trim(), note: (image.note || '').trim() })));
  }
  if (garment) {
    state.regions.forEach((region, index) => { const local = region.materials; if (!local) return;
      const add = (image, role, suffix) => references.push({ id: `local-${index + 1}-${suffix}`, name: image.name, role, targetRegion: index + 1, imageDataUrl: image.src, regions: [], ...(role === '辅料参考' ? { placement: `标注 ${index + 1}：${region.placement || '框选部位'}`, note: image.note || '' } : {}) });
      for (const [kind, role] of [['fabric', '面料参考'], ['color', '配色参考']]) if (local[kind].mode === 'image') add(local[kind].image, role, kind);
      local.trims.forEach((image, i) => add(image, '辅料参考', `trim-${i}`));
    });
    references.sort((a, b) => ({ '主体款式参考': 0, '面料参考': 1, '配色参考': 1, '辅料参考': 2 }[a.role] - { '主体款式参考': 0, '面料参考': 1, '配色参考': 1, '辅料参考': 2 }[b.role]));
  }
  const quiverSelection = !garment && $('sketchProvider').value === 'quiver' ? { sketchProvider: 'quiver' } : {};
  const output = garment ? designOutputValues('openai') : designOutputValues();
  return { designMode, name: $('designName').value.trim() || (garment ? '线稿成衣' : '款式线稿'), prompt: vector ? prompt : prompt + ($('designNote').value.trim() ? `\n补充要求：${$('designNote').value.trim()}` : ''), ...output, ...(garment ? { designProvider: 'openai' } : {}), ...quiverSelection, references, ...(garment ? { style: designStyle(), ...(state.sourceJobId ? { sourceJobId: state.sourceJobId } : {}) } : {}) };
}
async function generate(designMode = 'sketch_to_garment') {
  if (!['photo_to_sketch', 'sketch_to_garment'].includes(designMode)) return;
  if (busy || submitting || exporting || !ready || state.activeJobId) return; if (paintBoard?.isDrawing()) return toast('请先完成当前笔画，再生成'); const error = validate(designMode); if (error) { status(error, true); toast(error); return; }
  submitting = true; updateControls(); const token = revision; let sent = false;
  try { const useQuiver = designMode === 'photo_to_sketch' && $('sketchProvider').value === 'quiver'; const useOpenAI = designMode === 'sketch_to_garment'; const settings = await api(useQuiver ? 'design/quiver-settings' : useOpenAI ? 'state' : 'design/generation-settings'); if (token !== revision) return; if (!settings.configured) { status(useQuiver ? '请先配置 Quiver 矢量线稿接口' : useOpenAI ? '请先在系统设置配置 GPT 图像接口' : '请先配置设计出图接口', true); notifyParent('fpa:design-settings', { section: useQuiver ? 'quiver' : useOpenAI ? 'system' : 'design-generation' }); return; } if (!useQuiver && !useOpenAI) { const previous = JSON.stringify(designOutputValues()); applyOutputProtocol(settings); if (JSON.stringify(designOutputValues()) !== previous) { status('接口配置已变化，请检查出图设置后再次生成'); return; } }
    const main = await generationCanvas(); if (token !== revision) return; const body = buildRequest(main, designMode); if (body.references.reduce((total, ref) => total + Math.ceil(ref.imageDataUrl.split(',')[1].length * 3 / 4), 0) > 128 * 1024 * 1024) throw new Error('合成画板与参考原图合计超过 128 MB，请减小画板或参考图'); sent = true; status('正在提交设计任务…'); const result = await api('design/generate', { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }), job = result.job || result;
    if (!job.id) throw new Error('服务端未返回任务编号'); notifyParent('fpa:design-submitted', { jobId: job.id, designMode: body.designMode }); if (token !== revision) return;
    state.activeJobId = job.id; state.activeJobMode = body.designMode; scheduleSave(); status('已加入生成队列'); pollJob(job.id, token);
  } catch (error) { if (token === revision) status(sent ? `提交未确认：${error.message}。请先查看生成记录再决定是否重试。` : error.message, true); } finally { submitting = false; updateControls(); }
}
function jobImages(job) { return (job.images?.length ? job.images : [job.image]).filter(image => typeof image === 'string').map(allowedFileUrl); }
async function pollJob(jobId, token = revision) {
  if (token !== revision || jobId !== state.activeJobId) return;
  try { const snapshot = await api('state'); if (token !== revision || jobId !== state.activeJobId) return; const job = (snapshot.jobs || []).find(item => item.id === jobId); if (!job) throw new Error('该任务已不存在，请查看生成记录');
    if (['queued', 'processing'].includes(job.status)) { status(job.status === 'queued' ? `排队中${job.queuePosition ? ` · 第 ${job.queuePosition} 位` : ''}` : '正在生成…'); polling = setTimeout(() => pollJob(jobId, token), 1800); return; }
    const mode = state.activeJobMode; state.activeJobId = null; state.activeJobMode = null;
    if (job.status !== 'complete' || !job.image) { status(job.resultUncertain ? `结果待确认，可能已扣费。${job.error || '请查看生成记录'}` : `${job.status === 'cancelled' ? '任务已取消' : '生成失败'}：${job.error || '未返回图片'}`, true); scheduleSave(); updateControls(); return; }
    if (mode === 'photo_to_sketch') {
      state.candidates = jobImages(job); state.candidateIndex = 0; state.candidateJobId = job.id; state.appliedCandidateUrl = null;
      busy = true; updateControls();
      try { await applySketchCandidate(0, token); }
      catch (error) { if (token === revision) status(`线稿已生成，但载入失败：${error.message}。当前画布已保留，可点击下方线稿重新载入，无需再次生成。`, true); }
      finally { busy = false; }
    } else { state.results = jobImages(job); status(`成衣已生成 · ${state.results.length} 张`); }
    renderAll(); scheduleSave();
  } catch (error) { if (token !== revision || jobId !== state.activeJobId) return; status(`暂时无法读取进度：${error.message}`); polling = setTimeout(() => pollJob(jobId, token), 5000); }
}
async function applySketchCandidate(index, token = revision) {
  const url = state.candidates[index], image = await imageFromUrl(url, `线稿 ${index + 1}`);
  if (token !== revision) return;
  // Decode the result and flush the current layers before replacing any working state.
  // Keep the exact edited input for comparison, not just its unedited upload.
  const previous = await generationCanvas(); await paintBoard.flushDraft?.();
  if (token !== revision) return;
  if (state.candidateJobId !== state.sourceJobId || !state.photo) {
    state.photo = previous; state.boards.photo = null;
  }
  state.sketch = image; state.boards.sketch = null; state.sourceJobId = state.candidateJobId;
  state.candidateIndex = index; state.appliedCandidateUrl = url; state.regions = []; selectedRegion = null; showSource = false;
  status('已转为线稿，可在当前画布继续编辑');
}
async function confirmSketch(index = state.candidateIndex) {
  if (busy || submitting || exporting || state.activeJobId || !state.candidates[index] || !canReplaceBoard()) return;
  const token = revision; busy = true; updateControls();
  try { await applySketchCandidate(index, token); renderAll(); scheduleSave(); }
  catch (error) { if (token === revision) status(`载入失败：${error.message}。当前画布已保留，可再次点击线稿载入。`, true); }
  finally { busy = false; updateControls(); }
}
function pickerAssets() { const query = $('assetSearch').value.trim().toLocaleLowerCase(), category = $('assetCategory').value; return picker.assets.filter(asset => (!category || asset.part === category) && (!query || String(asset.name || '').toLocaleLowerCase().includes(query))); }
function renderPicker() {
  const assets = pickerAssets(), pages = Math.max(1, Math.ceil(assets.length / 8)); picker.page = Math.min(picker.page, pages - 1);
  picker.previewController?.abort(); picker.previewController = new AbortController(); const visible = assets.slice(picker.page * 8, picker.page * 8 + 8);
  $('assetPickerGrid').replaceChildren(...visible.map(asset => { const button = node('button', `asset-choice${picker.selected.has(asset.id) ? ' selected' : ''}`), preview = node('div', 'asset-choice-preview'), image = node('img'); button.type = 'button'; button.disabled = busy || picker.loading; button.setAttribute('aria-pressed', String(picker.selected.has(asset.id))); image.alt = asset.name || '素材'; image.loading = 'lazy'; image.src = asset.thumbnail || asset.preview || ''; image.dataset.source = allowedFileUrl(asset.image); preview.append(image, node('span', '', image.src ? '' : '预览加载中…')); const info = node('div', 'asset-choice-info'); info.append(node('strong', '', asset.name || '未命名素材'), node('span', '', categories[asset.part] || '其他素材')); button.append(preview, info, node('span', 'asset-choice-mark', picker.selected.has(asset.id) ? '已选' : '选择')); button.onclick = () => { if (picker.selected.has(asset.id)) picker.selected.delete(asset.id); else { if (picker.target !== 'trims') picker.selected.clear(); if (picker.selected.size >= capacity(picker.target)) return toast('参考图合计最多 10 张'); picker.selected.add(asset.id); } renderPicker(); }; return button; }));
  for (const image of $('assetPickerGrid').querySelectorAll('img[data-source]')) loadPickerPreview(image, picker.previewController.signal);
  if (!assets.length) $('assetPickerGrid').append(node('div', 'asset-picker-empty', picker.loading ? '正在读取素材…' : '暂无匹配素材'));
  $('assetPageInfo').textContent = `${picker.page + 1} / ${pages}`; $('assetPrevBtn').disabled = busy || picker.page === 0; $('assetNextBtn').disabled = busy || picker.page >= pages - 1; $('assetSelectionCount').textContent = `已选 ${picker.selected.size} 张`; $('addAssetsBtn').disabled = busy || picker.loading || !picker.selected.size;
}
async function loadPickerPreview(image, signal) { if (signal.aborted || !image.dataset.source) return; const key = image.dataset.source; let src = picker.previewCache.get(key); try { if (!src) { const response = await fetch(key, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }); if (!response.ok) throw new Error(); const blob = await response.blob(); if (typeof createImageBitmap === 'function') { const bitmap = await createImageBitmap(blob, { resizeWidth: 240, resizeQuality: 'medium' }); try { const canvas = document.createElement('canvas'), scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height)); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale)); canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); src = canvas.toDataURL('image/webp', .76); } finally { bitmap.close(); } } else src = URL.createObjectURL(blob); if (picker.previewCache.size > 64) picker.previewCache.delete(picker.previewCache.keys().next().value); picker.previewCache.set(key, src); } if (!signal.aborted) { image.src = src; image.nextElementSibling?.remove(); } } catch { if (!signal.aborted && image.nextElementSibling) image.nextElementSibling.textContent = '预览暂不可用'; } }
async function loadPicker() { const request = ++picker.request; picker.loading = true; $('assetPickerStatus').textContent = '正在读取素材库…'; $('reloadAssetsBtn').hidden = true; renderPicker(); try { const snapshot = await api('state'); if (request !== picker.request) return; picker.assets = (snapshot.assets || []).filter(asset => asset?.id && asset.image && !asset.archived).filter(asset => { try { allowedFileUrl(asset.image); return true; } catch { return false; } }); $('assetPickerStatus').textContent = `${picker.assets.length} 项素材`; } catch (error) { if (request !== picker.request) return; $('assetPickerStatus').textContent = `素材库读取失败：${error.message}`; $('reloadAssetsBtn').hidden = false; } finally { if (request === picker.request) { picker.loading = false; renderPicker(); } } }
function openPicker(target) { if (busy || submitting || exporting || state.activeJobId || !ready) return; if (!capacity(target)) return toast('参考图合计最多 10 张，请先移除不用的图片'); const kind = localTarget(target)?.kind || target; picker.target = target; picker.selected.clear(); picker.assets = []; picker.page = 0; $('assetSearch').value = ''; $('assetCategory').value = kind === 'fabric' ? 'fabric' : kind === 'trims' ? 'trims' : ''; $('assetPickerTitle').textContent = kind === 'fabric' ? '选择面料' : kind === 'trims' ? '选择辅料' : kind === 'color' ? '选择色卡' : '选择照片或线稿'; $('assetPicker').showModal(); loadPicker(); }
async function importPicker() {
  if (busy || !picker.selected.size) return; const selected = picker.assets.filter(asset => picker.selected.has(asset.id)), target = picker.target, token = revision, pickerToken = picker.request; if (selected.length > capacity(target)) return toast('参考图合计最多 10 张'); busy = true; updateControls(); renderPicker();
  if (target === 'source' && !canReplaceBoard()) { busy = false; updateControls(); renderPicker(); return; }
  try { const images = []; for (const [index, asset] of selected.entries()) { $('assetPickerStatus').textContent = `正在读取原图 ${index + 1} / ${selected.length}`; images.push(await imageFromUrl(asset.image, asset.name || '素材')); } if (token !== revision || pickerToken !== picker.request || !$('assetPicker').open) return; for (const image of images) installImage(target, image); $('assetPicker').close(); renderAll(); scheduleSave(); } catch (error) { if (token === revision && pickerToken === picker.request) $('assetPickerStatus').textContent = error.message; } finally { busy = false; updateControls(); renderPicker(); }
}
async function reuseRecord(jobId) {
  if (busy || submitting || exporting || state.activeJobId || !ready) throw new Error('工作台正在读取、生成或提交，请稍候'); if ($('assetPicker').open) throw new Error('请先关闭素材选择窗口');
  if (!canReplaceBoard()) throw new Error('请先完成当前笔画、填色或选区变换，当前画板已保留');
  const token = revision; busy = true; updateControls();
  try { const snapshot = await api('state'), job = (snapshot.jobs || []).find(item => item.id === jobId && item.kind === 'design'); if (!job || !['photo_to_sketch', 'sketch_to_garment'].includes(job.designMode)) throw new Error('这条记录不是线稿设计任务');
    const refs = job.references || [], style = job.designStyle || job.style; if (!refs.length || refs.length > 10 || refs.filter(ref => ref.role === '主体款式参考').length !== 1) throw new Error('记录参考图不完整');
    const restored = freshState(); restored.entry = job.designMode === 'photo_to_sketch' ? 'photo' : 'sketch'; restored.sourceJobId = job.designMode === 'photo_to_sketch' ? job.id : job.sourceJobId || null;
    const restoredImages = new Map();
    for (const [index, reference] of refs.entries()) {
      const image = await imageFromUrl(reference.originalImage || reference.image, reference.name || `参考图 ${index + 1}`); restoredImages.set(reference, image);
      if (token !== revision) throw new Error('草稿已变化，复用已取消');
      if (reference.role === '主体款式参考') {
        restored[restored.entry === 'photo' ? 'photo' : 'sketch'] = image;
        restored.regions = (reference.regions || []).map(({ localStyle, ...region }) => ({ ...region, id: crypto.randomUUID(), ...(localStyle ? { materials: { fabric: { ...localStyle.fabric, image: null }, color: { ...localStyle.color, image: null }, trims: [] } } : {}) }));
      } else if (reference.targetRegion !== undefined) continue;
      else if (reference.role === '面料参考') restored.fabric = image;
      else if (reference.role === '配色参考') restored.color = image;
      else if (reference.role === '辅料参考') restored.trims.push({ ...image, placement: reference.placement || '', note: reference.note || '' });
      else throw new Error('记录包含无法恢复的参考图用途');
    }
    for (const reference of refs.filter(ref => ref.targetRegion !== undefined)) {
      const region = restored.regions[reference.targetRegion - 1]; if (!region) throw new Error('局部材料的标注已缺失');
      const local = regionMaterials(region), image = restoredImages.get(reference);
      if (reference.role === '辅料参考') local.trims.push({ ...image, note: reference.note || '' });
      else if (reference.role === '面料参考' || reference.role === '配色参考') local[reference.role === '面料参考' ? 'fabric' : 'color'].image = image;
      else throw new Error('局部参考图用途无效');
    }
    if (job.designMode === 'photo_to_sketch') {
      restored.candidates = jobImages(job); restored.candidateJobId = job.id;
      if (job.status === 'complete' && restored.candidates.length) {
        restored.sketch = await imageFromUrl(restored.candidates[0], '线稿 1'); restored.appliedCandidateUrl = restored.candidates[0]; restored.regions = [];
      } else restored.sourceJobId = null;
    } else restored.results = jobImages(job);
    if (style?.fabric?.mode === 'image' && !restored.fabric || style?.color?.mode === 'image' && !restored.color) throw new Error('记录缺少面料或配色原图');
    if (['queued', 'processing'].includes(job.status)) { restored.activeJobId = job.id; restored.activeJobMode = job.designMode; }
    if (token !== revision) throw new Error('草稿已变化，复用已取消'); invalidate(); state = restored; showSource = false; selectedRegion = null;
    const prompt = String(job.designPrompt || ''), noteStart = prompt.indexOf('\n补充要求：');
    setForm({ designName: job.name || '', designNote: noteStart < 0 ? '' : prompt.slice(noteStart + '\n补充要求：'.length), fabricMode: style?.fabric?.mode || 'primary', fabricText: style?.fabric?.text || '', colorMode: style?.color?.mode || 'auto', colorText: style?.color?.text || '', colorHex: style?.color?.hex || '#687A5E', outputAspect: job.aspectRatio || '3:4', outputResolution: job.resolution || '1K', outputCount: job.count || 1, outputModeration: job.moderation || 'auto', outputSafety: job.safetyPreset || 'default', outputSearch: String(job.googleSearch === true), sketchProvider: job.sketchProvider || 'existing', quiverModel: job.quiver?.model || '', quiverEffort: job.quiver?.reasoningEffort || '' });
    if (outputCatalog) applyOutputProtocol({ protocol: outputProtocol }); renderAll(); await saveDraft(); if (state.activeJobId) pollJob(state.activeJobId, revision); const message = job.designMode === 'photo_to_sketch' ? '已恢复款式照片与候选线稿' : '已恢复线稿、材料与局部设置'; status(message); return message;
  } finally { busy = false; updateControls(); }
}
function point(event) { const rect = $('regionLayer').getBoundingClientRect(); return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }; }
function selection(end) { return { x: Math.min(pointerStart.x, end.x), y: Math.min(pointerStart.y, end.y), w: Math.abs(end.x - pointerStart.x), h: Math.abs(end.y - pointerStart.y) }; }
function initEvents() {
  initPaintBoard();
  setMaterialsOpen(true);
  document.querySelectorAll('[data-inspector-tab]').forEach((button, index, buttons) => {
    button.onclick = () => selectInspectorTab(button.dataset.inspectorTab);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click(); buttons[next].focus();
    };
  });
  $('materialsPanelBtn').onclick = () => setMaterialsOpen(!$('workspace').classList.contains('is-materials-open'));
  $('closeMaterialsBtn').onclick = () => { setMaterialsOpen(false); $('materialsPanelBtn').focus(); };
  $('focusCanvasBtn').onclick = () => { const focused = $('workspace').classList.toggle('is-paint-focused'); setMaterialsOpen(!focused); $('focusCanvasBtn').setAttribute('aria-pressed', String(focused)); $('focusCanvasBtn').textContent = focused ? '退出专注' : '专注画板'; notifyParent('fpa:design-focus', { enabled: focused }); };
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]') && $('workspace').classList.contains('is-paint-focused') && !paintBoard.isDrawing()) $('focusCanvasBtn').click(); });
  $('emptyNewCanvasBtn').onclick = openNewCanvas;
  $('newCanvasForm').onsubmit = createBlankCanvas; $('cancelCanvasBtn').onclick = () => $('newCanvasDialog').close();
  $('exportCanvasBtn').onclick = exportCanvas;
  $('generateBtn').onclick = () => generate();
  $('convertSketchBtn').onclick = () => setSketchMenu($('sketchConvertOptions').hidden);
  document.querySelectorAll('[data-sketch-provider]').forEach(button => { button.onclick = () => { const provider = button.dataset.sketchProvider; $('sketchProvider').value = provider; setSketchMenu(false); scheduleSave(); updateControls(); if (provider === 'quiver') { status('请输入对话指令后点击“生成矢量线稿”'); $('designNote').focus(); } else generate('photo_to_sketch'); }; });
  $('vectorGenerateBtn').onclick = () => generate('sketch_to_garment');
  document.addEventListener('click', event => { if (!event.target.closest('#sketchConvert')) setSketchMenu(false); });
  $('sketchConvert').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSketchMenu(false); $('convertSketchBtn').focus(); } if (event.key === 'ArrowDown' && event.target === $('convertSketchBtn')) { event.preventDefault(); setSketchMenu(true); $('sketchConvertOptions').querySelector('button').focus(); } });
  $('clearBtn').onclick = clearDraft;
  for (const [id, target] of [['sourceFile', 'source'], ['fabricFile', 'fabric'], ['colorFile', 'color'], ['trimsFile', 'trims']]) $(id).onchange = event => upload(target, event.target.files);
  for (const [id, target] of [['sourceLibraryBtn', 'source'], ['fabricLibraryBtn', 'fabric'], ['trimsLibraryBtn', 'trims']]) $(id).onclick = () => openPicker(target);
  for (const id of ['designName', 'designNote', 'fabricText', 'colorText', 'colorHex']) $(id).oninput = () => { if (id === 'colorHex') { const hex = normalizeHex($(id).value); if (hex) $('colorPicker').value = hex; } compile(); };
  $('fabricMode').onchange = () => { if ($('fabricMode').value === 'text' && $('colorMode').value === 'auto') $('colorMode').value = 'text'; compile(); }; $('colorMode').onchange = compile;
  $('colorPicker').oninput = () => { $('colorHex').value = $('colorPicker').value.toUpperCase(); compile(); }; $('colorHex').onchange = () => { const hex = normalizeHex($('colorHex').value); if (hex) $('colorHex').value = hex; compile(); };
  $('viewSourceBtn').onclick = () => { if (busy || submitting || exporting || state.activeJobId || !canReplaceBoard()) return; showSource = !showSource; drawing = false; renderPreview(); updateControls(); };
  $('markRegionBtn').onclick = async () => { if (!canAnnotate() || busy || submitting || exporting || state.activeJobId) return; try { await paintBoard.startRegion(); } catch (error) { status(error.message, true); } };
  $('drawRegionBtn').onclick = async () => { if (!canAnnotate() || busy || submitting || exporting || state.activeJobId) return; try { const box = await paintBoard.selectionRegion(); newRegion(box); } catch (error) { status(error.message, true); } };
  $('addRegionBtn').onclick = async () => {
    if (!canAnnotate() || busy || submitting || exporting || state.activeJobId) return;
    try { await paintBoard.startRegion(); status('请在画布上拖动框选需要修改的区域'); }
    catch (error) { status(error.message, true); }
  };
  $('regionLayer').onpointerdown = event => { if (!drawing || busy || submitting || state.activeJobId || !state.sketch || showSource || event.button !== 0) return; event.preventDefault(); pointerStart = point(event); $('regionLayer').setPointerCapture(event.pointerId); };
  $('regionLayer').onpointermove = event => { if (!pointerStart) return; const box = selection(point(event)); let preview = $('regionLayer').querySelector('.preview'); if (!preview) { preview = node('div', 'sketch-region-box preview'); $('regionLayer').append(preview); } Object.assign(preview.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }); };
  $('regionLayer').onpointerup = event => { if (!pointerStart) return; const box = selection(point(event)); pointerStart = null; drawing = false; if (box.w >= .01 && box.h >= .01) newRegion(box); else renderRegionOverlay(); }; $('regionLayer').onpointercancel = () => { pointerStart = null; renderRegionOverlay(); };
  $('canvasWrap').addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  $('canvasWrap').addEventListener('drop', event => { event.preventDefault(); if (state.activeJobId) return; const file = [...(event.dataTransfer?.files || [])].find(value => /^image\/(png|jpeg|webp)$/.test(value.type)); if (file) upload('source', [file]); else toast('请拖入 PNG、JPEG 或 WebP 图片'); });
  document.addEventListener('paste', event => { if (event.target.closest?.('input,textarea,[contenteditable="true"]') || $('assetPicker').open || $('newCanvasDialog').open || state.activeJobId) return; const file = [...(event.clipboardData?.files || [])].find(value => /^image\/(png|jpeg|webp)$/.test(value.type)); if (file) { event.preventDefault(); upload('source', [file]); } });
  for (const [key, label] of Object.entries(categories)) { const option = node('option', '', label); option.value = key; $('assetCategory').append(option); }
  $('closeAssetPickerBtn').onclick = () => { picker.request++; $('assetPicker').close(); }; $('assetPicker').onclose = () => picker.request++; $('assetSearch').oninput = $('assetCategory').onchange = () => { picker.page = 0; renderPicker(); }; $('assetPrevBtn').onclick = () => { picker.page--; renderPicker(); }; $('assetNextBtn').onclick = () => { picker.page++; renderPicker(); }; $('reloadAssetsBtn').onclick = loadPicker; $('addAssetsBtn').onclick = importPicker; $('reloadOutputBtn').onclick = async () => { await loadOutputControls(); updateControls(); };
  window.addEventListener('pagehide', () => { if (ready) saveDraft(); });
  window.addEventListener('message', async event => { if (event.origin !== location.origin || event.source !== window.parent) return; if (event.data?.type === 'fpa:design-activated' && ready) { await loadOutputControls(); updateControls(); } if (event.data?.type === 'fpa:design-reuse') { let ok = false, message; try { message = await reuseRecord(event.data.jobId); ok = true; } catch (error) { message = `复用失败：${error.message}`; toast(message); } notifyParent('fpa:design-reused', { requestId: event.data.requestId, ok, message }); } });
}
async function init() { initEvents(); let draftLoaded = false; try { database = await openDatabase(); const draft = await readStore('drafts', 'current'); if (draft?.state) { if (draft.version === 1) { // Migrate legacy inline-base64 draft once; subsequent saves are metadata-only.
        const legacyImages = draftImages(draft.state); for (const image of legacyImages) if (image?.src) await new Promise((resolve, reject) => { const transaction = database.transaction('images', 'readwrite'); transaction.objectStore('images').put(imageRecord(image), image.id); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
      } state = await hydrateDraft(draft); setForm(draft.form); } $('draftStatus').textContent = '草稿已保存'; savedVersion = saveVersion; draftLoaded = true; } catch { $('draftStatus').textContent = '草稿暂不可用'; } ready = true; renderAll(); if (draftLoaded) await createBlankCanvas(); await loadOutputControls(); updateControls(); if (state.activeJobId) pollJob(state.activeJobId, revision); notifyParent('fpa:design-ready'); }
window.addEventListener('DOMContentLoaded', init);
