import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, X, Check, ArrowRight, UploadSimple, SquaresFour, Sparkle, ClockCounterClockwise, User, PersonSimple, TShirt, DownloadSimple, PencilSimple, Archive, ArrowCounterClockwise, GearSix, StopCircle, TrashSimple, WifiHigh, FloppyDisk } from '@phosphor-icons/react';
import './studio.css';
import './studio-management.css';
import './composer-layout.css';
import { ComparisonViewer } from './comparison-viewer.jsx';
import { OUTPUT_PRESETS, RESOLUTIONS, RESOLUTION_LABELS, resolveOutputSettings, pixelLabel } from './output-settings.mjs';
import { MAX_IMAGE_BYTES } from './image-limits.mjs';
import { DesignWorkbench } from './design-workbench.jsx';
import { AnalysisSettingsCard, DesignGenerationSettingsCard, QuiverSettingsCard, TypeSafeSettingsCard } from './analysis-settings.jsx';
import { currentSearchMetadata, needsSearchLabels } from './asset-search.mjs';
import { AssetLabelFields, LabelBatch, requestAssetLabels } from './asset-labels.jsx';
import { useAssetSearch } from './use-asset-search.jsx';

const PARTS = { upperbody: '上衣', wholebody_up: '外套', lowerbody: '下装', dress: '内搭', shoes: '鞋子', accessories_up: '配饰', fabric: '面料', trims: '辅料', person: '人物体型', face: '人物人脸', pose: '人物姿势', scene: '场景' };
const REFERENCE_LABELS = { ...PARTS, design: '设计参考' };
const TABS = [['library', '素材库', SquaresFour], ['compose', '搭配工作台', Sparkle], ['design', '设计工作台', PencilSimple], ['history', '生成记录', ClockCounterClockwise], ['settings', '系统设置', GearSix]];
const STATES = { queued: '排队中', processing: '正在生成', complete: '已完成', failed: '生成失败', cancelled: '已取消' };
const QUALITY_LABELS = { auto: '自动', low: '低', medium: '中', high: '高' };
const FORMAT_LABELS = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' };
const MODERATION_LABELS = { auto: '自动', low: '低' };
const isClothing = a => ['upperbody', 'wholebody_up', 'lowerbody', 'dress', 'shoes', 'accessories_up'].includes(a.part);
const isAccessory = a => a.part === 'accessories_up';
const isMaterial = a => ['fabric', 'trims'].includes(a.part);
const canClean = a => isClothing(a) || isMaterial(a);
const cleanKindLabel = a => isAccessory(a) ? '配饰整理' : isMaterial(a) ? `${PARTS[a.part]}整理` : '单品整理';
const MATERIAL_GUIDANCE = {
  fabric: { notes: '例如：只提取蓝色斜纹面料，保留织纹、纹理、花型和颜色。', description: '提取指定面料，保留织纹、花型与颜色，整理为清晰面料参考图；保留原图，使用图像接口额度。' },
  trims: { notes: '例如：只提取金属拉链，保留齿形、拉头、材质和颜色；也可上传纽扣、织带或花边。', description: '提取指定辅料，保留形状、结构、材质与颜色，生成白底辅料图；保留原图，使用图像接口额度。' },
};
const isPerson = a => ['face', 'person'].includes(a.part);
const isSceneJob = job => job.kind === 'scene' || (job.kind === 'clean' && job.references?.some(asset => asset.part === 'scene'));
const jobKindLabel = job => job.kind === 'design' ? ({ photo_to_sketch: '款式线稿', sketch_to_garment: '线稿成衣' }[job.designMode] || '设计效果图') : job.kind === 'fullbody' ? '人物全身照' : job.kind === 'face' ? '正脸参考图' : isSceneJob(job) ? '场景提取' : job.kind === 'clean' ? cleanKindLabel(job.references?.find(canClean) || {}) : '搭配图';
const initialForm = { name: '', scene: '浅灰色摄影棚，柔和自然光', direction: '', poseText: '正面自然站立，双臂放松，完整展示服装', aspectRatio: '2:3', resolution: '1K', quality: 'auto', count: 1, outputFormat: 'png', moderation: 'auto' };
const elapsedLabel = milliseconds => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};
const jobStateLabel = job => job.resultUncertain ? '结果待确认' : STATES[job.status];
const jobProgressText = job => {
  if (job.status === 'queued') return job.queuePosition ? `等待队列第 ${job.queuePosition} 位 · 尚未发送到图像服务` : '等待空闲名额，按提交顺序开始';
  if (job.status !== 'processing') return job.error;
  const elapsed = job.startedAt ? Date.now() - Date.parse(job.startedAt) : job.elapsedMs;
  const limit = job.requestTimeoutMs ? Math.round(job.requestTimeoutMs / 60000) : 10;
  return `已等待 ${elapsedLabel(elapsed) || '片刻'} · 最多等待 ${limit} 分钟，不会自动重试`;
};
async function api(url, method = 'GET', data) {
  const res = await fetch(`/api/studio/${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const value = await res.json(); if (!res.ok) throw new Error(value.error || '操作失败，请稍后重试。'); return value;
}
const readImage = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取图片。')); reader.readAsDataURL(file); });
const thumb = url => url && typeof url === 'string' && url.startsWith('/api/studio/files/') && !url.endsWith('.svg') ? `${url}?w=thumb` : url;

function SegmentedControl({ label, name, value, options, onChange, className = '' }) {
  return <div className={`ws-control-group ${className}`}>
    <span className="ws-control-label">{label}</span>
    <div className="ws-segmented" role="radiogroup" aria-label={label}>
      {options.map(option => <label key={option.value}>
        <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)}/>
        <span>{option.label}</span>
      </label>)}
    </div>
  </div>;
}

function OutputSettings({ value, onChange }) {
  const output = resolveOutputSettings(value);
  const update = change => onChange({ ...value, ...change });
  return <fieldset className="ws-output-settings">
    <legend>出图设置</legend>
    <div className="ws-control-group ws-ratio-group">
      <span className="ws-control-label">比例</span>
      <div className="ws-ratio-options" role="radiogroup" aria-label="图片比例">
        {OUTPUT_PRESETS.map(preset => <label key={preset.ratio} title={`${preset.label} · ${pixelLabel(preset.sizes[output.resolution])}`}>
          <input type="radio" name="output-aspect-ratio" value={preset.ratio} checked={output.aspectRatio === preset.ratio} onChange={() => update({ aspectRatio: preset.ratio })}/>
          <span><i style={{ aspectRatio: preset.ratio.replace(':', ' / ') }}/>{preset.ratio}</span>
        </label>)}
      </div>
    </div>
    <div className="ws-output-grid">
      <SegmentedControl label="分辨率" name="output-resolution" value={output.resolution} options={RESOLUTIONS.map(resolution => ({ value: resolution, label: resolution }))} onChange={resolution => update({ resolution })}/>
      <SegmentedControl label="质量" name="output-quality" value={value.quality || 'auto'} options={Object.entries(QUALITY_LABELS).map(([optionValue, label]) => ({ value: optionValue, label }))} onChange={quality => update({ quality })}/>
      <SegmentedControl label="数量" name="output-count" value={Number(value.count) || 1} options={[1, 2, 3, 4].map(count => ({ value: count, label: String(count) }))} onChange={count => update({ count })}/>
      <SegmentedControl label="输出格式" name="output-format" value={value.outputFormat || 'png'} options={Object.entries(FORMAT_LABELS).map(([optionValue, label]) => ({ value: optionValue, label }))} onChange={outputFormat => update({ outputFormat })}/>
      <SegmentedControl label="审核" name="output-moderation" value={value.moderation || 'auto'} options={Object.entries(MODERATION_LABELS).map(([optionValue, label]) => ({ value: optionValue, label }))} onChange={moderation => update({ moderation })}/>
      <div className="ws-output-summary" aria-live="polite"><span>输出像素</span><strong>{pixelLabel(output.size)} px</strong></div>
    </div>
  </fieldset>;
}

function JobDimensions({ job }) {
  let resolution = '';
  if (job.kind === 'outfit') {
    try { resolution = resolveOutputSettings(job).resolution; } catch { /* Keep old or incomplete records readable. */ }
  }
  const sceneOutput = isSceneJob(job) && job.sourceSize;
  const nativeDesign = job.kind === 'design' && (job.nativeSize || job.providerProtocol === 'gemini');
  const actualMismatch = Boolean(!sceneOutput && !job.nativeSize && job.actualSize && job.size && job.actualSize !== job.size);
  const quiverVector = job.kind === 'design' && job.sketchProvider === 'quiver';
  return <div className="ws-job-dimensions">
    <span>{quiverVector ? 'Quiver 矢量线稿' : job.nativeSize ? `请求 ${job.resolution} · ${job.aspectRatio}` : <>{resolution && `${resolution} · `}请求 {pixelLabel(job.size)}</>}</span>
    {job.kind !== 'design' && job.quality && <span>画质 {QUALITY_LABELS[job.quality] || job.quality}</span>}
    {nativeDesign ? <span>{job.count || 1} 张 · 安全设置 {{off:'关闭过滤',block_all:'拦截全部'}[job.safetyPreset] || '接口默认'} · Google 搜索 {job.googleSearch ? '开启' : '关闭'}</span> : <span>{job.count || 1} 张 · {FORMAT_LABELS[job.outputFormat] || 'PNG'} · 审核 {MODERATION_LABELS[job.moderation] || '自动'}</span>}
    {sceneOutput ? <span>原图画幅 {pixelLabel(job.sourceSize)} · 已按原图保存</span> : job.actualSize && <span className={actualMismatch ? 'ws-actual-mismatch' : ''} title={actualMismatch ? '服务商返回的图片尺寸与请求不同，应用保留了原始图片，没有拉伸或裁剪。' : undefined}>实际 {pixelLabel(job.actualSize)}{job.images?.length > 1 ? ` · 共 ${job.images.length} 张` : ''}{actualMismatch ? ' · 服务商返回' : ''}</span>}
    {job.elapsedMs && <span>耗时 {elapsedLabel(job.elapsedMs)}</span>}
    {job.httpStatus && <span>HTTP {job.httpStatus}{job.providerCode ? ` · ${job.providerCode}` : ''}</span>}
    {job.requestId && <span className="ws-request-id" title={job.requestId}>请求编号 {job.requestId}</span>}
  </div>;
}

function Modal({ title, onClose, children, className = '', actions }) {
  const ref = useRef(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    const key = event => {
      if (event.key === 'Escape') closeRef.current?.();
      if (event.key === 'Tab') {
        const controls = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key); const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <div className="ws-modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose?.()}><section ref={ref} className={`ws-modal ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header><h2>{title}</h2><div className="ws-modal-actions">{actions}<button className="ws-icon" onClick={onClose} disabled={!onClose} aria-label="关闭弹窗" title="关闭"><X size={22}/></button></div></header>{children}</section></div>;
}

function SettingsPanel({ settings = {}, onSaved, focusTarget = null }) {
  const [form, setForm] = useState({ apiKey: '', baseUrl: settings.baseUrl || 'https://api.openai.com/v1', model: settings.model || 'gpt-image-2', quality: settings.quality || 'high', timeoutMinutes: settings.timeoutMinutes || 5, concurrency: settings.concurrency ?? 2 });
  const [busy, setBusy] = useState(false), [testing, setTesting] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  useEffect(() => setForm(current => ({ ...current, baseUrl: settings.baseUrl || current.baseUrl, model: settings.model || current.model, quality: settings.quality || current.quality, timeoutMinutes: settings.timeoutMinutes || current.timeoutMinutes, concurrency: settings.concurrency ?? current.concurrency })), [settings.baseUrl, settings.model, settings.quality, settings.timeoutMinutes, settings.concurrency]);
  const data = () => ({ ...form, timeoutMinutes: Number(form.timeoutMinutes), concurrency: Number(form.concurrency) });
  async function save(extra = {}) {
    setBusy(true); setError(''); setMessage('');
    try {
      const saved = await api('settings', 'PATCH', { ...data(), ...extra });
      setForm(current => ({ ...current, apiKey: '', baseUrl: saved.baseUrl, model: saved.model, quality: saved.quality, timeoutMinutes: saved.timeoutMinutes, concurrency: saved.concurrency ?? current.concurrency }));
      setMessage(extra.clearKey ? '密钥已清除。' : '设置已保存。'); await onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function test() {
    setTesting(true); setError(''); setMessage('');
    try { const result = await api('settings/test', 'POST', data()); setMessage(`${result.message} 耗时 ${elapsedLabel(result.elapsedMs)}。`); }
    catch (err) { setError(err.message); } finally { setTesting(false); }
  }
  return <section className="ws-settings" aria-label="系统设置">
    <div className={`ws-settings-card${focusTarget === 'system' ? ' is-focused' : ''}`}><h2>图像生成接口</h2><p>用于搭配出图、线稿成衣、素材整理和人物正脸生成。</p><div className="ws-settings-heading"><span className={`ws-settings-status ${settings.configured ? 'ready' : ''}`}><span/>{settings.configured ? '图像接口已配置' : '图像接口未配置'}</span><small>{settings.maskedKey ? `${settings.keySource} · ${settings.maskedKey}` : '密钥只保存在本机'}</small></div>
      <div className="ws-settings-grid">
        <label className="wide">API Key<input type="password" value={form.apiKey} autoComplete="new-password" onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder={settings.maskedKey ? '留空则保留现有密钥' : '输入图像接口密钥'}/></label>
        <label className="wide">接口地址<input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1"/></label>
        <label>图像模型<input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}/></label>
        <label>默认画质<select value={form.quality} onChange={e => setForm({ ...form, quality: e.target.value })}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
        <label>单次最长等待（分钟）<input type="number" min="1" max="5" step="1" value={form.timeoutMinutes} onChange={e => setForm({ ...form, timeoutMinutes: e.target.value })}/><small>最多 5 分钟，超时后标记失败，不会自动重试。</small></label>
        <label>同时生成任务数<select value={form.concurrency} onChange={e => setForm({ ...form, concurrency: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 7, 8].map(count => <option key={count} value={count}>{count} 个{count === 1 ? '（逐个生成）' : ''}</option>)}</select><small>其余任务按提交顺序排队。保存后，调高会立即开始更多任务；调低会等待正在生成的任务完成。</small></label>
      </div>
      <p className="ws-settings-help">连接检测只读取模型列表，不生成图片、不消耗生图额度。你填写的模型名称会原样发送，应用不会自动切换模型；若服务商不支持该模型或参数，会直接显示服务商错误。密钥不会显示在页面或记录中。</p>
      {message && <p className="ws-settings-message" role="status">{message}</p>}{error && <p className="ws-error" role="alert">{error}</p>}
      <footer><button className="ws-button" type="button" disabled={busy || testing} onClick={test}><WifiHigh size={18}/>{testing ? '正在检测…' : '检测连接'}</button><button className="ws-button primary" type="button" disabled={busy || testing} onClick={() => save()}><FloppyDisk size={18}/>{busy ? '正在保存…' : '保存设置'}</button></footer>
      {settings.configured && <button className="ws-settings-clear" type="button" disabled={busy || testing} onClick={() => window.confirm('清除本地密钥后将无法生成图片，是否继续？') && save({ clearKey: true, apiKey: '' })}>清除本地密钥</button>}
    </div>
      <DesignGenerationSettingsCard focusRequested={focusTarget === 'design-generation'}/>
    <QuiverSettingsCard focusRequested={focusTarget === 'quiver'}/>
    <AnalysisSettingsCard focusRequested={focusTarget === 'analysis'}/>
    <TypeSafeSettingsCard focusRequested={focusTarget === 'typesafe'}/>
    <div className="ws-settings-card compact"><h2>本地数据</h2><p>素材、搭配记录和生成图都保存在应用的 <code>data</code> 目录。备份整个目录即可保留所有内容。</p></div>
  </section>;
}

function AssetForm({ asset, category, configured, visionConfigured, onClose, onSaved }) {
  const [part, setPart] = useState(asset?.part || category || 'upperbody');
  const [name, setName] = useState(asset?.name || '');
  const [notes, setNotes] = useState(asset?.notes || '');
  const [mode, setMode] = useState('original');
  const [labelAsset,setLabelAsset]=useState(asset);
  const [labels,setLabels]=useState(()=>currentSearchMetadata(asset || {}));
  const [labelsDirty,setLabelsDirty]=useState(false), [labelBusy,setLabelBusy]=useState(false);
  const [recognizeUpload,setRecognizeUpload]=useState(false);
  const [imageVersion, setImageVersion] = useState(asset?.faceImage && asset.image === asset.faceImage ? 'face' : asset?.sceneImage && asset.image === asset.sceneImage ? 'scene' : asset?.fullBodyImage && asset.image === asset.fullBodyImage ? 'fullbody' : asset?.cleanedImage === asset?.image && asset?.cleanedImage ? 'cleaned' : 'original');
  const [files, setFiles] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef(null), fileListRef = useRef([]);
  const [dragging, setDragging] = useState(false);
  const person = isPerson({ part });
  const accessory = isAccessory({ part });
  const material = isMaterial({ part });
  useEffect(() => () => fileListRef.current.forEach(f => URL.revokeObjectURL(f.preview)), []);
  useEffect(() => {
    if (asset) return undefined;
    const paste = event => {
      const images = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (images.length) { event.preventDefault(); choose(images); }
    };
    document.addEventListener('paste', paste); return () => document.removeEventListener('paste', paste);
  }, [asset]);
  function choose(incoming) {
    const list = [...incoming];
    if (list.some(f => !['image/png', 'image/jpeg', 'image/webp'].includes(f.type) || f.size > MAX_IMAGE_BYTES)) { setError('请使用 50MB 以内的 PNG、JPG 或 WebP 图片。'); return; }
    fileListRef.current.forEach(f => URL.revokeObjectURL(f.preview));
    const next = list.map(file => ({ file, preview: URL.createObjectURL(file) })); fileListRef.current = next; setFiles(next); setError('');
  }
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (asset) {
        await api(`assets/${asset.id}`, 'PATCH', { name, part, notes, imageVersion, ...(labelsDirty ? {searchMetadata:{...labels,revision:labelAsset.searchMetadata?.revision,tags:labels.tagsText===undefined ? labels.tags || [] : labels.tagsText.split(/[,，、;；\n]+/).map(t=>t.trim()).filter(Boolean)}} : {}) });
      }
      else {
        if (!files.length) throw new Error('请先选择图片。');
        for (const entry of files) {
          const uploadMode = (canClean({ part }) || ['face', 'scene'].includes(part)) ? mode : 'original';
          const saved=await api('assets', 'POST', { name: name ? `${name}${files.length > 1 ? ` ${files.indexOf(entry) + 1}` : ''}` : entry.file.name.replace(/\.[^.]+$/, ''), part, notes, mode: uploadMode, imageDataUrl: await readImage(entry.file) });
          entry.saved = true;
          if(recognizeUpload) {
            try {await requestAssetLabels(saved.id);}
            catch(error) {throw new Error(`图片已保存，但标签识别失败：${error.message} 可在素材编辑中重试。`);}
          }
        }
      }
      await onSaved(); onClose();
    } catch (err) {
      const remaining = fileListRef.current.filter(f => !f.saved); fileListRef.current.filter(f => f.saved).forEach(f => URL.revokeObjectURL(f.preview)); fileListRef.current = remaining; setFiles(remaining);
      setError(err.message); await onSaved();
    } finally { setBusy(false); }
  }
  return <Modal title={asset ? '编辑素材' : '上传素材'} onClose={busy || labelBusy ? null : onClose}><form onSubmit={e=>{if(labelBusy){e.preventDefault();return;}submit(e);}} className="ws-form">
    {!asset && <><input ref={input} type="file" multiple accept="image/png,image/jpeg,image/webp" hidden onChange={e => choose(e.target.files)}/><button type="button" className={`ws-upload-zone${dragging ? ' dragging' : ''}`} onClick={() => input.current.click()} onDragEnter={e => { e.preventDefault(); setDragging(true); }} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files); }}><UploadSimple size={30}/><strong>{files.length ? `已选择 ${files.length} 张图片 · 点击重新选择` : dragging ? '松开鼠标即可添加图片' : '点击选择、拖入或粘贴图片'}</strong><span>支持批量上传 · PNG / JPG / WebP · 单张不超过 50MB</span></button>{!!files.length && <div className="ws-upload-previews">{files.map(f => <img key={f.preview} src={f.preview} alt={f.file.name}/>)}</div>}</>}
    {asset && <img className="ws-edit-preview" src={imageVersion === 'face' ? asset.faceImage || asset.image : imageVersion === 'scene' ? asset.sceneImage || asset.image : imageVersion === 'fullbody' ? asset.fullBodyImage || asset.image : imageVersion === 'cleaned' ? asset.cleanedImage || asset.image : asset.originalImage || asset.image} alt={asset.name}/>}
    {(asset?.cleanedImage || asset?.faceImage || asset?.sceneImage || (person && asset?.fullBodyImage)) && <label>{material ? '用于设计参考的图片' : '用于搭配的图片'}<select value={imageVersion} onChange={e => setImageVersion(e.target.value)}><option value="original">上传原图</option>{asset.faceImage && <option value="face">生成的正脸参考图</option>}{asset.cleanedImage && <option value="cleaned">{material ? `整理后的${PARTS[part]}图` : accessory ? '生成的配饰图' : '生成的单品图'}</option>}{asset.sceneImage && <option value="scene">生成的纯场景图</option>}{person && asset.fullBodyImage && <option value="fullbody">生成的全身参考照</option>}</select></label>}
    {asset?.modeledImage && <details><summary>查看原有上身效果图</summary><img className="ws-edit-preview" src={asset.modeledImage} alt="原有上身效果图"/></details>}
    <div className="ws-form-row"><label>素材分类<select value={part} onChange={e => { setPart(e.target.value); setMode('original'); }}>{Object.entries(PARTS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>素材名称<input value={name} onChange={e => setName(e.target.value)} placeholder="留空使用文件名" maxLength={160}/></label></div>
    <label>参考说明<textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={1000} placeholder={material ? MATERIAL_GUIDANCE[part].notes : accessory ? '例如：只提取黑色帽子，保留帽檐、刺绣和颜色。' : part === 'pose' ? '例如：侧身行走，右手插袋。只参考姿势，不参考原人物或衣服。' : part === 'face' ? '例如：保留脸型和发型。' : part === 'person' ? '例如：保留头身比例、肩宽和腿长。' : part === 'scene' ? '例如：只参考背景、光线和环境，不参考人物、服装、文字或 logo。' : '例如：保持宽松版型、拉链和印花；照片中仅参考黑色外套。'}/></label>
    {!asset && (canClean({ part }) || ['face', 'scene'].includes(part)) && <fieldset className="ws-mode"><legend>上传方式</legend><label><input type="radio" name="upload-mode" checked={mode === 'original'} onChange={() => setMode('original')}/><span><strong>直接保存图片</strong><small>{material ? '不调用 AI，原图可在设计工作台用作参考。' : '不调用 AI，可直接参与搭配。'}</small></span></label>{canClean({ part }) && <label><input type="radio" name="upload-mode" checked={mode === 'clean'} disabled={!configured} onChange={() => setMode('clean')}/><span><strong>{material ? `AI ${PARTS[part]}整理` : accessory ? 'AI 配饰整理' : '保存并生成单品图'}</strong><small>{material ? MATERIAL_GUIDANCE[part].description : accessory ? '提取指定配饰，移除佩戴者和背景，生成白底配饰图；保留原图，使用图像接口额度。' : '生成白底单品图，保留原图；使用图像接口额度。'}</small></span></label>}{part === 'face' && <label><input type="radio" name="upload-mode" checked={mode === 'face'} disabled={!configured} onChange={() => setMode('face')}/><span><strong>保存并生成正脸参考图</strong><small>优化为正面人脸参考，只保留脸部和发型；保留原图；使用图像接口额度。</small></span></label>}{part === 'scene' && <label><input type="radio" name="upload-mode" checked={mode === 'scene'} disabled={!configured} onChange={() => setMode('scene')}/><span><strong>保存并生成纯场景图</strong><small>仅移除人物、服装和人物阴影，保持原图比例与色彩；保留原图。</small></span></label>}</fieldset>}
    {asset && <AssetLabelFields asset={labelAsset} value={labels} visionConfigured={visionConfigured} disabled={busy} sourceChanged={part!==asset.part || (imageVersion==='original'?asset.originalImage || asset.image:imageVersion==='cleaned'?asset.cleanedImage || asset.image:imageVersion==='scene'?asset.sceneImage || asset.image:imageVersion==='face'?asset.faceImage || asset.image:asset.fullBodyImage || asset.image)!==asset.image} onBusy={setLabelBusy} onChange={next=>{setLabels(next);setLabelsDirty(true);}} onRecognized={async next=>{setLabelAsset(next);setLabels(currentSearchMetadata(next));setLabelsDirty(false);await onSaved();}}/>}
    {!asset && <label className="ws-label-opt-in"><input type="checkbox" checked={recognizeUpload} disabled={!visionConfigured || busy} onChange={e=>setRecognizeUpload(e.target.checked)}/><span>入库后识别检索标签<small>可选；发送图片查看副本，使用现有 AI 识别接口额度。</small></span></label>}
    {material && <p className="ws-note">{PARTS[part]}可在「设计工作台」从素材库选入，作为材质或细节参考。</p>}
    {part === 'pose' && <p className="ws-note">姿势图片直接保存，只作为动作参考。</p>}
    {part === 'scene' && asset && <p className="ws-note">场景素材只提供背景、光线和环境，不会作为人物或服装来源。</p>}
    {error && <p className="ws-error" role="alert">{error}</p>}<footer><button type="button" className="ws-button" disabled={busy || labelBusy} onClick={onClose}>取消</button><button className="ws-button primary" disabled={busy || labelBusy || (!asset && !files.length) || (mode !== 'original' && !configured)}>{busy ? '正在保存…' : mode === 'clean' && canClean({ part }) ? material ? `保存并整理${PARTS[part]}` : accessory ? '保存并整理配饰' : '保存并生成' : mode === 'scene' && part === 'scene' ? '保存并生成纯场景图' : mode === 'face' && part === 'face' ? '保存并生成正脸参考' : asset ? '保存修改' : '直接入库'}</button></footer>
  </form></Modal>;
}

function HistoryPanel({ jobs, activeJobs, queue, assets, busy, reuseBusy, onResult, onAction, onReuse }) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all');
  const running = queue?.running ?? activeJobs.filter(job => job.status === 'processing').length;
  const waiting = queue?.queued ?? activeJobs.filter(job => job.status === 'queued').length;
  const concurrency = queue?.concurrency ?? 2;
  const visible = jobs.filter(job => {
    if (!`${job.name || ''} ${(job.references || []).map(asset => asset.name).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (filter === 'archived') return job.archived;
    if (job.archived) return false;
    if (filter === 'all') return true;
    if (filter === 'active') return ['queued', 'processing'].includes(job.status);
    if (filter === 'uncertain') return job.resultUncertain;
    return job.status === filter && !job.resultUncertain;
  });
  return <section className="ws-history">
    <div className="ws-history-tools"><label><span className="sr-only">搜索生成记录</span><input aria-label="搜索生成记录" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索搭配或素材名称…"/></label><label><span className="sr-only">筛选生成记录</span><select aria-label="筛选生成记录" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部记录</option><option value="active">生成中 / 排队中</option><option value="complete">已完成</option><option value="failed">失败</option><option value="uncertain">结果待确认</option><option value="cancelled">已取消</option><option value="archived">已归档</option></select></label></div>
    <div className="ws-section-meta"><span>生成记录 <b>{visible.length} / {jobs.length}</b></span><small aria-live="polite">正在生成 {running} / {concurrency} · 排队 {waiting} 个</small></div>
    {!visible.length ? <div className="ws-empty"><Sparkle size={40}/><h3>{jobs.length ? '没有找到匹配记录' : '第一套搭配，等你来创作'}</h3><p>{jobs.length ? '试试其他关键词或状态。' : '生成后可在这里对比、下载和复用。'}</p></div> : <div className="ws-history-grid">{visible.map(job => <article className="ws-job" key={job.id}>
      {job.image ? <button className="ws-job-preview" onClick={() => onResult(job)}><img src={thumb(job.image)} alt={job.name}/>{(job.images?.length || 1) > 1 && <span className="ws-result-count">{job.images.length} 张</span>}</button> : <div className={`ws-job-placeholder ${job.resultUncertain ? 'uncertain' : job.status}`}><Sparkle size={38}/><strong>{jobStateLabel(job)}</strong><p>{jobProgressText(job)}</p></div>}
      <div className="ws-job-info"><div><span className={`ws-status ${job.resultUncertain ? 'uncertain' : job.status}`}>{jobStateLabel(job)}</span><small>{jobKindLabel(job)}</small></div><h3>{job.name}</h3><p>{new Date(job.createdAt).toLocaleString('zh-CN')}</p><JobDimensions job={job}/><div className="ws-reference-strip">{(job.references || []).map(asset => <img key={asset.id} src={thumb(asset.image)} alt={asset.name} title={`${PARTS[asset.part]} · ${asset.name}`}/>)}</div>
        <div className="ws-job-actions">{job.image && <a className="ws-button" href={job.image} download={`${job.name}.${job.outputFormat || 'png'}`}><DownloadSimple/>{job.images?.length > 1 ? '下载首张' : '下载'}</a>}{job.kind === 'outfit' && <button className="ws-button" onClick={() => onReuse(job)}><ArrowCounterClockwise/>复用搭配</button>}{job.kind === 'design' && <button className="ws-button" disabled={reuseBusy} onClick={()=>onReuse(job)} title="恢复参考原图、标注和设计设置，修改后再生成"><ArrowCounterClockwise/>复用设计</button>}{job.status === 'queued' && <button className="ws-button warning" disabled={busy} onClick={() => onAction(`jobs/${job.id}/cancel`, 'POST', undefined, '已取消未开始的任务。')}><StopCircle/>取消排队</button>}{job.status === 'failed' && job.kind !== 'fullbody' && <button className="ws-button" disabled={busy} onClick={() => { const warning = job.resultUncertain ? '这次请求可能已经扣费。请先确认服务商后台没有可下载的结果，再重新生成。是否继续？' : '重试会再次调用图像接口并可能产生费用。是否继续？'; if (window.confirm(warning)) onAction(`jobs/${job.id}/retry`, 'POST', undefined, '任务已重新加入队列。'); }}>{job.resultUncertain ? '确认后重试' : '重试'}</button>}{job.status === 'failed' && job.failureKind === 'input_too_large' && <button className="ws-button" disabled={busy} onClick={() => onAction(`jobs/${job.id}/retry`, 'POST', { compressInput: true }, '已使用压缩副本重新加入队列，素材原图保留。')}>压缩后重试</button>}{!['queued', 'processing'].includes(job.status) && <button className="ws-button" disabled={busy} onClick={() => onAction(`jobs/${job.id}/archive`, 'PATCH', { archived: !job.archived }, job.archived ? '记录已恢复。' : '记录已归档。')}><Archive/>{job.archived ? '恢复' : '归档'}</button>}{!['queued', 'processing'].includes(job.status) && <button className="ws-button danger" disabled={busy} onClick={() => window.confirm('永久删除这条生成记录？已被素材使用的图片会保留。') && onAction(`jobs/${job.id}`, 'DELETE', undefined, '记录已删除。')}><TrashSimple/>删除</button>}</div>
        {job.vectorImages?.length > 0 && <div className="ws-job-actions">{job.vectorImages.map((url, index) => <a key={url} className="ws-button" href={url} download={`${job.name}-${index + 1}.svg`}><DownloadSimple/>下载原始 SVG{job.vectorImages.length > 1 ? ` ${index + 1}` : ''}</a>)}</div>}
      </div></article>)}</div>}
  </section>;
}

export function Studio() {
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('view') === 'settings' ? 'settings' : 'library'), [category, setCategory] = useState('all'), [search, setSearch] = useState('');
  const [settingsTarget, setSettingsTarget] = useState(() => { const section = new URLSearchParams(window.location.search).get('section'); return ['system', 'analysis', 'design-generation', 'quiver', 'typesafe'].includes(section) ? section : null; });
  const [state, setState] = useState({ assets: [], jobs: [], configured: false });
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [modal, setModal] = useState(null), [selected, setSelected] = useState([]), [form, setForm] = useState(initialForm), [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null), [archive, setArchive] = useState(null);
  const [designReuse, setDesignReuse] = useState(null);
  const [searchComposing,setSearchComposing]=useState(false), [labelBatch,setLabelBatch]=useState(null);
  const requestNumber = useRef(0);
  const mainRef = useRef(null);
  const activeJobsRef = useRef(false);
  const pollTimerRef = useRef(null);
  useLayoutEffect(() => {
    // Reset after the new page is laid out, never on background job polling.
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [tab]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function refresh() {
    const version = ++requestNumber.current;
    try {
      const data = await api('state');
      if (version === requestNumber.current) {
        activeJobsRef.current = data.jobs?.some(j => ['queued', 'processing'].includes(j.status)) || false;
        setState(data); setError('');
      }
    }
    catch (e) { if (version === requestNumber.current) setError(e.message); }
    finally {
      if (version === requestNumber.current) { setLoading(false); schedulePoll(); }
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => { refresh(); }, activeJobsRef.current ? 4000 : 30000);
  }
  useEffect(() => { refresh(); return () => { clearTimeout(pollTimerRef.current); requestNumber.current++; }; }, []);
  const assets = state.assets;
  const picked = selected.map(id => assets.find(a => a.id === id)).filter(a => a && !isMaterial(a));
  const visibleParts = Object.entries(PARTS).filter(([part]) => tab !== 'compose' || !isMaterial({ part }));
  const smartResult=useAssetSearch({query:search,assets,category,tab,configured:state.search?.typesafeConfigured===true,composing:searchComposing});
  const list=smartResult.list;
  const missingLabels=smartResult.base.filter(needsSearchLabels).length;
  const activeJobs = state.jobs.filter(j => ['queued', 'processing'].includes(j.status));
  const jobs = state.jobs;
  function changeTab(nextTab) {
    if (nextTab === 'compose' && isMaterial({ part: category })) setCategory('all');
    setTab(nextTab);
  }
  const choose = asset => {
    if (isMaterial(asset)) return;
    if (selected.includes(asset.id)) { setSelected(v => v.filter(id => id !== asset.id)); return; }
    const next = picked.filter(a => asset.part === 'accessories_up' || a.part !== asset.part);
    if (next.length >= 10) { setNotice('每套最多选择 10 个素材，请先移除一个。'); return; }
    setSelected([...next.map(a => a.id), asset.id]);
  };
  async function generate() {
    setBusy(true); setError('');
    try { await api('outfits', 'POST', { ...form, assetIds: picked.map(a => a.id) }); await refresh(); setNotice(`${form.count || 1} 张搭配图已加入队列，可继续在当前工作台编辑；完成后可在生成记录中查看和下载。`); }
    catch (e) { setNotice(e.message); } finally { setBusy(false); }
  }
  async function action(url, method = 'POST', data, success = '任务已加入队列。') { setBusy(true); try { await api(url, method, data); await refresh(); setNotice(success); } catch (e) { setNotice(e.message); } finally { setBusy(false); } }
  async function faceAction(asset) {
    setBusy(true); setNotice('正在提交正脸参考图…');
    try { await api(`assets/${asset.id}/face`, 'POST'); await refresh(); setNotice('正脸参考图已加入生成队列，可继续在当前工作台操作；进度和结果可在「生成记录」中查看。'); }
    catch (e) { setNotice(`正脸参考图提交失败：${e.message}`); }
    finally { setBusy(false); }
  }
  function reuse(job) {
    if (job.kind === 'design') {
      if (designReuse) return;
      setDesignReuse({requestId:crypto.randomUUID(),jobId:job.id,designMode:job.designMode});setTab('design');return;
    }
    const ids = (job.references || []).filter(a => assets.some(b => b.id === a.id && !isMaterial(b))).map(a => a.id);
    const output = resolveOutputSettings(job); setSelected(ids);
    setForm({ name: job.name, scene: job.scene, direction: job.direction, aspectRatio: output.aspectRatio, resolution: output.resolution, quality: job.quality || 'auto', count: job.count || 1, outputFormat: job.outputFormat || 'png', moderation: job.moderation || 'auto', poseText: job.poseText || initialForm.poseText });
    changeTab('compose'); if (ids.length !== (job.references || []).length) setNotice('部分素材已移除或无法用于搭配，请补选后生成。');
  }
  const counts = part => assets.filter(a => a.part === part).length;
  const uploadCategory = category === 'all' ? 'upperbody' : category;
  const canGenerate = state.configured && picked.some(a => ['upperbody', 'wholebody_up', 'lowerbody', 'dress'].includes(a.part));
  const completed = jobs.filter(j => j.kind === 'outfit' && j.status === 'complete').length;
  return <div className="ws-app">
    <aside className="ws-sidebar"><a className="ws-brand" href="#" onClick={e => { e.preventDefault(); setTab('library'); }}><span className="ws-brand-icon"><TShirt size={24}/></span><span>FPA<small>你的设计搭子</small></span></a>
      <p className="ws-nav-label">工作空间</p><nav>{TABS.map(([id, label, Icon]) => <button key={id} onClick={() => { setSettingsTarget(null); changeTab(id); }} className={tab === id ? 'active' : ''}><Icon size={21}/>{label}{id === 'history' && !!activeJobs.length && <b>{activeJobs.length}</b>}</button>)}</nav>
      <div className="ws-sidebar-bottom"><span className={`ws-dot ${state.configured ? 'ready' : ''}`}/>{state.configured ? '图像接口已配置' : '图像接口未配置'}<p>素材保存在本机<br/>点击生成时才调用图像接口</p></div>
    </aside>
    <main ref={mainRef} className={`ws-main${tab === 'compose' ? ' is-composing' : tab === 'design' ? ' is-designing' : ''}`}>
      <header className="ws-topbar"><span>FPA <span className="ws-divider">/</span> {TABS.find(t => t[0] === tab)[1]}{!['settings', 'design'].includes(tab) && <small className="ws-topbar-count"> · {tab === 'history' ? `${completed} 张搭配图` : `${assets.length} 个素材`}</small>}</span>{['library', 'compose'].includes(tab) && <button className="ws-button primary" onClick={() => setModal({ category: category === 'all' ? 'upperbody' : category })}><Plus size={18}/>上传素材</button>}</header>
      {error && <div className="ws-error" role="alert">{error}<button className="ws-link" onClick={refresh}>重新加载</button></div>}
      {notice && <div className="ws-notice" role="status">{notice}<button className="ws-icon" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16}/></button></div>}
      {['library', 'compose'].includes(tab) ? <>
        <div className="ws-quick-links">{visibleParts.map(([id, label]) => <button className={category === id ? 'active' : ''} key={id} onClick={() => setCategory(id)}>{['upperbody', 'wholebody_up', 'lowerbody', 'dress', 'shoes'].includes(id) ? <TShirt size={22}/> : id === 'face' || id === 'person' ? <User size={22}/> : id === 'pose' ? <PersonSimple size={22}/> : id === 'scene' || id === 'fabric' ? <SquaresFour size={22}/> : <Sparkle size={22}/>}<span>{label}<small>{`${counts(id)} 个素材`}</small></span><ArrowRight size={16}/></button>)}</div>
        <div className={`ws-workspace ${tab === 'compose' ? 'composing' : ''}`}><section className="ws-library"><div className="ws-filters"><nav aria-label="素材分类">{[['all', '全部'], ...visibleParts].map(([id, label]) => <button key={id} className={category === id ? 'active' : ''} onClick={() => setCategory(id)}>{label}</button>)}</nav><div className="ws-smart-search"><input aria-label="搜索素材" onCompositionStart={()=>setSearchComposing(true)} onCompositionEnd={()=>setSearchComposing(false)} value={search} onChange={e => setSearch(e.target.value)} placeholder="描述你要找的素材，例如：黑色防水夹克…"/><Sparkle size={15} aria-hidden="true"/></div></div>
          <div className="ws-label-toolbar"><span role="status">{search ? smartResult.message : '检索标签'}{missingLabels>0 ? ` · ${missingLabels} 个素材待补标签` : ' · 标签已就绪'}</span><button className="ws-button" disabled={!missingLabels || !state.search?.visionConfigured} onClick={()=>setLabelBatch(smartResult.base)} title="逐张识别当前分类缺失的标签，会使用视觉 API 额度"><Sparkle size={14}/>补识别标签</button></div>
          <div className="ws-section-meta"><span>{category === 'all' ? '全部素材' : PARTS[category]} <b>{list.length}</b></span><small>{tab === 'compose' ? '点击卡片选择，同类服装自动替换' : isMaterial({ part: category }) ? '原图和整理图均可用于设计参考' : '原图可直接用于搭配或设计参考'}</small></div>
          {loading ? <div className="ws-empty">正在加载素材…</div> : !list.length ? <div className="ws-empty"><SquaresFour size={40}/><h3>{search ? '没有找到匹配素材' : '从一张图片开始'}</h3><p>{search ? '试试其他名称，或切换分类。' : isMaterial({ part: category }) ? `上传${PARTS[category]}图片，收藏原图或使用 AI 整理。` : '上传款式图、人物照或姿势参考，建立你的素材库。'}</p><button className="ws-button" onClick={() => setModal({ category: uploadCategory })}><Plus/>上传素材</button></div> : <div className="ws-grid">{list.map(asset => {
            const material = isMaterial(asset);
            const chosen = !material && selected.includes(asset.id);
            return <article className={`ws-asset ${chosen ? 'selected' : ''}`} key={asset.id}>
              <button className="ws-asset-image" aria-label={`${tab === 'compose' ? '选择' : '查看'}${asset.name}`} aria-pressed={tab === 'compose' ? chosen : undefined} onClick={() => tab === 'compose' ? choose(asset) : setModal({ asset })}><img loading="lazy" src={thumb(asset.image)} alt={asset.name}/><span className="ws-asset-badge">{PARTS[asset.part] || '服装'}</span>{chosen && <span className="ws-selected-mark"><Check weight="bold"/></span>}</button>
              <div className="ws-asset-info"><h3 title={asset.name}>{asset.name}</h3><p>{asset.faceImage && asset.image === asset.faceImage ? '正脸参考图' : asset.sceneImage && asset.image === asset.sceneImage ? '已生成纯场景图' : asset.fullBodyImage && asset.image === asset.fullBodyImage ? '全身参考照' : asset.cleanedImage && asset.image === asset.cleanedImage ? material ? `已整理${PARTS[asset.part]}` : isAccessory(asset) ? '已整理配饰' : '已生成单品图' : material ? `${PARTS[asset.part]}原图` : asset.origin === 'legacy' ? '已有衣橱素材' : '原图素材'}</p>
                {currentSearchMetadata(asset).tags?.length>0 && <div className="ws-asset-tags">{currentSearchMetadata(asset).tags.slice(0,3).map(tag=><span key={tag}>{tag}</span>)}</div>}
                <div className="ws-asset-actions">
                  <button aria-label={`编辑${asset.name}`} onClick={() => setModal({ asset })}><PencilSimple/>编辑</button>
                  {tab === 'library' && !material && <button onClick={() => { choose(asset); changeTab('compose'); }}><Plus/>搭配</button>}
                  {canClean(asset) && <button disabled={busy || !state.configured || jobs.some(j => j.assetId === asset.id && ['queued', 'processing'].includes(j.status))} onClick={() => action(`assets/${asset.id}/clean`)} title={material ? MATERIAL_GUIDANCE[asset.part].description : isAccessory(asset) ? '提取指定配饰并生成白底图，保留原图，会使用接口额度' : '生成白底单品图，会使用接口额度'}><Sparkle/>{material ? 'AI 整理' : isAccessory(asset) ? '配饰整理' : '整理'}</button>}
                  {asset.part === 'scene' && <button disabled={busy || !state.configured || jobs.some(j => j.assetId === asset.id && j.kind === 'scene' && ['queued', 'processing'].includes(j.status))} onClick={() => action(`assets/${asset.id}/scene`)} title="移除人物并生成纯场景图，会使用接口额度"><Sparkle/>场景</button>}
                  {asset.part === 'face' && <button data-testid="face-reference-button" disabled={busy || !state.configured || jobs.some(j => j.assetId === asset.id && j.kind === 'face' && ['queued', 'processing'].includes(j.status))} onClick={event => { event.stopPropagation(); faceAction(asset); }} title="生成正脸参考图，会使用接口额度"><Sparkle/>正脸</button>}
                  <button aria-label={`移除${asset.name}`} onClick={() => setArchive(asset)}><Archive/></button>
                </div>
              </div>
            </article>;
          })}</div>}
        </section>{tab === 'compose' && <aside className="ws-composer" aria-label="当前搭配">
          <div className="ws-composer-title"><h2>当前搭配</h2><div className="ws-composer-title-actions"><span>{picked.length} / 10</span><button type="button" className="ws-clear-picked" disabled={!picked.length} title="清空本次搭配选择" onClick={() => setSelected([])}>一键清除</button></div></div>
          <div className="ws-composer-scroll" role="region" aria-label="搭配素材和出图设置" tabIndex={0}>
            <p className="ws-note">人脸、体型和姿势各选一个；配饰可多选。未选择人物时生成虚构成年模特。</p>
            <div className="ws-selected-list">{picked.length ? picked.map(a => <div key={a.id}><img src={thumb(a.image)} alt=""/><span><small>{PARTS[a.part]}</small><strong>{a.name}</strong></span><button className="ws-icon" aria-label={`取消选择${a.name}`} onClick={() => choose(a)}><X/></button></div>) : <div className="ws-selected-empty"><Plus size={26}/><p>从左侧选入素材</p></div>}</div>
            <div className="ws-form">
              <label>搭配名称<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例如：初秋城市通勤" maxLength={160}/></label>
              <label>人物姿势<select disabled={picked.some(a => a.part === 'pose')} value={form.poseText} onChange={e => setForm({ ...form, poseText: e.target.value })}><option>正面自然站立，双臂放松，完整展示服装</option><option>自然行走，身体略微侧转，展示全身</option><option>坐在简洁凳子上，双腿自然放置</option><option>侧身站立，轻微回头，双手放松</option></select>{picked.some(a => a.part === 'pose') && <small>使用已选姿势图片。</small>}</label>
              {picked.some(a => a.part === 'scene') ? <div className="ws-reference-lock"><strong>场景参考图已启用</strong><small>生成时只参考这张图的背景、光线和环境；下方文字背景不会参与生成。</small></div> : <label>背景与光线<textarea rows={2} value={form.scene} maxLength={1000} onChange={e => setForm({ ...form, scene: e.target.value })}/></label>}
              <label>补充要求<textarea rows={2} placeholder="例如：外套敞开，保留裤长与印花，包不遮挡衣服" value={form.direction} maxLength={1500} onChange={e => setForm({ ...form, direction: e.target.value })}/></label>
              <OutputSettings value={form} onChange={setForm}/>
            </div>
          </div>
          <div className="ws-composer-actions">
            <p className="ws-note">生成会发送所选图片并使用接口额度，张数越多费用通常越高。</p>
            <button className="ws-button primary ws-generate" disabled={busy || !canGenerate} aria-disabled={!canGenerate} onClick={generate}><Sparkle size={20}/>{busy ? '正在提交…' : `生成 ${form.count || 1} 张搭配图`}</button>
            {!state.configured ? <small className="ws-error">请先在「系统设置」配置图像接口密钥。</small> : !picked.length ? <small className="ws-compose-hint">请先从左侧选择服装分类中的素材。</small> : !canGenerate ? <small className="ws-compose-hint">至少选择一件上衣、外套、下装或内搭。</small> : null}
          </div>
        </aside>}</div>
      </> : tab === 'history'
        ? <HistoryPanel jobs={jobs} activeJobs={activeJobs} queue={state.queue} assets={assets} busy={busy} reuseBusy={Boolean(designReuse)} onResult={setResult} onAction={action} onReuse={reuse}/>
        : tab === 'settings' ? <SettingsPanel settings={state.settings} onSaved={refresh} focusTarget={settingsTarget}/> : null}
      <DesignWorkbench active={tab === 'design'} reuseRequest={designReuse} onReused={message=>{setDesignReuse(current=>current?.requestId===message.requestId?null:current);setNotice(message.message);}} onHistory={() => setTab('history')} onSettings={section => { setSettingsTarget(['system', 'design-generation', 'quiver', 'typesafe'].includes(section) ? section : 'analysis'); setTab('settings'); }} onSubmitted={refresh}/>
      <footer className="ws-page-footer">FPA · 从素材到造型，让每一次搭配都有依据。</footer>
    </main>
    {modal && <AssetForm {...modal} configured={state.configured} visionConfigured={state.search?.visionConfigured} onClose={() => setModal(null)} onSaved={refresh}/>}
    {labelBatch && <Modal title="补识别检索标签" onClose={()=>setLabelBatch(null)}><LabelBatch assets={labelBatch} visionConfigured={state.search?.visionConfigured} onRefresh={refresh} onClose={()=>setLabelBatch(null)}/></Modal>}
    {archive && <Modal title="移除素材" onClose={() => setArchive(null)}><div className="ws-form"><p>将「{archive.name}」移出素材库？原图片及历史搭配记录仍会保留。</p><footer><button className="ws-button" onClick={() => setArchive(null)}>取消</button><button className="ws-button primary" disabled={busy} onClick={async () => { setBusy(true); try { await api(`assets/${archive.id}`, 'DELETE'); setSelected(v => v.filter(id => id !== archive.id)); setArchive(null); await refresh(); } catch (e) { setNotice(e.message); } finally { setBusy(false); } }}>确认移除</button></footer></div></Modal>}
    {result && <Modal className="ws-comparison-modal" title={result.name} onClose={() => setResult(null)}><ComparisonViewer key={result.id} job={result} categories={REFERENCE_LABELS}/></Modal>}
  </div>;
}
