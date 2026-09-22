/* FPA document adapter. Native WeebPaint owns all drawing coordinates and pixels. */
(function () {
  'use strict';
  class FpaPaintBoard {
    constructor({ viewport, shell, toolbar, onChange, onError, onDirty, onDocumentChange, onExitFocus, onToggleFocus, onRegion, onRegionSelect, onNewCanvas }) {
      Object.assign(this, { viewport, onChange, onError, onDirty, onDocumentChange, onExitFocus, onToggleFocus, onRegion, onRegionSelect, onNewCanvas });
      shell.hidden = true; toolbar.hidden = true;
      this.source = null; this.requestedSource = null; this.draft = null;
      this.cache = new Map(); this.chain = Promise.resolve(); this.version = 0; this.savedVersion = 0;
      this.savedEngineRevision = null;
      this.locked = false; this.readOnly = false; this.loading = false; this.regions = []; this.selectedRegion = null;
      this.frame = document.createElement('iframe');
      this.frame.className = 'fpa-full-paint-frame'; this.frame.title = '完整线稿画板';
      this.frame.allow = 'clipboard-read; clipboard-write'; this.frame.hidden = true;
      this.loadingLabel = document.createElement('div'); this.loadingLabel.className = 'full-paint-loading';
      this.loadingLabel.setAttribute('role', 'status'); this.loadingLabel.hidden = true;
      viewport.append(this.frame, this.loadingLabel);
      this.listener = event => this._message(event);
      window.addEventListener('message', this.listener);
      this._prepareReady();
      this.frame.src = './full-paint.html';
    }
    _prepareReady() {
      this.engineReady = new Promise((resolve, reject) => {
        this.resolveReady = resolve; this.rejectReady = reject;
        this.readyTimeout = setTimeout(() => reject(new Error('完整画板加载超时，请刷新页面重试；已有草稿不会被清除')), 30000);
      });
      // Keep the original rejection available to ensureReady without an unhandled promise.
      this.engineReady.catch(error => this._error(error));
    }
    _message(event) {
      if (event.origin !== location.origin || event.source !== this.frame.contentWindow) return;
      const message = event.data;
      if (message?.type === 'fpa:paint-ready') {
        this.api = this.frame.contentWindow.FpaFullPaint;
        if (!this.api) return;
        clearTimeout(this.readyTimeout); this.resolveReady(this.api); this._syncControls();
      }
      if (message?.type === 'fpa:paint-exit-focus') this.onExitFocus?.();
      if (message?.type === 'fpa:paint-focus') this.onToggleFocus?.();
      if (message?.type === 'fpa:paint-new-canvas' && !this.locked && !this.readOnly && !this.loading) this.onNewCanvas?.();
      if (message?.type === 'fpa:paint-region' && this.regionAvailable && !this.locked && !this.readOnly && message.key === this.source?.key) this.onRegion?.(message.box);
      if (message?.type === 'fpa:paint-region-select' && this.regionAvailable && !this.locked && !this.readOnly && message.key === this.source?.key && this.regions.some(region => region.id === message.id)) this.onRegionSelect?.(message.id);
      if (message?.type === 'fpa:paint-reload-request') this.reloadEngine().catch(error => this._error(error));
      if (message?.type !== 'fpa:paint-change' || message.loaded || this.loading || !this.source || message.key !== this.source.key) return;
      this.version++;
      const size = this.api.getSize();
      this.draft = { ...(this.draft || {}), version: 2, engine: 'weebpaint', sourceKey: this.source.key, dirty: this.api.isDirty(), width: size.width, height: size.height };
      if (message.documentReplaced || message.sizeChanged) this.onDocumentChange?.({ sourceKey: this.source.key, ...size, documentReplaced: message.documentReplaced, sizeChanged: message.sizeChanged });
      this.onDirty?.();
    }
    _error(error) { this.onError?.(error); }
    _enqueue(task) { const pending = this.chain.catch(() => {}).then(task); this.chain = pending; return pending; }
    _syncControls() {
      if (!this.api) return;
      this.api.setReadOnly(this.readOnly);
      this.api.setLocked(this.locked || this.loading || !this.source);
      this.api.setRegions(this.regions, this.selectedRegion);
      this.api.setRegionAvailable?.(this.regionAvailable);
    }
    loadSource(source, draft = null) {
      if (source && this.requestedSource?.key === source.key && this.requestedSource?.src === source.src) return this.readyPromise || Promise.resolve();
      if (!source && !this.requestedSource && !this.source) return Promise.resolve();
      this.requestedSource = source;
      this.frame.hidden = !source;
      this.loadingLabel.hidden = !source; this.loadingLabel.textContent = '正在载入完整画板与图层…';
      this.readyPromise = this._enqueue(async () => {
        await this.engineReady;
        await this._flush();
        this.loading = true; this._syncControls();
        try {
          if (!source) { this.source = null; this.draft = null; this.version = this.savedVersion = 0; return; }
          const restored = this.cache.get(source.key) || draft;
          await this.api.loadDocument({ ...source, project: restored?.engine === 'weebpaint' ? restored.project : undefined,
            dirty: Boolean(restored?.dirty), legacyDraft: restored?.engine === 'weebpaint' ? undefined : restored,
            blankCanvas: Boolean(source.blankCanvas), quickSettings: restored?.quickSettings });
          this.source = source;
          const size = this.api.getSize();
          const migrated = Boolean(this.api.getQuickSettings?.()?.preview && !restored?.quickSettings?.preview);
          this.draft = { version: 2, engine: 'weebpaint', sourceKey: source.key, project: !migrated && restored?.engine === 'weebpaint' ? restored.project : null,
            ...(restored?.engine !== 'weebpaint' && restored ? { legacyDraft: restored } : restored?.legacyDraft ? { legacyDraft: restored.legacyDraft } : {}),
            dirty: this.api.isDirty(), width: size.width, height: size.height, quickSettings: this.api.getQuickSettings?.() };
          this.version = this.draft.dirty && !this.draft.project ? 1 : 0; this.savedVersion = 0;
          this.savedEngineRevision = this.api.getRevision?.() ?? null;
          if (this.version) this.onDirty?.();
        } finally { this.loading = false; this.loadingLabel.hidden = true; this._syncControls(); }
      });
      this.readyPromise.catch(error => { if (this.requestedSource === source) this.requestedSource = null; this.loadingLabel.hidden = false; this.loadingLabel.textContent = error.message; });
      return this.readyPromise;
    }
    async _flush() {
      if (!this.source || !this.api || this.loading || !this.draft) return;
      const engineRevision = this.api.getRevision?.() ?? null;
      if (this.savedVersion === this.version && engineRevision === this.savedEngineRevision && (!this.api.isDirty() || this.draft.project)) return;
      if (this.api.isBusy()) throw new Error('请先完成当前笔画、填色或选区变换，再保存或切换画板');
      const version = this.version, key = this.source.key;
      const nativeProject = await this.api.exportProject();
      // Own the Blob in the stable host realm: native frame reload destroys its
      // Promise realm, including old Blob.arrayBuffer() continuations.
      const project = new Blob([nativeProject], { type: nativeProject.type || 'image/openraster' });
      if (version !== this.version || key !== this.source?.key || engineRevision !== (this.api.getRevision?.() ?? null)) return this._flush();
      const size = this.api.getSize();
      this.draft = { version: 2, engine: 'weebpaint', sourceKey: key, project, ...(this.draft.legacyDraft ? { legacyDraft: this.draft.legacyDraft } : {}), dirty: this.api.isDirty(), width: size.width, height: size.height, quickSettings: this.api.getQuickSettings?.() };
      this.savedVersion = version; this.savedEngineRevision = engineRevision; this.cache.set(key, this.draft); this.onChange?.(this.draft);
    }
    reloadEngine() {
      if (this.reloading) return this.reloading;
      this.reloading = this._enqueue(async () => {
        await this.engineReady; await this._flush();
        const source = this.source, draft = this.draft;
        this.api.prepareReload?.();
        this.loading = true; this.loadingLabel.hidden = !source; this.loadingLabel.textContent = '正在恢复画板工程…';
        this.api = null; this._prepareReady();
        this.frame.contentWindow.location.reload();
        try {
          await this.engineReady;
          if (source) {
            await this.api.loadDocument({ ...source, project: draft?.project, dirty: draft?.dirty, blankCanvas: source.blankCanvas, quickSettings: draft?.quickSettings });
            this.savedEngineRevision = this.api.getRevision?.() ?? null;
          }
        } finally { this.loading = false; this.loadingLabel.hidden = true; this._syncControls(); }
      });
      this.reloading.finally(() => { this.reloading = null; }).catch(() => {});
      return this.reloading;
    }
    async flushDraft() { await this.ensureReady(); return this._enqueue(() => this._flush()); }
    persistenceToken() {
      if (!this.api || this.loading || this.api.isBusy()) return null;
      const revision = this.api.getRevision();
      if (this.source && (this.version !== this.savedVersion || revision !== this.savedEngineRevision)) return null;
      return { api: this.api, sourceKey: this.source?.key ?? null, key: this.api.getDocumentInfo().key, revision, version: this.version };
    }
    acknowledgePersistence(token) {
      const current = this.persistenceToken();
      if (!token || !current || ['api', 'sourceKey', 'key', 'revision', 'version'].some(key => current[key] !== token[key])) return false;
      return this.api.acknowledgePersistence({ key: token.key, revision: token.revision });
    }
    async ensureReady() { await this.engineReady; await this.chain.catch(() => {}); await this.readyPromise; }
    getDraft() { return this.draft ? { ...this.draft } : { sourceKey: null }; }
    setLocked(value) { this.locked = Boolean(value); this._syncControls(); }
    setReadOnly(value) { this.readOnly = Boolean(value); this._syncControls(); }
    setRegionAvailable(value) { this.regionAvailable = Boolean(value); this.api?.setRegionAvailable?.(this.regionAvailable); }
    setRegionMode() { /* The native selection tool owns selection coordinates. */ }
    setRegions(regions, selected) { this.regions = regions; this.selectedRegion = selected; this.api?.setRegions(regions, selected); }
    async selectionRegion() { await this.ensureReady(); if (!this.regionAvailable || this.locked || this.readOnly) throw new Error('当前画板不可设置局部区域'); const box = this.api.regionBounds(); if (!box) throw new Error('请先在画板用选区工具圈选需要修改的部位'); return box; }
    async startRegion() { await this.ensureReady(); if (!this.regionAvailable || this.locked || this.readOnly) throw new Error('请先打开可编辑的款式图片'); this.api.selectQuickTool('region'); }
    resize() { this.frame.contentWindow?.dispatchEvent(new Event('resize')); }
    fit() { this.api?.fit(); }
    isDrawing() { return Boolean(this.api?.isBusy()); }
    isDirty() { return Boolean(this.api?.isDirty() || this.draft?.dirty); }
    async hasVisibleInk() { await this.ensureReady(); return this.api.hasVisibleContent(); }
    getDocumentSize() { return this.api?.getSize() || { width: 0, height: 0 }; }
    async exportBlob() { await this.ensureReady(); if (this.isDrawing()) throw new Error('请先完成当前笔画、填色或选区变换'); return this.api.captureOriginal ? this.api.captureOriginal() : this.api.capture(); }
    destroy() { clearTimeout(this.readyTimeout); window.removeEventListener('message', this.listener); this.frame.remove(); this.loadingLabel.remove(); }
  }
  window.FpaPaintBoard = FpaPaintBoard;
})();
