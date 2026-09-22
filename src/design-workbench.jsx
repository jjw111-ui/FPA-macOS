import { useEffect, useRef, useState } from 'react';
import './design-workbench.css';

const modes = [
  { id: 'reference', label: '参考改款', src: '/design-workbench/index.html' },
  { id: 'sketch', label: '线稿成衣', src: '/design-workbench/sketch.html?v=full-paint-20260917' },
];
const reuseMode = request => ['photo_to_sketch', 'sketch_to_garment'].includes(request?.designMode) ? 'sketch' : 'reference';

export function DesignWorkbench({ active, reuseRequest, onReused, onHistory, onSettings, onSubmitted }) {
  const frames = useRef({});
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('fpa-design-mode') === 'sketch' ? 'sketch' : 'reference'; }
    catch { return 'reference'; }
  });
  const [visited, setVisited] = useState({});
  const [ready, setReady] = useState({});
  const [editorReady, setEditorReady] = useState({});
  const [focusedMode, setFocusedMode] = useState(null);
  const sentRequest = useRef(null);
  useEffect(() => {
    if (active) setVisited(current => current[mode] ? current : { ...current, [mode]: true });
  }, [active, mode]);
  useEffect(() => {
    if (reuseRequest) setMode(reuseMode(reuseRequest));
  }, [reuseRequest]);
  useEffect(() => {
    try { localStorage.setItem('fpa-design-mode', mode); } catch { /* Both drafts still use IndexedDB. */ }
  }, [mode]);
  useEffect(() => {
    if (active && ready[mode]) frames.current[mode]?.contentWindow?.postMessage({ type: 'fpa:design-activated' }, window.location.origin);
  }, [active, ready, mode]);
  useEffect(() => {
    if (active && editorReady[mode] && reuseRequest && mode === reuseMode(reuseRequest) && sentRequest.current !== reuseRequest.requestId) {
      sentRequest.current = reuseRequest.requestId;
      frames.current[mode]?.contentWindow?.postMessage({type:'fpa:design-reuse',...reuseRequest},window.location.origin);
    }
  }, [active, editorReady, reuseRequest, mode]);
  useEffect(() => {
    function receive(event) {
      if (event.origin !== window.location.origin) return;
      const sourceMode = modes.find(item => event.source === frames.current[item.id]?.contentWindow)?.id;
      if (!sourceMode) return;
      if (event.data?.type === 'fpa:design-history') onHistory();
      if (event.data?.type === 'fpa:design-settings') onSettings(['system', 'design-generation', 'quiver'].includes(event.data.section) ? event.data.section : 'analysis');
      if (event.data?.type === 'fpa:design-submitted') onSubmitted();
      if (event.data?.type === 'fpa:design-focus') setFocusedMode(event.data.enabled ? sourceMode : null);
      if (event.data?.type === 'fpa:design-ready') setEditorReady(current => ({ ...current, [sourceMode]: true }));
      if (event.data?.type === 'fpa:design-reused') onReused?.(event.data);
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onHistory, onSettings, onSubmitted, onReused]);
  if (!Object.keys(visited).length) return null;
  return <section className={`ws-design-host${mode === 'sketch' ? ' is-sketch' : ''}${active && focusedMode === mode ? ' is-focused' : ''}`} hidden={!active} aria-label="设计工作台">
    <div className="ws-design-modes" role="tablist" aria-label="设计方式">
      {modes.map((item, index) => <button key={item.id} id={`design-mode-${item.id}`} type="button" role="tab" aria-selected={mode === item.id} aria-controls={`design-panel-${item.id}`} tabIndex={mode === item.id ? 0 : -1} onClick={() => setMode(item.id)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? modes[0] : event.key === 'End' ? modes[modes.length - 1] : modes[(index + 1) % modes.length];
        setMode(next.id); document.getElementById(`design-mode-${next.id}`)?.focus();
      }}>{item.label}</button>)}
    </div>
    {modes.map(item => visited[item.id] && <div key={item.id} id={`design-panel-${item.id}`} className="ws-design-panel" role="tabpanel" aria-labelledby={`design-mode-${item.id}`} hidden={mode !== item.id}>
      {!ready[item.id] && <p className="ws-design-loading" role="status">正在打开{item.label}…</p>}
      <iframe ref={element => { frames.current[item.id] = element; }} className="ws-design-frame" title={`设计工作台 · ${item.label}`} src={item.src} onLoad={() => setReady(current => ({ ...current, [item.id]: true }))} allow="clipboard-write"/>
    </div>)}
  </section>;
}
