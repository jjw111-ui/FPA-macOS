import { useEffect, useRef, useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import { currentSearchMetadata, needsSearchLabels } from './asset-search.mjs';

export async function requestAssetLabels(id, force = false) {
  const response=await fetch(`/api/studio/assets/${encodeURIComponent(id)}/search-labels`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({force})});
  const value=await response.json();
  if (!response.ok) throw new Error(value.error || '识别失败，请稍后重试。');
  return value;
}

export function AssetLabelFields({asset,value,onChange,onRecognized,visionConfigured,disabled,sourceChanged,onBusy}) {
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const pending=useRef(false);
  async function recognize() {
    if(pending.current) return;
    pending.current=true; setBusy(true); onBusy(true); setError('');
    try { const result=await requestAssetLabels(asset.id,Boolean(value.updatedAt)); await onRecognized(result.asset); }
    catch(error) {setError(error.message);}
    finally {pending.current=false;setBusy(false);onBusy(false);}
  }
  return <fieldset className="ws-search-labels" disabled={disabled || busy}>
    <legend>检索标签</legend>
    <div className="ws-label-heading"><small>{value.updatedAt ? value.source==='manual' ? '已手动编辑' : 'AI 已识别 · 可修改' : '尚未建立标签'}</small>
      <button type="button" className="ws-button" disabled={!visionConfigured || sourceChanged || disabled || busy} onClick={recognize}><Sparkle size={15}/>{busy?'正在识别…':value.updatedAt?'重新识别并替换标签':'AI 识别标签'}</button></div>
    <small>{sourceChanged?'图片版本或分类已修改，请先保存后再识别。':!visionConfigured?'请先在系统设置配置 AI 识别接口。':'点击识别会发送图片查看副本并使用视觉 API 额度，原图不变。识别成功后自动保存；手动修改需点击保存修改。'}</small>
    <div className="ws-form-row"><label>具体物品<input maxLength={80} value={value.objectType || ''} onChange={e=>onChange({...value,objectType:e.target.value})} placeholder="例如：头盔、背包"/></label><label>颜色<input maxLength={120} value={value.color || ''} onChange={e=>onChange({...value,color:e.target.value})} placeholder="例如：薄荷绿"/></label></div>
    <label>材质 / 纹理<input maxLength={120} value={value.material || ''} onChange={e=>onChange({...value,material:e.target.value})} placeholder="不确定时可留空"/></label>
    <label>标签<textarea rows={2} maxLength={1100} value={value.tagsText ?? (value.tags || []).join('，')} onChange={e=>onChange({...value,tagsText:e.target.value})} placeholder="用逗号分隔，例如：头盔，helmet，通风孔"/></label>
    <label>外观描述<textarea rows={2} maxLength={500} value={value.description || ''} onChange={e=>onChange({...value,description:e.target.value})}/></label>
    {error && <p className="ws-error" role="alert">{error}</p>}
  </fieldset>;
}

export function LabelBatch({assets,visionConfigured,onRefresh,onClose}) {
  const [targets]=useState(()=>assets.filter(needsSearchLabels));
  const [progress,setProgress]=useState({done:0,failed:0,running:false,started:false,current:''});
  const [errors,setErrors]=useState([]);
  const stop=useRef(false), running=useRef(false), mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;stop.current=true;};},[]);
  async function start() {
    if(running.current) return;
    running.current=true;stop.current=false;setProgress(p=>({...p,running:true,started:true}));
    for(const asset of targets) {
      if(stop.current) break;
      if(mounted.current)setProgress(p=>({...p,current:currentSearchMetadata(asset).objectType || asset.name}));
      try { await requestAssetLabels(asset.id); }
      catch(error) { if(mounted.current){setErrors(e=>[...e,{id:asset.id,name:asset.name,error:error.message}]);setProgress(p=>({...p,failed:p.failed+1}));} }
      if(mounted.current){setProgress(p=>({...p,done:p.done+1}));await onRefresh();}
    }
    running.current=false;
    if(mounted.current)setProgress(p=>({...p,running:false,current:''}));
  }
  return <div className="ws-form">
    <p className="ws-note">为当前分类中尚未建立标签的 {targets.length} 个素材逐张识别。会发送图片查看副本并使用已有 AI 识别接口额度；已有或手动修改的标签跳过。成功结果立即保存，不重复识别。</p>
    {progress.started && <><progress aria-label="标签识别进度" value={progress.done} max={targets.length || 1}/><p role="status">已处理 {progress.done} / {targets.length} · 成功 {progress.done-progress.failed} · 失败 {progress.failed}{progress.running?' · 正在识别':''}</p>{progress.current && <small>{progress.current}</small>}</>}
    {!!errors.length && <details><summary>查看未成功的素材（可稍后单独重试）</summary>{errors.map(item=><p className="ws-error" key={item.id}>{item.name}：{item.error}</p>)}</details>}
    {!visionConfigured && <p className="ws-error">请先在系统设置配置 AI 识别接口。</p>}
    <footer>{progress.running?<button className="ws-button" onClick={()=>{stop.current=true;setProgress(p=>({...p,current:'当前一张完成后停止'}));}}>停止后续识别</button>:<><button className="ws-button" onClick={onClose}>关闭</button>{!progress.started && <button className="ws-button primary" disabled={!targets.length || !visionConfigured} onClick={start}>开始识别 {targets.length} 张</button>}</>}</footer>
  </div>;
}
