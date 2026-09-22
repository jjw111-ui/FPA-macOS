(function () {
  'use strict';

  const PREVIEW_EDGE = 2048;
  const DOCUMENT_EDGE = 16384;
  const DOCUMENT_PIXELS = 64 * 1024 * 1024;
  const MAX_OPERATIONS = 1500;
  const MAX_POINTS = 160000;
  const MAX_STROKE_POINTS = 12000;
  const TOOLS = ['brush', 'eraser', 'line', 'pan'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const editable = target => target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));

  class FpaPaintBoard {
    constructor({ viewport, shell, image, overlay, toolbar, onChange, onError, onRegionTool }) {
      if (![viewport, shell, image, overlay, toolbar].every(value => value instanceof Element)) {
        throw new Error('画板缺少预览容器或工具栏。');
      }
      Object.assign(this, { viewport, shell, image, overlay, toolbar, onChange, onError, onRegionTool });
      this.source = null;
      this.requestedSource = null;
      this.sourceImage = null;
      this.operations = [];
      this.redoOperations = [];
      this.settings = { tool: 'brush', color: '#30382b', width: 4, symmetry: false, includeSource: true };
      this.width = 0;
      this.height = 0;
      this.fitScale = 1;
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.locked = false;
      this.readOnly = false;
      this.regionMode = false;
      this.regionAvailable = false;
      this.loading = false;
      this.loadError = null;
      this.loadToken = 0;
      this.readyPromise = Promise.resolve();
      this.activeStroke = null;
      this.panGesture = null;
      this.frame = 0;
      this.viewSaveTimer = null;
      this.spaceDown = false;
      this.pointerInside = false;
      this.hasInk = false;
      this.pointCount = 0;
      this.listeners = new AbortController();
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'fpa-paint-ink';
      this.canvas.setAttribute('aria-hidden', 'true');
      this.canvas.width = this.canvas.height = 1;
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!this.context) throw new Error('浏览器无法创建画板，请更新浏览器后重试。');
      this.shell.insertBefore(this.canvas, this.overlay);
      this.shell.classList.add('fpa-paint-shell');
      this.viewport.classList.add('fpa-paint-viewport');
      this.viewport.tabIndex = this.viewport.hasAttribute('tabindex') ? this.viewport.tabIndex : 0;
      this.viewport.setAttribute('aria-label', '绘图画布；B 画笔，E 橡皮，L 直线，H 移动，空格临时移动');
      this._renderToolbar();
      this._bindEvents();
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.viewport);
      this._updateControls();
    }

    _listen(target, type, callback, options = {}) {
      target.addEventListener(type, callback, { ...options, signal: this.listeners.signal });
    }

    _renderToolbar() {
      this.toolbar.classList.add('fpa-paint-toolbar');
      this.toolbar.setAttribute('aria-label', '线稿画板工具');
      this.toolbar.replaceChildren();
      this.buttons = {};
      const group = label => {
        const element = document.createElement('div');
        element.className = 'fpa-paint-group';
        element.setAttribute('role', 'group');
        element.setAttribute('aria-label', label);
        this.toolbar.append(element);
        return element;
      };
      const button = (parent, action, label, icon, title = label) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'fpa-paint-button';
        element.dataset.paintAction = action;
        element.setAttribute('aria-label', label);
        element.title = title;
        const artwork = window.FpaPaintIcons?.[icon];
        if (artwork) element.innerHTML = artwork;
        const text = document.createElement('span');
        text.textContent = label;
        element.append(text);
        parent.append(element);
        this.buttons[action] = element;
        this._listen(element, 'click', () => this._action(action));
        return element;
      };
      const drawing = group('绘制工具');
      button(drawing, 'brush', '画笔', 'pen', '画笔 · B');
      button(drawing, 'eraser', '橡皮', 'eraser', '橡皮 · E，仅擦除笔迹');
      button(drawing, 'line', '直线', 'line', '直线 · L');
      button(drawing, 'pan', '移动', 'hand', '移动 · H，或按住空格拖动');
      button(drawing, 'region', '局部框选', 'region', '框选局部材料与配色区域');
      const settings = group('笔迹设置');
      const label = (text, className = '') => {
        const element = document.createElement('label');
        element.className = `fpa-paint-setting ${className}`;
        const caption = document.createElement('span');
        caption.textContent = text;
        element.append(caption);
        settings.append(element);
        return element;
      };
      this.colorInput = document.createElement('input');
      Object.assign(this.colorInput, { type: 'color', value: this.settings.color, title: '笔迹颜色' });
      this.colorInput.dataset.paintSetting = 'color';
      label('颜色').append(this.colorInput);
      this.widthInput = document.createElement('input');
      Object.assign(this.widthInput, { type: 'number', min: '1', max: '160', step: '1', value: '4', title: '线宽，以原图像素计' });
      this.widthInput.dataset.paintSetting = 'width';
      label('线宽').append(this.widthInput);
      this.symmetryInput = document.createElement('input');
      this.symmetryInput.type = 'checkbox';
      this.symmetryInput.dataset.paintSetting = 'symmetry';
      label('左右对称', 'fpa-paint-check').prepend(this.symmetryInput);
      this.sourceInput = document.createElement('input');
      Object.assign(this.sourceInput, { type: 'checkbox', checked: true, title: '勾选时显示底图并带底图导出；取消后仅导出白底笔迹' });
      this.sourceInput.dataset.paintSetting = 'includeSource';
      label('带底图导出', 'fpa-paint-check').prepend(this.sourceInput);
      const history = group('笔迹历史');
      button(history, 'undo', '撤销笔迹', 'undo', '撤销笔迹 · Ctrl / ⌘ Z');
      button(history, 'redo', '重做笔迹', 'redo', '重做笔迹 · Ctrl / ⌘ Shift Z');
      button(history, 'clear', '清空笔迹', 'clear', '清空笔迹，保留底图与局部标注');
      const view = group('画布视图');
      button(view, 'zoom-out', '缩小', 'zoomOut');
      this.zoomOutput = document.createElement('output');
      this.zoomOutput.className = 'fpa-paint-zoom';
      this.zoomOutput.setAttribute('aria-label', '当前缩放');
      view.append(this.zoomOutput);
      button(view, 'zoom-in', '放大', 'zoomIn');
      button(view, 'fit', '适应画布', 'fit');
      this._listen(this.colorInput, 'change', () => this._changeSetting('color', this.colorInput.value));
      this._listen(this.widthInput, 'change', () => this._changeSetting('width', clamp(Number(this.widthInput.value) || 4, 1, 160)));
      this._listen(this.symmetryInput, 'change', () => this._changeSetting('symmetry', this.symmetryInput.checked));
      this._listen(this.sourceInput, 'change', () => this._changeSetting('includeSource', this.sourceInput.checked));
    }

    _bindEvents() {
      this._listen(this.viewport, 'pointerenter', () => { this.pointerInside = true; });
      this._listen(this.viewport, 'pointerleave', () => { this.pointerInside = false; });
      this._listen(this.viewport, 'pointerdown', event => this._pointerDown(event), { capture: true });
      this._listen(this.viewport, 'pointermove', event => this._pointerMove(event));
      this._listen(this.viewport, 'pointerup', event => this._pointerUp(event));
      this._listen(this.viewport, 'pointercancel', () => this._cancelGesture());
      this._listen(this.viewport, 'lostpointercapture', event => {
        if (this.activeStroke?.pointerId === event.pointerId || this.panGesture?.pointerId === event.pointerId) this._cancelGesture();
      });
      this._listen(this.viewport, 'wheel', event => {
        if (!this._canView() || this.activeStroke || this.panGesture) return;
        event.preventDefault();
        this._zoomTo(this.zoom * Math.exp(-clamp(event.deltaY, -200, 200) * .003), event.clientX, event.clientY);
      }, { passive: false });
      this._listen(document, 'keydown', event => this._keyDown(event));
      this._listen(document, 'keyup', event => {
        if (event.code === 'Space' && this.spaceDown) {
          this.spaceDown = false;
          this._updateControls();
        }
      });
      this._listen(window, 'blur', () => {
        this.spaceDown = false;
        this.pointerInside = false;
        this._cancelGesture();
        this._updateControls();
      });
    }

    async loadSource(source, draft = null) {
      if (source && this.requestedSource?.key === source.key && this.requestedSource?.src === source.src) {
        return this.readyPromise;
      }
      if (!source && !this.requestedSource && !this.source) return;
      clearTimeout(this.viewSaveTimer);
      this.viewSaveTimer = null;
      const token = ++this.loadToken;
      this._cancelGesture();
      this.requestedSource = source ? { key: source.key, src: source.src } : null;
      this.source = null;
      this.sourceImage = null;
      this.loadError = null;
      this.loading = Boolean(source);
      this.operations = [];
      this.redoOperations = [];
      this.pointCount = 0;
      this.hasInk = false;
      this.width = this.height = 0;
      this.regionMode = false;
      this.shell.hidden = true;
      this.image.removeAttribute('src');
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._updateControls();
      if (!source) {
        this.readyPromise = Promise.resolve();
        return;
      }
      this.readyPromise = (async () => {
        try {
          if (typeof source.src !== 'string' || !source.src || source.key == null) throw new Error('没有可读取的画板图片。');
          if (source.width && source.height) this._validateDimensions(source.width, source.height);
          const decoded = await this._decodeImage(source.src);
          if (token !== this.loadToken) return;
          const width = decoded.naturalWidth;
          const height = decoded.naturalHeight;
          this._validateDimensions(width, height);
          const restored = this._restoreDraft(draft, source.key, width, height);
          const scale = Math.min(1, PREVIEW_EDGE / Math.max(width, height));
          this.canvas.width = Math.max(1, Math.round(width * scale));
          this.canvas.height = Math.max(1, Math.round(height * scale));
          this.width = width;
          this.height = height;
          this.fitScale = scale;
          this.source = { key: source.key, src: source.src, width, height };
          this.sourceImage = decoded;
          this.settings = restored.settings;
          this.operations = restored.operations;
          this.redoOperations = restored.redo;
          this.pointCount = this.operations.reduce((sum, operation) => sum + operation.points.length, 0);
          this.zoom = restored.view.zoom;
          this.panX = restored.view.panX;
          this.panY = restored.view.panY;
          if (decoded.crossOrigin) this.image.crossOrigin = decoded.crossOrigin;
          else this.image.removeAttribute('crossorigin');
          this.image.src = source.src;
          this.image.draggable = false;
          this.shell.hidden = false;
          this.loading = false;
          this._redraw();
          this.resize();
          this._applyTransform();
          this._updateControls();
        } catch (error) {
          if (token !== this.loadToken) return;
          this.loading = false;
          this.loadError = error instanceof Error ? error : new Error('图片无法读取，请重新导入。');
          this.source = null;
          this.sourceImage = null;
          this.shell.hidden = true;
          this._updateControls();
          this._report(this.loadError);
          throw this.loadError;
        }
      })();
      return this.readyPromise;
    }

    _decodeImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        let url;
        try { url = new URL(src, document.baseURI); } catch { reject(new Error('图片地址无效，请重新导入。')); return; }
        if (/^https?:$/.test(url.protocol) && url.origin !== location.origin) image.crossOrigin = 'anonymous';
        image.onload = () => {
          image.onload = image.onerror = null;
          resolve(image);
        };
        image.onerror = () => {
          image.onload = image.onerror = null;
          reject(new Error('图片无法读取，或图片服务器不允许画板访问。请重新上传原图。'));
        };
        image.src = src;
      });
    }

    _validateDimensions(width, height) {
      if (!Number.isFinite(Number(width)) || !Number.isFinite(Number(height)) || width < 1 || height < 1) {
        throw new Error('图片尺寸无效，请重新导入。');
      }
      if (Math.max(width, height) > DOCUMENT_EDGE || width * height > DOCUMENT_PIXELS) {
        throw new Error('图片过大：画板支持长边不超过 16,384 像素、总像素不超过 6,710 万的图片。请先调整原图尺寸后导入。');
      }
    }

    _restoreDraft(draft, key, width, height) {
      const defaults = {
        settings: { tool: 'brush', color: '#30382b', width: 4, symmetry: false, includeSource: true },
        operations: [], redo: [], view: { zoom: 1, panX: 0, panY: 0 }
      };
      if (!draft || draft.sourceKey !== key) return defaults;
      if (draft.version !== 1 || draft.width !== width || draft.height !== height || !Array.isArray(draft.operations) || !Array.isArray(draft.redo)) {
        throw new Error('已保存的笔迹与这张图片不匹配，无法恢复画板。请重新选择原图或清空该草稿。');
      }
      let pointCount = 0;
      if (draft.operations.length + draft.redo.length > MAX_OPERATIONS) throw new Error('已保存的笔迹超出画板操作上限，无法恢复。');
      const validateOperation = operation => {
        if (!operation || !['brush', 'eraser', 'line', 'clear'].includes(operation.tool) || !Array.isArray(operation.points)) {
          throw new Error('已保存的笔迹数据不完整，无法恢复。');
        }
        if (operation.tool === 'clear') return { tool: 'clear', points: [] };
        if (!/^#[0-9a-f]{6}$/i.test(operation.color) || !Number.isFinite(operation.width) || operation.width < 1 || operation.width > 160 || !operation.points.length || operation.points.length > MAX_STROKE_POINTS) {
          throw new Error('已保存的笔迹参数无效，无法恢复。');
        }
        if (operation.tool === 'line' && operation.points.length !== 2) throw new Error('已保存的直线数据无效，无法恢复。');
        const points = operation.points.map(point => {
          if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > width || point.y > height) {
            throw new Error('已保存的笔迹坐标无效，无法恢复。');
          }
          return { x: point.x, y: point.y };
        });
        pointCount += points.length;
        if (pointCount > MAX_POINTS) throw new Error('已保存的笔迹超出画板点数上限，无法恢复。');
        return { tool: operation.tool, color: operation.color, width: operation.width, symmetry: Boolean(operation.symmetry), points };
      };
      defaults.operations = draft.operations.map(validateOperation);
      defaults.redo = draft.redo.map(validateOperation);
      const settings = draft.settings || {};
      if (TOOLS.includes(settings.tool)) defaults.settings.tool = settings.tool;
      if (/^#[0-9a-f]{6}$/i.test(settings.color)) defaults.settings.color = settings.color;
      if (Number.isFinite(settings.width)) defaults.settings.width = clamp(settings.width, 1, 160);
      defaults.settings.symmetry = Boolean(settings.symmetry);
      defaults.settings.includeSource = settings.includeSource !== false;
      if (Number.isFinite(draft.view?.zoom)) defaults.view.zoom = clamp(draft.view.zoom, .1, 12);
      if (Number.isFinite(draft.view?.panX)) defaults.view.panX = clamp(draft.view.panX, -100000, 100000);
      if (Number.isFinite(draft.view?.panY)) defaults.view.panY = clamp(draft.view.panY, -100000, 100000);
      return defaults;
    }

    getDraft() {
      if (!this.source) return null;
      return clone({
        version: 1, sourceKey: this.source.key, width: this.width, height: this.height,
        operations: this.operations, redo: this.redoOperations, settings: this.settings,
        view: { zoom: this.zoom, panX: this.panX, panY: this.panY }
      });
    }

    setLocked(value) {
      this.locked = Boolean(value);
      if (this.locked) this._cancelGesture();
      this._updateControls();
    }

    setReadOnly(value) {
      this.readOnly = Boolean(value);
      if (this.readOnly) this._cancelGesture();
      this._updateControls();
    }

    setRegionAvailable(value) {
      this.regionAvailable = Boolean(value);
      if (!this.regionAvailable) this.regionMode = false;
      this._updateControls();
    }

    setRegionMode(value) {
      const enabled = Boolean(value) && this.regionAvailable && !this.readOnly && !this.locked;
      if (enabled !== this.regionMode) this._cancelGesture();
      this.regionMode = enabled;
      this._updateControls();
    }

    _canEdit() { return Boolean(this.source && !this.loading && !this.locked && !this.readOnly); }
    _canView() { return Boolean(this.source && !this.loading && !this.locked); }
    isDrawing() { return Boolean(this.activeStroke); }
    hasVisibleInk() { return this.hasInk; }
    isDirty() { return Boolean(this.source && (!this.settings.includeSource || this.hasInk || (this.activeStroke && this.activeStroke.operation.tool !== 'eraser'))); }
    getDocumentSize() { return { width: this.width, height: this.height }; }

    async ensureReady() {
      let pending;
      do {
        pending = this.readyPromise;
        await pending;
      } while (pending !== this.readyPromise);
      if (this.loadError) throw this.loadError;
      if (!this.source || !this.sourceImage) throw new Error('请先导入图片或新建画布。');
    }

    fit() {
      if (!this.source) return;
      this.zoom = 1;
      this.panX = this.panY = 0;
      this.resize();
      this._applyTransform();
      this._updateControls();
      clearTimeout(this.viewSaveTimer);
      this.viewSaveTimer = null;
      this._emitChange();
    }

    resize() {
      if (!this.source) return;
      const style = getComputedStyle(this.viewport);
      const availableWidth = this.viewport.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
      const availableHeight = this.viewport.clientHeight - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0);
      // Hidden embedded workbenches have no layout. Keep the last usable transform.
      if (availableWidth <= 0 || availableHeight <= 0) return;
      this.fitScale = Math.min(availableWidth / this.width, availableHeight / this.height);
      this._applyTransform();
      this._updateControls();
    }

    _applyTransform() {
      if (!this.source) return;
      this.shell.style.width = `${this.width * this.fitScale}px`;
      this.shell.style.height = `${this.height * this.fitScale}px`;
      this.shell.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }

    _zoomTo(value, clientX, clientY) {
      if (!this._canView() || this.activeStroke) return;
      const nextZoom = clamp(value, .1, 12);
      if (nextZoom === this.zoom) return;
      const viewportRect = this.viewport.getBoundingClientRect();
      const anchorX = clientX ?? (viewportRect.left + viewportRect.width / 2);
      const anchorY = clientY ?? (viewportRect.top + viewportRect.height / 2);
      const before = this.shell.getBoundingClientRect();
      if (!before.width || !before.height) return;
      const x = (anchorX - before.left) / before.width;
      const y = (anchorY - before.top) / before.height;
      this.zoom = nextZoom;
      this._applyTransform();
      const after = this.shell.getBoundingClientRect();
      this.panX += anchorX - (after.left + x * after.width);
      this.panY += anchorY - (after.top + y * after.height);
      this._applyTransform();
      this._updateControls();
      clearTimeout(this.viewSaveTimer);
      this.viewSaveTimer = setTimeout(() => {
        this.viewSaveTimer = null;
        this._emitChange();
      }, 180);
    }

    _point(event) {
      const rect = this.shell.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {
        x: Math.round(clamp((event.clientX - rect.left) / rect.width, 0, 1) * this.width * 1000) / 1000,
        y: Math.round(clamp((event.clientY - rect.top) / rect.height, 0, 1) * this.height * 1000) / 1000
      };
    }

    _pointerDown(event) {
      if (!this._canView() || this.activeStroke || this.panGesture || event.isPrimary === false || ![0, 1].includes(event.button)) return;
      const moving = event.button === 1 || this.spaceDown || (!this.regionMode && this.settings.tool === 'pan') || this.readOnly;
      if (moving) {
        event.preventDefault();
        event.stopPropagation();
        this.viewport.focus({ preventScroll: true });
        this.panGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
        this.viewport.setPointerCapture(event.pointerId);
        this._updateControls();
        return;
      }
      if (!this._canEdit() || this.regionMode || !this.shell.contains(event.target)) return;
      const point = this._point(event);
      if (!point) return;
      if (this.operations.length >= MAX_OPERATIONS || this.pointCount >= MAX_POINTS - 2) {
        this._report(new Error('笔迹已达到画板保存上限。现有笔迹已保留，请先导出，再清空笔迹后继续。'));
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.viewport.focus({ preventScroll: true });
      const snapshot = document.createElement('canvas');
      snapshot.width = this.canvas.width;
      snapshot.height = this.canvas.height;
      const snapshotContext = snapshot.getContext('2d');
      if (!snapshotContext) { this._report(new Error('无法建立笔迹缓存，请保存后重新打开画板。')); return; }
      snapshotContext.drawImage(this.canvas, 0, 0);
      const operation = {
        tool: this.settings.tool, color: this.settings.color, width: this.settings.width,
        symmetry: this.settings.symmetry, points: [point]
      };
      if (operation.tool === 'line') operation.points.push({ ...point });
      this.activeStroke = { pointerId: event.pointerId, operation, snapshot, renderedPoints: 0 };
      this.viewport.setPointerCapture(event.pointerId);
      this._scheduleStroke();
      this._updateControls();
    }

    _pointerMove(event) {
      if (this.panGesture?.pointerId === event.pointerId) {
        event.preventDefault();
        this.panX = this.panGesture.panX + event.clientX - this.panGesture.x;
        this.panY = this.panGesture.panY + event.clientY - this.panGesture.y;
        this._applyTransform();
        return;
      }
      if (this.activeStroke?.pointerId !== event.pointerId) return;
      event.preventDefault();
      const samples = event.getCoalescedEvents?.() || [];
      for (const sample of samples.length ? samples : [event]) {
        if (!this._appendPoint(sample)) break;
      }
      this._scheduleStroke();
    }

    _appendPoint(event) {
      const active = this.activeStroke;
      if (!active) return false;
      const point = this._point(event);
      if (!point) return false;
      if (active.operation.tool === 'line') {
        active.operation.points[1] = point;
        return true;
      }
      const points = active.operation.points;
      const previous = points[points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < .15) return true;
      if (points.length >= MAX_STROKE_POINTS || this.pointCount + points.length >= MAX_POINTS) {
        this._finishStroke();
        this._report(new Error('这段笔迹已保存，已到达单笔或画板点数上限。请抬起画笔；如画板已满，请先导出后清空笔迹。'));
        return false;
      }
      points.push(point);
      return true;
    }

    _pointerUp(event) {
      if (this.panGesture?.pointerId === event.pointerId) {
        this.panGesture = null;
        this._releasePointer(event.pointerId);
        this._updateControls();
        clearTimeout(this.viewSaveTimer);
        this.viewSaveTimer = null;
        this._emitChange();
      } else if (this.activeStroke?.pointerId === event.pointerId) {
        this._appendPoint(event);
        this._finishStroke();
      }
    }

    _scheduleStroke() {
      if (this.frame || !this.activeStroke) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this._renderActiveStroke();
      });
    }

    _renderActiveStroke() {
      const active = this.activeStroke;
      if (!active) return;
      const { operation } = active;
      if (operation.tool === 'line') {
        this._restoreSnapshot(active.snapshot);
        this._drawOperation(this.context, operation, this.canvas.width / this.width, this.canvas.height / this.height);
      } else {
        const start = Math.max(0, active.renderedPoints - 1);
        if (active.renderedPoints < operation.points.length) {
          this._drawOperation(this.context, operation, this.canvas.width / this.width, this.canvas.height / this.height, start);
          active.renderedPoints = operation.points.length;
        }
      }
    }

    _drawOperation(context, operation, scaleX, scaleY, startIndex = 0) {
      context.save();
      context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      if (operation.tool === 'clear') {
        context.clearRect(0, 0, this.width, this.height);
        context.restore();
        return;
      }
      context.globalCompositeOperation = operation.tool === 'eraser' ? 'destination-out' : 'source-over';
      context.strokeStyle = operation.color;
      context.fillStyle = operation.color;
      context.lineWidth = operation.width;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      const points = operation.points;
      const path = mirror => {
        const x = point => mirror ? this.width - point.x : point.x;
        if (points.length === 1 || (operation.tool === 'line' && points[0].x === points[1].x && points[0].y === points[1].y)) {
          context.beginPath();
          context.arc(x(points[0]), points[0].y, operation.width / 2, 0, Math.PI * 2);
          context.fill();
          return;
        }
        context.beginPath();
        context.moveTo(x(points[startIndex]), points[startIndex].y);
        for (let index = startIndex + 1; index < points.length; index++) context.lineTo(x(points[index]), points[index].y);
        context.stroke();
      };
      path(false);
      if (operation.symmetry) path(true);
      context.restore();
    }

    _restoreSnapshot(snapshot) {
      this.context.save();
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.context.drawImage(snapshot, 0, 0);
      this.context.restore();
    }

    _finishStroke() {
      const active = this.activeStroke;
      if (!active) return;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this._renderActiveStroke();
      this.operations.push(active.operation);
      this.pointCount += active.operation.points.length;
      this.redoOperations = [];
      this.activeStroke = null;
      this._releasePointer(active.pointerId);
      active.snapshot.width = active.snapshot.height = 1;
      this._refreshInkPresence();
      this._updateControls();
      this._emitChange();
    }

    cancelStroke() {
      const active = this.activeStroke;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      if (!active) return;
      this._restoreSnapshot(active.snapshot);
      this.activeStroke = null;
      this._releasePointer(active.pointerId);
      active.snapshot.width = active.snapshot.height = 1;
      this._updateControls();
    }

    _releasePointer(pointerId) {
      if (this.viewport.hasPointerCapture(pointerId)) this.viewport.releasePointerCapture(pointerId);
    }

    _cancelGesture() {
      this.cancelStroke();
      const pointerId = this.panGesture?.pointerId;
      this.panGesture = null;
      if (pointerId != null) this._releasePointer(pointerId);
    }

    _redraw() {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      for (const operation of this.operations) this._drawOperation(this.context, operation, this.canvas.width / this.width, this.canvas.height / this.height);
      this._refreshInkPresence();
    }

    _refreshInkPresence() {
      const pixels = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
      this.hasInk = false;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index]) { this.hasInk = true; break; }
      }
    }

    _action(action) {
      if (['zoom-in', 'zoom-out', 'fit'].includes(action)) {
        if (!this._canView()) return;
        if (action === 'fit') this.fit();
        else this._zoomTo(this.zoom * (action === 'zoom-in' ? 1.25 : .8));
        return;
      }
      if (action === 'pan') {
        if (!this._canView()) return;
      } else if (!this._canEdit()) return;
      this.cancelStroke();
      if (TOOLS.includes(action)) {
        const wasRegionMode = this.regionMode;
        this.regionMode = false;
        this.settings.tool = action;
        if (wasRegionMode) this.onRegionTool?.(false);
        this._updateControls();
        this._emitChange();
      } else if (action === 'region' && this.regionAvailable) {
        this.onRegionTool?.();
      } else if (action === 'undo' && this.operations.length) {
        const operation = this.operations.pop();
        this.redoOperations.push(operation);
        this.pointCount -= operation.points.length;
        this._redraw();
        this._updateControls();
        this._emitChange();
      } else if (action === 'redo' && this.redoOperations.length) {
        const operation = this.redoOperations.pop();
        this.operations.push(operation);
        this.pointCount += operation.points.length;
        this._redraw();
        this._updateControls();
        this._emitChange();
      } else if (action === 'clear' && this.operations.length) {
        const full = this.operations.length >= MAX_OPERATIONS - 1 || this.pointCount >= MAX_POINTS - 2;
        const message = full
          ? '笔迹已接近保存上限。清空全部笔迹和撤销历史？此操作无法撤销，底图和局部标注会保留。'
          : '清空全部笔迹？底图和局部标注会保留，可用“撤销笔迹”恢复。';
        if (!window.confirm(message)) return;
        if (full) { this.operations = []; this.pointCount = 0; }
        else this.operations.push({ tool: 'clear', points: [] });
        this.redoOperations = [];
        this._redraw();
        this._updateControls();
        this._emitChange();
      }
    }

    _changeSetting(name, value) {
      if (!this._canEdit()) { this._updateControls(); return; }
      this.cancelStroke();
      this.settings[name] = value;
      this._updateControls();
      this._emitChange();
    }

    _keyDown(event) {
      if (editable(event.target) || !this._canView() || document.querySelector('dialog[open]')) return;
      const focused = this.viewport.contains(document.activeElement) || this.toolbar.contains(document.activeElement);
      if (!focused && !this.pointerInside) return;
      if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!event.repeat && !this.activeStroke) this.spaceDown = true;
        this._updateControls();
        return;
      }
      if (event.key === 'Escape') {
        if (this.activeStroke || this.panGesture) event.preventDefault();
        this._cancelGesture(); this._updateControls(); return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && this._canEdit()) {
        event.preventDefault();
        this._action(event.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const tool = { b: 'brush', e: 'eraser', l: 'line', h: 'pan' }[event.key.toLowerCase()];
      if (tool) { event.preventDefault(); this._action(tool); }
    }

    _updateControls() {
      const canEdit = this._canEdit();
      const canView = this._canView();
      for (const tool of TOOLS) {
        this.buttons[tool].disabled = tool === 'pan' ? !canView : !canEdit;
        this.buttons[tool].setAttribute('aria-pressed', String(this.settings.tool === tool && !this.regionMode));
      }
      this.buttons.region.disabled = !canEdit || !this.regionAvailable;
      this.buttons.region.setAttribute('aria-pressed', String(this.regionMode));
      this.buttons.undo.disabled = !canEdit || !this.operations.length || Boolean(this.activeStroke);
      this.buttons.redo.disabled = !canEdit || !this.redoOperations.length || Boolean(this.activeStroke);
      this.buttons.clear.disabled = !canEdit || !this.operations.length || Boolean(this.activeStroke);
      this.buttons['zoom-in'].disabled = !canView || this.zoom >= 12 || Boolean(this.activeStroke);
      this.buttons['zoom-out'].disabled = !canView || this.zoom <= .1 || Boolean(this.activeStroke);
      this.buttons.fit.disabled = !canView || Boolean(this.activeStroke);
      this.colorInput.disabled = this.widthInput.disabled = this.symmetryInput.disabled = this.sourceInput.disabled = !canEdit;
      this.colorInput.value = this.settings.color;
      this.widthInput.value = String(this.settings.width);
      this.symmetryInput.checked = this.settings.symmetry;
      this.sourceInput.checked = this.settings.includeSource;
      this.image.style.visibility = this.settings.includeSource ? 'visible' : 'hidden';
      this.zoomOutput.value = this.source ? `${Math.round(this.fitScale * this.zoom * 100)}%` : '—';
      this.zoomOutput.title = this.source ? `${this.width} × ${this.height} 像素；滚轮缩放，空格拖动` : '请先导入图片或新建画布';
      this.shell.classList.toggle('fpa-paint-region-mode', this.regionMode && canEdit);
      this.shell.classList.toggle('fpa-paint-symmetry', this.settings.symmetry && !this.regionMode && canEdit);
      this.shell.classList.toggle('fpa-paint-source-hidden', !this.settings.includeSource);
      const moving = this.spaceDown || (!this.regionMode && this.settings.tool === 'pan') || this.readOnly;
      this.viewport.dataset.paintCursor = !canView ? 'default' : this.panGesture ? 'grabbing' : moving ? 'grab' : 'crosshair';
      this.toolbar.setAttribute('aria-busy', String(this.loading));
    }

    _emitChange() {
      if (this.source) this.onChange?.(this.getDraft());
    }

    _report(error) {
      if (this.onError) this.onError(error);
      else console.error(error);
    }

    async exportBlob() {
      await this.ensureReady();
      if (this.activeStroke) throw new Error('请先完成当前笔画，再导出线稿。');
      this._validateDimensions(this.width, this.height);
      // Keep full document resolution. Erasing occurs on its own transparent layer,
      // so it cannot remove the original photo or the white export background.
      const output = document.createElement('canvas');
      const ink = document.createElement('canvas');
      const width = this.width;
      const height = this.height;
      try {
        output.width = ink.width = width;
        output.height = ink.height = height;
        const context = output.getContext('2d');
        const inkContext = ink.getContext('2d');
        if (!context || !inkContext) throw new Error('无法分配原尺寸导出画布，请关闭其他大图后重试。');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        if (this.settings.includeSource) context.drawImage(this.sourceImage, 0, 0, width, height);
        for (const operation of this.operations) this._drawOperation(inkContext, operation, 1, 1);
        context.drawImage(ink, 0, 0);
        ink.width = ink.height = 1;
        const blob = await new Promise((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('原尺寸 PNG 导出失败，图片可能超出浏览器内存限制。请关闭其他大图后重试。')), 'image/png'));
        return blob;
      } catch (error) {
        if (error?.name === 'SecurityError') throw new Error('底图服务器不允许导出。请把原图保存到本地后重新上传，笔迹不会在本次导出中丢失。');
        if (error instanceof Error && /导出|画布|内存/.test(error.message)) throw error;
        throw new Error('原尺寸 PNG 导出失败，请关闭其他大图后重试；画板不会自动压缩尺寸。');
      } finally {
        output.width = output.height = ink.width = ink.height = 1;
      }
    }

    destroy() {
      ++this.loadToken;
      clearTimeout(this.viewSaveTimer);
      this.viewSaveTimer = null;
      this._cancelGesture();
      this.observer.disconnect();
      this.listeners.abort();
      this.canvas.remove();
      this.toolbar.replaceChildren();
      this.shell.classList.remove('fpa-paint-shell', 'fpa-paint-region-mode', 'fpa-paint-symmetry', 'fpa-paint-source-hidden');
      this.shell.style.transform = '';
      this.image.style.visibility = '';
      this.viewport.classList.remove('fpa-paint-viewport');
      delete this.viewport.dataset.paintCursor;
    }
  }

  window.FpaPaintBoard = FpaPaintBoard;
})();
