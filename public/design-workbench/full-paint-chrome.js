(() => {
  'use strict';
  const root = document.documentElement;
  if (!document.getElementById('board') || !document.getElementById('topBar')) return;
  root.dataset.fpaPaint = 'full';
  // The embedded apparel canvas is intentionally a focused sketch editor.
  // Keep the upstream engine for document compatibility, but expose only the
  // tools needed by the line-art workflow. This also prevents large panels
  // from being mounted/repainted while the user is drawing on a big image.
  root.dataset.fpaUi = 'sketch';

  const labels = {
    menuButton: '更多', topSaveBtn: '保存', toolPen: '画笔', toolShape: '直线',
    toolEraser: '橡皮', toolPicker: '吸色', toolLasso: '选区', toolFill: '填色',
    toolHand: '移动', topAdjustBtn: '调整', layersButton: '图层', undoButton: '撤销', redoButton: '重做'
  };
  for (const [id, label] of Object.entries(labels)) {
    const control = document.getElementById(id);
    if (!control) continue;
    control.dataset.fpaLabel = label;
    if (!control.hasAttribute('aria-label')) control.setAttribute('aria-label', control.title || label);
    if (!control.title) control.title = label;
  }
  document.getElementById('board').setAttribute('aria-label', '线稿绘画画布');
  document.getElementById('topBar').setAttribute('aria-label', '绘画工具');
  document.getElementById('leftSidebar')?.setAttribute('aria-label', '笔刷参数与历史');
  document.querySelector('#topBar .tool-group')?.setAttribute('aria-label', '绘画工具');
  document.querySelector('#topBar .color-group')?.setAttribute('aria-label', '当前颜色');
  const developerTabLabel = document.querySelector('[data-menu-tab="dev"] span');
  if (developerTabLabel) developerTabLabel.textContent = '开发';
  const blenderLabel = document.querySelector('#menuBlender .menu-item-label');
  if (blenderLabel) blenderLabel.textContent = 'Blender 同步…';

  function actionButton(id, label, iconId, callback) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'tool';
    button.dataset.fpaLabel = label;
    button.title = label;
    button.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${iconId}`);
    svg.append(use);
    button.append(svg);
    button.addEventListener('click', callback);
    return button;
  }

  // Reuse the native controls and listeners; never keep a second set of tools.
  const topBar = document.getElementById('topBar');
  const tools = topBar.querySelector('.tool-group');
  for (const id of ['toolPen', 'toolShape', 'toolEraser', 'toolPicker', 'toolLasso', 'toolFill', 'toolHand']) tools.append(document.getElementById(id));
  topBar.append(document.getElementById('topAdjustBtn'), document.getElementById('layersButton'), topBar.querySelector('.color-group'), document.getElementById('menuButton'));
  // Keep upstream-owned nodes mounted so document/shortcut internals remain safe,
  // but remove their UI entries and tab stops from this apparel workbench.
  const removed = '#topSaveBtn,#topEncLock,#topBar .top-bar-sep,' +
    '[data-menu-tab="plugins"],[data-menu-tab="settings"],[data-menu-tab="dev"],' +
    '[data-menu-page="plugins"],[data-menu-page="settings"],[data-menu-page="dev"],' +
    '#menuGallery,#menuConnectGallery,#menuRename,#menuEncrypt,#menuRevertToOpen,#menuExportImageConfig,' +
    '#menuOffset,#menuReference,#menuTimelapse,#menuFit';
  for (const element of document.querySelectorAll(removed)) { element.classList.add('fpa-removed-control'); element.inert = true; }

  // These controls remain in the DOM because the upstream command router and
  // keyboard shortcuts reference them. They are not part of the line-art UI.
  // Hiding them here (rather than deleting nodes) keeps native state and old
  // projects compatible while avoiding accidental heavy panels.
  for (const id of ['toolShape', 'toolPicker', 'toolFill', 'topAdjustBtn', 'layersButton', 'menuButton']) {
    const control = document.getElementById(id);
    control?.classList.add('fpa-sketch-hidden-control');
    if (control) control.inert = true;
  }
  document.getElementById('toolShape')?.setAttribute('data-fpa-label', '直线');

  // Replace the upstream shape launcher with a single line tool. The native
  // shape picker is intentionally not opened in sketch mode.
  const lineButton = actionButton('fpaSketchLine', '直线', 'line', () => {
    try { window.FpaFullPaint?.selectQuickTool?.('line'); } catch (error) { feedback.textContent = error.message; }
  });
  lineButton.dataset.fpaLabel = '直线';
  tools.insertBefore(lineButton, document.getElementById('toolEraser'));
  document.querySelector('[data-menu-tab="file"]')?.click();
  const newCanvas = document.getElementById('menuNewArtwork');
  const newCanvasLabel = newCanvas?.querySelector('.menu-item-label');
  if (newCanvasLabel) { newCanvasLabel.removeAttribute('data-i18n'); newCanvasLabel.textContent = '新建空白画板'; }
  newCanvas?.addEventListener('click', event => {
    event.preventDefault(); event.stopImmediatePropagation();
    document.getElementById('menuButton').click();
    window.parent.postMessage({ type: 'fpa:paint-new-canvas' }, location.origin);
  }, true);
  document.getElementById('menuButton').addEventListener('click', () => {
    const active = document.querySelector('.menu-tab[aria-selected="true"]');
    if (active?.classList.contains('fpa-removed-control')) document.querySelector('[data-menu-tab="file"]')?.click();
  });

  const quick = document.createElement('div');
  quick.id = 'fpaQuickTools'; quick.setAttribute('role', 'group'); quick.setAttribute('aria-label', '当前工具参数与缩放');
  const invoke = callback => { try { callback(window.FpaFullPaint); } catch (error) { feedback.textContent = error.message; } syncQuick(); };
  const quickButton = (id, label, icon, callback) => {
    const button = actionButton(id, label, icon, () => invoke(callback));
    quick.append(button); return button;
  };
  const region = quickButton('fpaQuick-region', '用于局部材料', 'select-rectangle', api => {
    const box = api.regionBounds();
    if (box) window.parent.postMessage({ type: 'fpa:paint-region', key: api.getDocumentInfo().key, box }, location.origin);
    else api.selectQuickTool('region');
  });
  const field = (id, text, type) => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.id = id; input.type = type; input.setAttribute('aria-label', text);
    label.append(document.createTextNode(text), input); quick.append(label); return input;
  };
  const symmetry = field('fpaQuickSymmetry', '左右对称', 'checkbox');
  symmetry.parentElement.classList.add('fpa-symmetry-option');
  symmetry.addEventListener('change', () => invoke(api => api.setSymmetry(symmetry.checked)));
  const source = field('fpaQuickSource', '显示底图（出图时保留）', 'checkbox');
  source.title = '显示并导出底图；取消后只保留其他可见图层，生成使用同一画面';
  source.addEventListener('change', () => invoke(api => api.setIncludeSource(source.checked)));
  const clear = quickButton('fpaQuickClear', '清空笔迹，保留底图与局部标注（可撤销）', 'trash-can', api => api.clearInk());
  clear.className = 'menu-item menu-item-with-icon';
  const clearLabel = document.createElement('span'); clearLabel.className = 'menu-item-label'; clearLabel.textContent = '清空笔迹'; clear.append(clearLabel);
  source.parentElement.classList.add('fpa-source-option');
  document.querySelector('[data-menu-page="canvas"]').append(source.parentElement, clear);
  clear.addEventListener('click', () => document.getElementById('menuButton').click());
  const view = document.createElement('div'); view.className = 'fpa-view-controls'; view.setAttribute('role', 'group'); view.setAttribute('aria-label', '画布缩放');
  for (const [id, label, text, factor] of [['fpaQuickZoomOut', '缩小', '-', 1 / 1.2], ['fpaQuickZoomIn', '放大', '+', 1.2]]) {
    const button = quickButton(id, label, 'one-to-one', api => api.zoom(factor)); button.replaceChildren(document.createTextNode(text)); view.append(button);
  }
  const zoom = document.createElement('output'); zoom.id = 'fpaQuickZoom'; zoom.setAttribute('aria-label', '当前缩放'); view.insertBefore(zoom, view.lastElementChild);
  view.append(quickButton('fpaQuickFit', '适应画布', 'fit-contain', api => api.fit())); quick.append(view);
  const feedback = document.createElement('div'); feedback.id = 'fpaQuickFeedback'; feedback.setAttribute('role', 'status');
  document.body.append(quick, feedback);
  const contextDock = document.createElement('div');
  contextDock.id = 'fpaContextDock'; contextDock.setAttribute('aria-label', '当前工具选项');
  for (const control of document.querySelectorAll('.lasso-toolbar-stack, #cropToolbar')) contextDock.append(control);
  quick.insertBefore(contextDock, view);
  function syncQuick() {
    const state = window.FpaFullPaint?.getQuickState();
    for (const control of [...quick.querySelectorAll('button,input'), source, clear]) if (!contextDock.contains(control)) control.disabled = !state?.editable;
    if (!state) return;
    symmetry.checked = state.symmetry; source.checked = state.includeSource;
    source.disabled ||= !state.hasSource; clear.disabled ||= !state.hasSource;
    region.disabled ||= !state.regionAvailable;
    region.hidden = state.tool !== 'lasso' || !state.regionAvailable;
    region.setAttribute('aria-pressed', String(state.regionDrawing));
    const isStroke = ['brush', 'eraser', 'shapeBrush'].includes(state.tool);
    symmetry.parentElement.hidden = !isStroke;
    zoom.textContent = `${Math.round(state.zoom * 100)}%`;
  }
  let quickFrame = 0;
  const queueQuick = () => { if (!quickFrame) quickFrame = requestAnimationFrame(() => { quickFrame = 0; syncQuick(); }); };
  for (const event of ['fpa:paint-ready', 'fpa:paint-change', 'fpa:paint-controls', 'wp:histchange', 'wp:modechange', 'pointerup', 'input', 'change']) window.addEventListener(event, queueQuick);
  new MutationObserver(queueQuick).observe(document.body, { attributes: true, attributeFilter: ['data-fpa-locked', 'data-fpa-read-only'] });
  quick.addEventListener('pointerdown', () => { feedback.textContent = ''; });
  syncQuick();

  // Only constrain the first presentation and viewport resize; reopening preserves positions.
  const seenPanels = new WeakSet();
  const panelSelector = '.float-panel, .palette-window, wp-reference-window';
  let pendingFrame = 0;
  let resizePending = false;

  function clampPanel(panel) {
    if (panel.classList.contains('hidden') || panel.hidden || !panel.getClientRects().length) return;
    const bounds = panel.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const minimumTop = Number.parseFloat(getComputedStyle(root).getPropertyValue('--fpa-context-top')) || 66;
    const nextLeft = Math.max(6, Math.min(bounds.left, Math.max(6, innerWidth - bounds.width - 6)));
    const nextTop = Math.max(minimumTop, Math.min(bounds.top, Math.max(minimumTop, innerHeight - bounds.height - 6)));
    if (Math.abs(nextLeft - bounds.left) > 1) {
      panel.style.left = `${nextLeft}px`;
      panel.style.right = 'auto';
    }
    if (Math.abs(nextTop - bounds.top) > 1) {
      panel.style.top = `${nextTop}px`;
      panel.style.bottom = 'auto';
    }
    seenPanels.add(panel);
  }

  function schedulePanelCheck(resize = false) {
    resizePending ||= resize;
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const resizeNow = resizePending;
      resizePending = false;
      for (const panel of document.querySelectorAll(panelSelector)) {
        if (resizeNow || !seenPanels.has(panel)) clampPanel(panel);
      }
    });
  }

  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList' || record.target.matches?.(panelSelector))) schedulePanelCheck();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  window.addEventListener('resize', () => schedulePanelCheck(true));
  schedulePanelCheck();
})();
