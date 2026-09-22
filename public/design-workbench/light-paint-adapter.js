/* Lightweight FPA adapter. Keeps the host contract while avoiding the
   heavyweight WeebPaint iframe for the line-art workflow. */
(function () {
  'use strict';

  const NativePaintBoard = window.FpaPaintBoard;

  class FpaLightPaintBoard {
    constructor(options) {
      Object.assign(this, options);
      document.documentElement.classList.add('fpa-light-paint');
      this.source = null;
      this.requestedSource = null;
      this.draft = null;
      this.loading = false;
      this.locked = false;
      this.readOnly = false;
      this.regionAvailable = false;
      this.version = 0;
      this.savedVersion = 0;
      this.readyPromise = Promise.resolve();
      this.board = new NativePaintBoard({
        viewport: options.viewport,
        shell: options.shell,
        image: options.image,
        overlay: options.overlay,
        toolbar: options.toolbar,
        onChange: draft => {
          if (!this.source || draft?.sourceKey !== this.source.key) return;
          this.draft = draft;
          this.version++;
          this.onDirty?.();
          this.onChange?.(draft);
        },
        onError: options.onError,
        onRegionTool: enabled => this.onRegionTool?.(enabled)
      });
    }

    async loadSource(source, draft = null) {
      if (source && this.requestedSource?.key === source.key && this.requestedSource?.src === source.src) return this.readyPromise;
      this.requestedSource = source || null;
      this.loading = Boolean(source);
      this._sync();
      this.readyPromise = this.board.loadSource(source, draft);
      try {
        await this.readyPromise;
        this.source = source || null;
        this.draft = source ? this.board.getDraft() : null;
        this.version = 0;
        this.savedVersion = 0;
      } finally {
        this.loading = false;
        this._sync();
      }
      return this.readyPromise;
    }

    _sync() {
      this.board.setLocked(this.locked || this.loading);
      this.board.setReadOnly(this.readOnly);
      this.board.setRegionAvailable(this.regionAvailable);
    }
    async ensureReady() { await this.readyPromise; return this.board.ensureReady(); }
    async flushDraft() { await this.ensureReady(); this.draft = this.board.getDraft(); this.savedVersion = this.version; return this.draft; }
    persistenceToken() { return this.source && !this.board.isDrawing() && this.version === this.savedVersion ? { sourceKey: this.source.key, version: this.version } : null; }
    acknowledgePersistence(token) { return Boolean(token && this.persistenceToken()?.sourceKey === token.sourceKey); }
    getDraft() { return this.board.getDraft() || { sourceKey: null }; }
    setLocked(value) { this.locked = Boolean(value); this._sync(); }
    setReadOnly(value) { this.readOnly = Boolean(value); this._sync(); }
    setRegionAvailable(value) { this.regionAvailable = Boolean(value); this.board.setRegionAvailable(this.regionAvailable); }
    setRegionMode(value) { this.board.setRegionMode(value); }
    resize() { this.board.resize(); }
    fit() { this.board.fit(); }
    isDrawing() { return this.board.isDrawing(); }
    isDirty() { return this.board.isDirty(); }
    hasVisibleInk() { return this.board.hasVisibleInk(); }
    getDocumentSize() { return this.board.getDocumentSize(); }
    async exportBlob() { return this.board.exportBlob(); }
    async selectionRegion() { throw new Error('请在画布上拖动框选需要修改的区域'); }
    async startRegion() { this.onRegionTool?.(true); }
    destroy() { this.board.destroy(); }
  }

  window.FpaPaintBoard = FpaLightPaintBoard;
})();
