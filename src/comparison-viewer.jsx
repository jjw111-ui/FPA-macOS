import { useEffect, useRef, useState } from 'react';
import { CaretLeft, CaretRight, DownloadSimple } from '@phosphor-icons/react';
import './comparison-viewer.css';

const fit = { scale: 1, x: 0, y: 0 };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function ZoomImage({ src, label }) {
  const viewport = useRef(null);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const transform = useRef(fit);
  const [view, setView] = useState(fit);
  const [status, setStatus] = useState('loading');
  const [dragging, setDragging] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  function update(next) {
    const box = viewport.current;
    const scale = clamp(next.scale, 1, 6);
    // Bound movement to the scaled viewport so the image cannot be lost offscreen.
    const maxX = (box?.clientWidth || 0) * (scale - 1) / 2;
    const maxY = (box?.clientHeight || 0) * (scale - 1) / 2;
    const bounded = { scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
    transform.current = bounded; setView(bounded);
  }
  function zoomAt(factor, x = 0, y = 0) {
    const old = transform.current;
    const scale = clamp(old.scale * factor, 1, 6);
    const ratio = scale / old.scale;
    update({ scale, x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio });
  }
  useEffect(() => {
    const box = viewport.current;
    function wheel(event) {
      event.preventDefault();
      const rect = box.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1);
      zoomAt(Math.exp(-clamp(delta, -150, 150) * .003), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    }
    const resize = new ResizeObserver(() => { update(fit); pointers.current.clear(); gesture.current = null; setDragging(false); });
    resize.observe(box);
    box.addEventListener('wheel', wheel, { passive: false });
    return () => { resize.disconnect(); box.removeEventListener('wheel', wheel); };
  }, []);

  function beginGesture() {
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const [a, b] = points, rect = viewport.current.getBoundingClientRect();
      gesture.current = { ...transform.current, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2 - rect.left - rect.width / 2, cy: (a.y + b.y) / 2 - rect.top - rect.height / 2 };
    } else gesture.current = null;
  }
  function pointerDown(event) {
    if (event.button !== 0 || pointers.current.size >= 2 || status !== 'ready') return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginGesture(); setDragging(true);
  }
  function pointerMove(event) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()], start = gesture.current;
      const rect = viewport.current.getBoundingClientRect();
      const scale = clamp(start.scale * Math.hypot(a.x - b.x, a.y - b.y) / start.distance, 1, 6);
      update({ scale, x: (a.x + b.x) / 2 - rect.left - rect.width / 2 - (start.cx - start.x) * scale / start.scale, y: (a.y + b.y) / 2 - rect.top - rect.height / 2 - (start.cy - start.y) * scale / start.scale });
    } else update({ ...transform.current, x: transform.current.x + event.clientX - previous.x, y: transform.current.y + event.clientY - previous.y });
  }
  function pointerEnd(event) { pointers.current.delete(event.pointerId); beginGesture(); setDragging(pointers.current.size > 0); }
  function keyDown(event) {
    if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
    if (['+', '='].includes(event.key)) zoomAt(1.25);
    if (event.key === '-') zoomAt(.8);
    if (event.key === '0') update(fit);
    const offsets = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
    if (offsets[event.key]) update({ ...transform.current, x: transform.current.x + offsets[event.key][0], y: transform.current.y + offsets[event.key][1] });
  }
  return <div ref={viewport} className={`ws-compare-image ${dragging ? 'dragging' : ''}`} role="group" aria-label={`${label}，可缩放图片`} tabIndex={0} title="滚轮放大 · 拖动查看 · 双击恢复；触屏可双指缩放" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onDoubleClick={() => update(fit)} onKeyDown={keyDown}>
    <img src={src} alt={label} draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, visibility: status === 'ready' ? 'visible' : 'hidden' }} onLoad={e => { setDimensions({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }); setStatus('ready'); }} onError={() => setStatus('error')}/>
    {status !== 'ready' && <p className="ws-compare-placeholder" role="status">{status === 'error' ? '图片暂时无法加载' : '正在加载图片…'}</p>}
    {status === 'ready' && <span className="ws-compare-scale">{view.scale > 1.01 ? `${Math.round(view.scale * 100)}%` : `${dimensions.width} × ${dimensions.height}`}</span>}
  </div>;
}

export function ComparisonViewer({ job, categories }) {
  const referenceLabel = asset => job.kind === 'design'
    ? asset.role === '主体款式参考' && job.designMode === 'sketch_to_garment' ? '主体线稿' : asset.role || '参考素材'
    : categories[asset.part] || '素材';
  const references = (job.references || []).filter(a => a.image);
  const results = job.images?.length ? job.images : [job.image].filter(Boolean);
  const [referenceIndex, setReferenceIndex] = useState(() => Math.max(0, references.findIndex(a => !['face', 'person', 'pose'].includes(a.part))));
  const [resultIndex, setResultIndex] = useState(0);
  const selected = references[referenceIndex];
  const result = results[resultIndex];
  const format = job.outputFormat || result?.split('.').pop()?.toLowerCase() || 'png';
  return <div className="ws-comparison">
    <div className={`ws-compare-panels ${!selected ? 'result-only' : ''}`}>
      {selected && <section className="ws-compare-pane" aria-label="参考素材"><header><span>{referenceLabel(selected)}{selected.placement ? ` · ${selected.placement}` : ''}</span><strong title={selected.name}>{selected.name}</strong></header><ZoomImage key={`${referenceIndex}:${selected.image}`} src={selected.image} label={`参考素材：${selected.name}`}/></section>}
      <section className="ws-compare-pane" aria-label="生成结果"><header><span>生成结果 · {resultIndex + 1} / {results.length}</span><div className="ws-result-toolbar">{results.length > 1 && <button type="button" aria-label="上一张生成结果" title="上一张" disabled={resultIndex === 0} onClick={() => setResultIndex(index => index - 1)}><CaretLeft/></button>}<a href={result} download={`${job.name}-${resultIndex + 1}.${format}`}><DownloadSimple/>下载此图</a>{results.length > 1 && <button type="button" aria-label="下一张生成结果" title="下一张" disabled={resultIndex === results.length - 1} onClick={() => setResultIndex(index => index + 1)}><CaretRight/></button>}</div></header><ZoomImage key={result} src={result} label={`生成结果 ${resultIndex + 1}：${job.name}`}/>{results.length > 1 && <nav className="ws-result-thumbnails" aria-label="切换生成结果">{results.map((image, index) => <button key={image} className={index === resultIndex ? 'active' : ''} aria-pressed={index === resultIndex} aria-label={`查看第 ${index + 1} 张生成结果`} onClick={() => setResultIndex(index)}><img src={image} alt=""/><span>{index + 1}</span></button>)}</nav>}</section>
    </div>
    {!!references.length && <nav className="ws-compare-thumbnails" aria-label="切换参考素材">{references.map((asset, index) => <button key={`${asset.id}:${index}`} className={index === referenceIndex ? 'active' : ''} aria-pressed={index === referenceIndex} aria-label={`对比${referenceLabel(asset)}：${asset.name}`} title={asset.name} onClick={() => setReferenceIndex(index)}><img src={asset.image} alt=""/><span>{referenceLabel(asset)}</span></button>)}</nav>}
  </div>;
}
