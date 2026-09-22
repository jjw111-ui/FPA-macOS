/* Injected into the complete upstream module by scripts/build-full-paint.mjs. */
(() => {
  'use strict';
  const state = { key: null, dirty: false, loading: false, exporting: false, locked: true, readOnly: false,
    width: kl.width, height: kl.height, regions: [], selected: null, revision: 0, ready: false,
    symmetry: false, sourceLayerId: null, regionAvailable: false, regionDrawing: false };
  let changedTimer = 0;
  let regionsFrame = 0;
  let viewportSignature = '';
  let contentCache = null;
  let preview = null;
  const previewSize = (width, height) => {
    const scale = Math.min(1, 2048 / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  };
  const emit = (type, extra = {}) => {
    const detail = { type, key: state.key, dirty: state.dirty, width: kl.width, height: kl.height, revision: state.revision, ...extra };
    window.dispatchEvent(new CustomEvent(type, { detail }));
    if (window.parent !== window) window.parent.postMessage(detail, location.origin);
    return detail;
  };
  const busy = () => state.loading || state.exporting || we.loadingDoc || By > 0 || yY();
  const changed = (extra = {}, content = true) => {
    if (state.loading || !state.key) return;
    const sizeChanged = state.width !== kl.width || state.height !== kl.height;
    state.width = kl.width; state.height = kl.height;
    if (sizeChanged || extra.documentReplaced) state.regions = [];
    if (extra.documentReplaced) { state.sourceLayerId = null; state.regionDrawing = false; preview = null; }
    if (content) { state.dirty = true; contentCache = null; }
    state.revision++;
    emit('fpa:paint-change', { documentReplaced: false, sizeChanged, contentChanged: content, ...extra });
    scheduleDrawRegions();
  };
  const scheduleChanged = () => {
    if (state.loading || !state.key) return;
    // Dirty is synchronous so an immediate host capture cannot send the old source.
    state.dirty = true; contentCache = null; state.revision++;
    if (changedTimer) return;
    changedTimer = requestAnimationFrame(() => { changedTimer = 0; changed(); });
  };
  const assertIdle = () => {
    if (busy()) throw new Error('\u8bf7\u5148\u5b8c\u6210\u5f53\u524d\u7b14\u753b\u3001\u586b\u8272\u6216\u9009\u533a\u53d8\u6362');
  };
  const assertEditable = () => {
    assertIdle();
    if (!state.key || state.locked || state.readOnly) throw new Error('当前画板不可编辑');
  };
  const sourceLayer = () => state.sourceLayerId == null ? null : kl.findLayer(state.sourceLayerId);
  const repaint = () => { Nr(); Ht.invalidateAll(); Ht.requestRender(); };
  const transaction = (name, action) => {
    const token = D0.begin(name);
    try { action(); token.commit(); } catch (error) { token.cancel(); throw error; }
    repaint();
  };

  // Extend the native stamp engine rather than replaying pointer events. The
  // original and reflected marks share the same layer, selection and undo token.
  function mirrorEngine(engine) {
    const begin = engine.beginStroke.bind(engine);
    engine.beginStroke = function (...args) {
      this.fpaMirror = state.symmetry && ['brush', 'eraser', 'shapeBrush'].includes(Ra.current());
      return begin(...args);
    };
    const collect = engine.collectStamps.bind(engine);
    engine.collectStamps = function () {
      const result = collect();
      if (!this.fpaMirror || !result?.stamps.length) return result;
      const width = result.layer.docW;
      const reflected = result.stamps.filter(stamp => Math.abs(width - 2 * stamp.x) > .001).map(stamp => ({ ...stamp, x: width - stamp.x }));
      const left = Math.max(0, Math.min(result.bx, width - result.bx - result.bw));
      const right = Math.min(width, Math.max(result.bx + result.bw, width - result.bx));
      return { ...result, stamps: [...result.stamps, ...reflected], bx: left, bw: right - left };
    };
    const stamp = engine._stampOne.bind(engine);
    engine._stampOne = function (x, y, pressure) {
      stamp(x, y, pressure);
      const width = this._stroke?.layer.docW;
      if (this.fpaMirror && Number.isFinite(width) && Math.abs(width - 2 * x) > .001) stamp(width - x, y, pressure);
    };
    const pixels = engine.stampPixels.bind(engine);
    engine.stampPixels = function (points, pressure) {
      if (this.fpaMirror && this._stroke?.settings.pixelMode) {
        const width = this._stroke.layer.docW;
        const seen = new Set(points.map(point => `${point.x},${point.y}`));
        const reflected = points.map(point => ({ ...point, x: width - point.x })).filter(point => !seen.has(`${point.x},${point.y}`));
        return pixels([...points, ...reflected], pressure);
      }
      return pixels(points, pressure);
    };
  }
  mirrorEngine(Tr.brush);
  mirrorEngine(Tr.shapeBrush._inner);
  const composed = () => {
    const canvas = Ht.compositeNodesToCanvas(kl.layers, kl.width, kl.height);
    if (!canvas) throw new Error('\u753b\u677f\u5408\u6210\u6682\u4e0d\u53ef\u7528');
    return canvas;
  };
  const asBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png'));
  const docToClient = (x, y) => {
    const point = Ht.docToScreen(x, y), rect = q.board.getBoundingClientRect();
    return { x: point.x + rect.left, y: point.y + rect.top };
  };
  const clientToDoc = (x, y) => {
    const rect = q.board.getBoundingClientRect();
    return Ht.screenToDoc(x - rect.left, y - rect.top);
  };
  const validateSize = (width, height) => {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 67108864) throw new Error('\u753b\u5e03\u5c3a\u5bf8\u8d85\u51fa\u672c\u673a\u5b89\u5168\u5185\u5b58\u8303\u56f4');
  };
  // Keep native coordinates; only choose the free viewport rectangle for "fit".
  Ht.fitToScreen = function () {
    if (Tr.isStrokeActive()) return;
    const bounds = q.board.getBoundingClientRect();
    const toolbar = document.getElementById('topBar')?.getBoundingClientRect();
    const sidebar = document.getElementById('leftSidebar')?.getBoundingClientRect();
    const quick = document.getElementById('fpaQuickTools')?.getBoundingClientRect();
    const left = (sidebar?.right || 0) - bounds.left + 12;
    const top = toolbar ? Math.max(toolbar.bottom, quick?.bottom || 0) - bounds.top + 12 : 72;
    const width = Math.max(32, bounds.width - left - 16);
    const height = Math.max(32, bounds.height - top - 34);
    const scale = Math.min(width / kl.width, height / kl.height);
    Ht.setViewport(left + (width - kl.width * scale) / 2, top + (height - kl.height * scale) / 2, scale, 0);
  };
  const regionBounds = () => {
    const selection = kl.selection;
    if (!selection || selection.bboxW <= 0 || selection.bboxH <= 0) return null;
    const x = Math.max(0, selection.bboxX), y = Math.max(0, selection.bboxY);
    const right = Math.min(kl.width, selection.bboxX + selection.bboxW);
    const bottom = Math.min(kl.height, selection.bboxY + selection.bboxH);
    return right > x && bottom > y ? { x: x / kl.width, y: y / kl.height, w: (right - x) / kl.width, h: (bottom - y) / kl.height } : null;
  };
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlay.id = 'fpaPaintRegions';
  overlay.setAttribute('role', 'group');
  overlay.setAttribute('aria-label', '局部修改标注');
  overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;overflow:hidden';
  document.body.append(overlay);
  function drawRegions() {
    overlay.replaceChildren();
    if (state.symmetry && state.key && !state.readOnly) {
      const start = docToClient(kl.width / 2, 0), end = docToClient(kl.width / 2, kl.height);
      const axis = document.createElementNS(overlay.namespaceURI, 'line');
      for (const [key, value] of Object.entries({ x1: start.x, y1: start.y, x2: end.x, y2: end.y, stroke: '#657648', 'stroke-width': 1, 'stroke-dasharray': '5 5' })) axis.setAttribute(key, String(value));
      overlay.append(axis);
    }
    for (const region of state.regions) {
      const { x, y, w, h } = region;
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      const points = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([a, b]) => docToClient(a * kl.width, b * kl.height));
      const polygon = document.createElementNS(overlay.namespaceURI, 'polygon');
      polygon.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
      polygon.setAttribute('fill', region.id === state.selected ? '#65764812' : 'none');
      polygon.setAttribute('stroke', region.id === state.selected ? '#cc4c31' : '#657648');
      polygon.setAttribute('stroke-width', region.id === state.selected ? '2' : '1.5');
      polygon.setAttribute('stroke-dasharray', '7 4');
      overlay.append(polygon);
      const badge = document.createElementNS(overlay.namespaceURI, 'g');
      const number = state.regions.indexOf(region) + 1;
      const bx = Math.max(16, Math.min(innerWidth - 16, points[0].x + 12));
      const by = Math.max(16, Math.min(innerHeight - 16, points[0].y + 12));
      badge.dataset.regionId = region.id; badge.setAttribute('role', 'button'); badge.setAttribute('tabindex', '0');
      badge.setAttribute('aria-label', `编辑标注 ${number}${region.note ? `：${region.note}` : ''}`);
      badge.setAttribute('transform', `translate(${bx},${by})`); badge.style.cssText = 'pointer-events:auto;cursor:pointer';
      const circle = document.createElementNS(overlay.namespaceURI, 'circle');
      for (const [key, value] of Object.entries({ r: 13, fill: region.id === state.selected ? '#465630' : '#657648', stroke: '#fff', 'stroke-width': 2 })) circle.setAttribute(key, value);
      const label = document.createElementNS(overlay.namespaceURI, 'text');
      for (const [key, value] of Object.entries({ y: 4, 'text-anchor': 'middle', 'font-size': 12, 'font-family': 'system-ui,sans-serif', fill: '#fff' })) label.setAttribute(key, value);
      label.textContent = String(number); badge.append(circle, label);
      if (region.id === state.selected && region.note) {
        const summary = region.note.replace(/\s+/g, ' ').slice(0, 18), width = Math.min(224, summary.length * 12 + 16);
        const noteBg = document.createElementNS(overlay.namespaceURI, 'rect'), noteText = document.createElementNS(overlay.namespaceURI, 'text');
        const left = bx + width + 22 <= innerWidth ? 19 : -width - 19;
        for (const [key, value] of Object.entries({ x: left, y: -14, width, height: 28, rx: 6, fill: '#fff', stroke: '#dce2d1' })) noteBg.setAttribute(key, value);
        for (const [key, value] of Object.entries({ x: left + 8, y: 4, fill: '#30382b', 'font-size': 12, 'font-family': 'system-ui,sans-serif' })) noteText.setAttribute(key, value);
        noteText.textContent = summary; badge.append(noteBg, noteText);
      }
      const select = () => { if (!state.locked && !state.readOnly && state.regionAvailable && !busy()) emit('fpa:paint-region-select', { id: region.id }); };
      badge.addEventListener('pointerdown', event => event.stopPropagation());
      badge.addEventListener('click', select);
      badge.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(); } });
      overlay.append(badge);
    }
  }
  function scheduleDrawRegions() {
    if (regionsFrame) return;
    regionsFrame = requestAnimationFrame(() => { regionsFrame = 0; drawRegions(); });
  }

  // Loads are the only document replacement path. Image imports keep using native layers.
  const originalLoad = D0.load.bind(D0);
  D0.load = function (...args) {
    const result = originalLoad(...args);
    if (!state.loading && state.key) queueMicrotask(() => changed({ documentReplaced: true }));
    return result;
  };
  const originalRender = Ht.render.bind(Ht);
  Ht.render = function (...args) {
    const result = originalRender(...args);
    const signature = JSON.stringify(Ht.viewport);
    if (signature !== viewportSignature) {
      viewportSignature = signature; scheduleDrawRegions();
      if (state.ready && state.key && !state.loading) {
        clearTimeout(state.viewTimer);
        state.viewTimer = setTimeout(() => changed({ viewChanged: true }, false), 180);
      }
    }
    return result;
  };
  window.addEventListener('wp:sidecarchange', () => changed({ editorStateChanged: true }, false));
  window.addEventListener('wp:modechange', () => { if (Ra.current() !== 'lasso') state.regionDrawing = false; });
  q.board.addEventListener('pointerup', () => {
    if (!state.regionDrawing || !state.regionAvailable) return;
    requestAnimationFrame(() => {
      if (!state.regionDrawing || state.locked || state.readOnly) return;
      const box = regionBounds();
      if (!box || box.w < .01 || box.h < .01) return;
      state.regionDrawing = false;
      emit('fpa:paint-region', { box });
      document.getElementById('lassoDeselectBtn')?.click();
    });
  });
  window.addEventListener('wp:docpixeldirty', scheduleChanged);
  D0.onChange(event => {
    if (['layerTiles', 'layerTree'].includes(event?.kind)) scheduleChanged();
    else if (!state.loading && state.key) changed({ editorStateChanged: true }, false);
  });
  // Active layer and tool/color changes live in the ORA sidecar, not output pixels.
  let metadataTimer = 0;
  const scheduleMetadata = () => {
    if (state.loading || state.locked || state.readOnly || !state.key) return;
    state.revision++;
    clearTimeout(metadataTimer);
    metadataTimer = setTimeout(() => changed({ editorStateChanged: true }, false), 180);
  };
  for (const name of ['change', 'input', 'click']) document.addEventListener(name, event => {
    if (!event.target.closest?.('#board,#boardGL,#fpaPaintRegions')) scheduleMetadata();
  });
  document.getElementById('paletteWindow')?.addEventListener('pointerup', scheduleMetadata);

  function blockInput(event) {
    if (event.type === 'keydown' && event.key === 'Escape') return;
    if (!state.locked && !state.readOnly && !state.loading && !state.exporting) return;
    if (event.type === 'wheel' && !state.locked && !state.loading && !state.exporting) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu', 'keydown', 'paste', 'drop', 'wheel']) {
    window.addEventListener(name, blockInput, { capture: true, passive: false });
  }
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const pending = yY() || Boolean(kl.selection) || [...document.querySelectorAll('dialog[open],[role="dialog"],.menu-popup:not(.hidden)')].some(element => element.getClientRects().length);
    queueMicrotask(() => { if (!pending && !event.defaultPrevented) emit('fpa:paint-exit-focus'); });
  }, { capture: true });
  const localOnly = event => {
    const target = event.target.closest?.('#cloudIconBtn,#cloudRefreshBtn,#menuConnectGallery,#galleryConnectBtn,[data-fpa-cloud]');
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    _l('\u5f53\u524d FPA \u753b\u677f\u4f7f\u7528\u672c\u5730\u5de5\u7a0b\uff0c\u672a\u8fde\u63a5\u4e91\u7aef\u8d26\u6237', true);
  };
  window.addEventListener('click', localOnly, { capture: true });

  async function sourceBlob(src) {
    return src instanceof Blob ? src : fetch(src).then(response => {
      if (!response.ok) throw new Error(`Image load failed (${response.status})`);
      return response.blob();
    });
  }
  async function decodeSource(src, width, height, blankCanvas, lightweight = false) {
    if (!src) {
      if (!blankCanvas || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Missing drawing source');
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
      return { w: width, h: height, data: context.getImageData(0, 0, width, height).data };
    }
    const blob = await sourceBlob(src);
    const bitmap = await Js(blob);
    try {
      validateSize(bitmap.width, bitmap.height);
      const size = lightweight ? previewSize(bitmap.width, bitmap.height) : { width: bitmap.width, height: bitmap.height };
      if (size.width === bitmap.width && size.height === bitmap.height) return Qo(bitmap);
      const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.imageSmoothingQuality = 'high'; context.drawImage(bitmap, 0, 0, size.width, size.height);
      const data = context.getImageData(0, 0, size.width, size.height).data;
      preview = { src, width: bitmap.width, height: bitmap.height, editWidth: size.width, editHeight: size.height, baseline: data };
      return { w: size.width, h: size.height, data };
    } finally { bitmap.close?.(); }
  }
  function pixelsCanvas(pixels) {
    const canvas = document.createElement('canvas'); canvas.width = pixels.width; canvas.height = pixels.height;
    canvas.getContext('2d').putImageData(pixels, 0, 0); return canvas;
  }
  function outputSize() {
    if (!preview) return { width: kl.width, height: kl.height };
    return { width: Math.round(kl.width * preview.width / preview.editWidth), height: Math.round(kl.height * preview.height / preview.editHeight) };
  }
  // Reconstruct the original only where the base layer still matches its preview.
  // Edited base pixels (including erasures) replace it; separate ink stays separate.
  async function exportLayerCanvas(layer, width, height) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); context.imageSmoothingQuality = 'high';
    const pixels = layer.getImageData(0, 0, kl.width, kl.height);
    const small = pixelsCanvas(pixels);
    if (layer.id === state.sourceLayerId && kl.width === preview.editWidth && kl.height === preview.editHeight) {
      const bitmap = await Js(await sourceBlob(preview.src));
      try { context.drawImage(bitmap, 0, 0, width, height); } finally { bitmap.close?.(); }
      const mask = new ImageData(kl.width, kl.height);
      let changedPixels = false;
      for (let i = 0; i < pixels.data.length; i += 4) {
        if (pixels.data[i] !== preview.baseline[i] || pixels.data[i + 1] !== preview.baseline[i + 1] || pixels.data[i + 2] !== preview.baseline[i + 2] || pixels.data[i + 3] !== preview.baseline[i + 3]) {
          mask.data[i + 3] = 255; changedPixels = true;
        }
      }
      if (changedPixels) {
        const maskCanvas = pixelsCanvas(mask);
        context.globalCompositeOperation = 'destination-out'; context.drawImage(maskCanvas, 0, 0, width, height);
        const smallContext = small.getContext('2d');
        smallContext.globalCompositeOperation = 'destination-in'; smallContext.drawImage(maskCanvas, 0, 0);
        context.globalCompositeOperation = 'source-over'; context.drawImage(small, 0, 0, width, height);
        maskCanvas.width = maskCanvas.height = 1;
      }
    } else context.drawImage(small, 0, 0, width, height);
    small.width = small.height = 1;
    return canvas;
  }
  async function captureOriginal() {
    if (!preview) return asBlob(composed());
    const { width, height } = outputSize(); validateSize(width, height);
    // The common flat-layer path avoids allocating a full-size native history/GPU document.
    if (kl.layers.every(layer => !layer.isGroup && !layer.clippingMask && layer.mode === 'source-over')) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      try {
        const context = canvas.getContext('2d');
        for (const layer of kl.layers) {
          if (!layer.visible || !layer.opacity) continue;
          const image = await exportLayerCanvas(layer, width, height);
          context.globalAlpha = layer.opacity; context.drawImage(image, 0, 0);
          image.width = image.height = 1;
        }
        return await asBlob(canvas);
      } finally { canvas.width = canvas.height = 1; }
    }
    // Native compositing remains authoritative for groups, clipping and blend modes.
    const nodes = async layers => {
      const result = [];
      for (const layer of layers) {
        const node = { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, mode: layer.mode, clippingMask: layer.clippingMask, lockAlpha: layer.lockAlpha };
        if (layer.isGroup) node.children = await nodes(layer.children);
        else {
          const canvas = await exportLayerCanvas(layer, width, height);
          node.pixels = { rect: { x: 0, y: 0, w: width, h: height }, bytes: canvas.getContext('2d').getImageData(0, 0, width, height).data };
          canvas.width = canvas.height = 1;
        }
        result.push(node);
      }
      return result;
    };
    const backend = new Py({ width, height, activeId: kl.activeId, nodes: await nodes(kl.layers) }, {});
    try {
      const canvas = Ht.compositeNodesToCanvas(backend.view.layers, width, height);
      if (!canvas) throw new Error('原尺寸合成失败，画板和原图已保留，请重试');
      try { return await asBlob(canvas); } finally { canvas.width = canvas.height = 1; }
    } finally { backend.dispose(); }
  }
  const leaf = (id, name, pixels, visible = true) => ({ id, name, visible, opacity: 1, mode: 'source-over', clippingMask: false, lockAlpha: false, pixels });
  function legacyPixels(draft, width, height, key) {
    if (!draft) return null;
    if (draft.version !== 1 || draft.sourceKey !== key || draft.width !== width || draft.height !== height || !Array.isArray(draft.operations)) throw new Error('\u65e7\u8349\u7a3f\u4e0e\u5f53\u524d\u56fe\u7247\u4e0d\u5339\u914d');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    for (const operation of draft.operations) {
      if (operation.tool === 'clear') { context.clearRect(0, 0, width, height); continue; }
      const points = operation.points;
      if (!Array.isArray(points) || !points.length || !['brush', 'eraser', 'line'].includes(operation.tool) || !Number.isFinite(operation.width) || operation.width <= 0 || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) throw new Error('Invalid legacy drawing operation');
      context.globalCompositeOperation = operation.tool === 'eraser' ? 'destination-out' : 'source-over';
      context.strokeStyle = operation.color; context.fillStyle = operation.color;
      context.lineWidth = operation.width; context.lineCap = 'round'; context.lineJoin = 'round';
      for (const mirror of operation.symmetry ? [false, true] : [false]) {
        const x = point => mirror ? width - point.x : point.x;
        context.beginPath();
        if (points.length === 1 || (operation.tool === 'line' && points[0].x === points[1]?.x && points[0].y === points[1]?.y)) {
          context.arc(x(points[0]), points[0].y, operation.width / 2, 0, Math.PI * 2); context.fill();
        } else {
          context.moveTo(x(points[0]), points[0].y);
          for (let index = 1; index < points.length; index++) context.lineTo(x(points[index]), points[index].y);
          context.stroke();
        }
      }
    }
    return { rect: { x: 0, y: 0, w: width, h: height }, bytes: context.getImageData(0, 0, width, height).data };
  }
  const ready = B3.then(async () => {
    await Cm(false);
    state.ready = true;
    emit('fpa:paint-ready', { engine: 'weebpaint', version: 1 });
  });
  const api = {
    ready,
    async loadDocument({ key, src, width, height, project, dirty = false, legacyDraft = null, blankCanvas = false, quickSettings = null }) {
      await ready;
      if (key == null) throw new Error('Document key is required');
      if (yY()) throw new Error('Complete the current stroke, fill or selection transform before switching documents');
      if (state.loading || state.exporting) throw new Error('Document operation already in progress');
      state.loading = true;
      clearTimeout(state.viewTimer);
      clearTimeout(metadataTimer);
      if (changedTimer) cancelAnimationFrame(changedTimer);
      changedTimer = 0;
      const previousPreview = preview;
      try {
        preview = null;
        let decoded;
        const restorePreview = quickSettings?.preview;
        // Preserve existing edited full-resolution projects; only untouched ones migrate.
        const keepProject = project && (dirty || restorePreview || blankCanvas || !src);
        if (keepProject) {
          if (typeof project.arrayBuffer !== 'function') throw new Error('Project must be an OpenRaster Blob');
          decoded = await Zo(project);
          if (restorePreview && src) {
            await decodeSource(src, width, height, false, true);
            if (!preview || preview.width !== restorePreview.width || preview.height !== restorePreview.height || preview.editWidth !== restorePreview.editWidth || preview.editHeight !== restorePreview.editHeight) throw new Error('预览草稿与原图不匹配，原草稿已保留');
          }
        } else {
          const image = await decodeSource(src, width, height, blankCanvas, !legacyDraft && !blankCanvas);
          validateSize(image.w, image.h);
          const ink = legacyPixels(legacyDraft, image.w, image.h, key);
          decoded = { data: { width: image.w, height: image.h, activeId: 2, nodes: [
            leaf(1, '\u539f\u56fe', { rect: { x: 0, y: 0, w: image.w, h: image.h }, bytes: image.data }, legacyDraft?.settings?.includeSource !== false),
            leaf(2, ink ? '\u5df2\u6062\u590d\u7b14\u8ff9' : '\u7ed8\u56fe\u56fe\u5c42', ink)
          ] } };
        }
        validateSize(decoded.data.width, decoded.data.height);
        we.adoptAsTransient(decoded, 'FPA');
        state.symmetry = Boolean(quickSettings?.symmetry ?? legacyDraft?.settings?.symmetry);
        state.sourceLayerId = keepProject && quickSettings ? quickSettings.sourceLayerId : (!keepProject || kl.findLayer(1)?.name === '原图' ? 1 : null);
        state.regionDrawing = false;
        state.key = key; state.width = kl.width; state.height = kl.height;
        state.dirty = Boolean(dirty || legacyDraft?.operations?.length || legacyDraft?.settings?.includeSource === false);
        state.regions = []; state.revision++; contentCache = null;
        _r.clearFileDirty();
        await Cm(false);
        if (!keepProject) Ht.fitToScreen(48);
        Ht.invalidateAll(); Ht.requestRender();
      } catch (error) { preview = previousPreview; throw error; }
      finally { state.loading = false; }
      emit('fpa:paint-change', { loaded: true, documentReplaced: false, sizeChanged: false, contentChanged: false });
      return { key: state.key, width: kl.width, height: kl.height, dirty: state.dirty };
    },
    async capture() {
      await ready; assertIdle();
      return asBlob(composed());
    },
    async captureOriginal() {
      await ready; assertIdle(); state.exporting = true;
      window.dispatchEvent(new Event('fpa:paint-controls'));
      try { return await captureOriginal(); }
      finally { state.exporting = false; window.dispatchEvent(new Event('fpa:paint-controls')); }
    },
    getOutputSize: outputSize,
    async exportProject() {
      await ready; assertIdle(); state.exporting = true;
      window.dispatchEvent(new Event('fpa:paint-controls'));
      try { return await we.encodeCurrentOra(); } finally { state.exporting = false; window.dispatchEvent(new Event('fpa:paint-controls')); }
    },
    isDirty: () => state.dirty,
    isBusy: busy,
    getRevision: () => state.revision,
    getSize: () => ({ width: kl.width, height: kl.height }),
    getViewTransform: () => ({ ...Ht.viewport }),
    documentToClient: docToClient,
    clientToDocument: clientToDoc,
    regionBounds,
    setRegions(regions, selectedId) { state.regions = Array.isArray(regions) ? regions : []; state.selected = selectedId; scheduleDrawRegions(); },
    setLocked(value) { state.locked = Boolean(value); document.body.dataset.fpaLocked = String(state.locked); },
    setReadOnly(value) { state.readOnly = Boolean(value); document.body.dataset.fpaReadOnly = String(state.readOnly); },
    setRegionAvailable(value) { state.regionAvailable = Boolean(value); },
    getQuickSettings() { return { symmetry: state.symmetry, sourceLayerId: state.sourceLayerId, ...(preview ? { preview: { width: preview.width, height: preview.height, editWidth: preview.editWidth, editHeight: preview.editHeight } } : {}) }; },
    getQuickState() {
      const source = sourceLayer();
      return { symmetry: state.symmetry, hasSource: Boolean(source), includeSource: source?.visible !== false,
        color: F3.value?.color || '#30382b', size: F3.value?.size || 4, zoom: Ht.viewport.scale,
        canUndo: I3.canUndo(), canRedo: I3.canRedo(), regionAvailable: state.regionAvailable,
        regionDrawing: state.regionDrawing, tool: Ra.current(), shape: Tr.shapeBrush.getSubTool(),
        editable: Boolean(state.key && !state.locked && !state.readOnly && !busy()) };
    },
    setSymmetry(value) { assertEditable(); state.symmetry = Boolean(value); changed({ editorStateChanged: true }, false); },
    setIncludeSource(value) {
      assertEditable(); const source = sourceLayer();
      if (!source) throw new Error('当前文档没有独立底图');
      transaction('FPA source visibility', () => D0.layerTree.setLayerProp(source.id, 'visible', Boolean(value)));
    },
    clearInk() {
      assertEditable();
      if (!sourceLayer()) throw new Error('当前文档没有独立底图，请在图层面板选择需要清空的图层');
      transaction('FPA clear ink', () => D0.layerTree.eachLeaf(layer => { if (layer.id !== state.sourceLayerId) D0.layerTiles.clearLayer(layer.id); }));
    },
    setQuickColor(value) { assertEditable(); if (/^#[0-9a-f]{6}$/i.test(value)) { tl(value); scheduleMetadata(); } },
    setQuickSize(value) { assertEditable(); if (Number.isFinite(value)) { dY(Math.max(1, Math.min(200, value))); scheduleMetadata(); } },
    selectQuickTool(tool) {
      assertEditable(); state.regionDrawing = false;
      if (tool === 'line') { document.getElementById('toolShape').click(); Tr.shapeBrush.setSubTool('line'); document.querySelector('[data-shape-sub="line"]')?.click(); }
      else if (tool === 'region') {
        if (!state.regionAvailable) throw new Error('请先确认线稿，再框选局部材料区域');
        document.getElementById('toolLasso').click(); Tr.lasso.setSubTool('rect'); Tr.lasso.setSetOpMode('new'); state.regionDrawing = true;
      } else document.getElementById({ brush: 'toolPen', eraser: 'toolEraser', pan: 'toolHand' }[tool])?.click();
    },
    quickUndo() { assertEditable(); Tr.ctrlZ(); },
    quickRedo() { assertEditable(); Tr.redo(); },
    zoom(factor) { assertIdle(); const bounds = q.board.getBoundingClientRect(); Ht.zoomAt(bounds.width / 2, bounds.height / 2, factor); },
    toggleFocus() { emit('fpa:paint-focus'); },
    fit() { if (!Tr.isStrokeActive()) Ht.fitToScreen(48); },
    togglePalette() { if (!state.locked && !state.readOnly) xN.toggle(); },
    requestReload() { emit('fpa:paint-reload-request'); },
    prepareReload() { assertIdle(); _r.clearFileDirty(); },
    acknowledgePersistence({ key, revision } = {}) {
      if (busy() || key !== state.key || revision !== state.revision) return false;
      // The host has committed this exact ORA to IndexedDB. Clear only the
      // native unsaved-file flag, not the edited-pixels flag used for generation.
      _r.clearFileDirty();
      return true;
    },
    async hasVisibleContent() {
      await ready; assertIdle();
      if (contentCache != null) return contentCache;
      const pixels = composed().getContext('2d', { willReadFrequently: true }).getImageData(0, 0, kl.width, kl.height).data;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] > 0 && (pixels[offset] < 250 || pixels[offset + 1] < 250 || pixels[offset + 2] < 250)) return contentCache = true;
      }
      return contentCache = false;
    },
    getDocumentInfo() {
      const summarize = nodes => nodes.map(node => ({ id: node.id, name: node.name, visible: node.visible, opacity: node.opacity, mode: node.mode,
        isGroup: Boolean(node.isGroup), ...(node.isGroup ? { children: summarize(node.children) } : {}) }));
      return { key: state.key, dirty: state.dirty, revision: state.revision, locked: state.locked, readOnly: state.readOnly, width: kl.width, height: kl.height,
        layers: summarize(kl.layers), activeId: kl.activeId, selection: regionBounds(), canUndo: I3.canUndo(), canRedo: I3.canRedo(), tool: Ra.current() };
    }
  };
  window.FpaFullPaint = Object.freeze(api);
})();
