import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowClockwise, FloppyDisk } from '@phosphor-icons/react';

const ANALYSIS_SETTINGS = {
  endpoint: '/api/studio/design/settings',
  title: 'AI 识别接口',
  description: '用于设计工作台的整图与局部识别，以及素材库检索标签识别。共用现有配置。',
  statusLabel: '识别接口',
  settingsLabel: '识别设置',
  savedLabel: 'AI 识别设置',
  modelLabel: '识别模型',
  modelPlaceholder: '填写支持看图的模型名称',
  baseUrlPlaceholder: 'https://api.openai.com/v1',
  keyPlaceholder: '输入识别接口密钥',
};
const DESIGN_GENERATION_SETTINGS = {
  endpoint: '/api/studio/design/generation-settings',
  title: '设计出图接口',
  description: '用于设计工作台的最终出图。',
  statusLabel: '设计出图接口',
  settingsLabel: '设计出图设置',
  savedLabel: '设计出图设置',
  modelLabel: '出图模型',
  modelPlaceholder: '填写出图模型名称',
  baseUrlPlaceholder: 'https://generativelanguage.googleapis.com',
  keyPlaceholder: '输入设计出图接口密钥',
  protocolOptions: true,
};
const QUIVER_SETTINGS = {
  endpoint: '/api/studio/design/quiver-settings', title: 'Quiver 矢量线稿接口',
  description: '用于转为线稿时选择矢量线稿，生成可下载的 SVG，并载入画板预览。Quiver 单次最长等待 10 分钟。',
  statusLabel: 'Quiver 接口', settingsLabel: 'Quiver 设置', savedLabel: 'Quiver 设置',
  modelLabel: '默认模型', baseUrlPlaceholder: 'https://api.quiver.ai/v1', keyPlaceholder: '输入 Quiver API 密钥',
  modelOptions: [['arrow-2', 'Arrow 2'], ['arrow-2-telos', 'Arrow 2 Telos']],
  effortOptions: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']],
};
const TYPESAFE_SETTINGS = {
  endpoint: '/api/studio/typesafe-settings', title: '素材库智能检索接口',
  description: '根据已保存的检索标签逐项判断并过滤。输入停顿后调用，可能产生 TypeSafe 费用；只发送文字，不上传图片。未配置时使用本地标签检索。',
  statusLabel: 'TypeSafe 检索接口', settingsLabel: 'TypeSafe 检索设置', savedLabel: 'TypeSafe 检索设置',
  modelLabel: '语义模型', modelPlaceholder: 'jev-latest', baseUrlPlaceholder: 'https://api.typesafe.ai/v1/systemone', keyPlaceholder: '输入 TypeSafe API 密钥',
};
const publicSettings = value => ({
  baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
  model: typeof value.model === 'string' ? value.model : '',
  reasoningEffort: value.reasoningEffort || 'high',
  configured: value.configured === true,
  maskedKey: typeof value.maskedKey === 'string' ? value.maskedKey : '',
  imported: value.imported === true,
  protocol: value.protocol === 'openai' ? 'openai' : 'gemini',
});

async function readResponse(response) {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `请求失败（HTTP ${response.status}），请重试。`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无法读取接口设置，请重试。');
  return publicSettings(value);
}

function IndependentApiSettingsCard({ configuration, focusRequested = false }) {
  const id = useId();
  const cardRef = useRef(null), headingRef = useRef(null);
  const mountedRef = useRef(false), operationRef = useRef(null);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', protocol: 'gemini' });
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');

  const loadSettings = useCallback(async () => {
    if (operationRef.current) return;
    const operation = { controller: new AbortController() };
    operationRef.current = operation;
    const current = () => mountedRef.current && operationRef.current === operation;
    setLoading(true); setError('');
    try {
      const value = await readResponse(await fetch(configuration.endpoint, { signal: operation.controller.signal }));
      if (!current()) return;
      setSettings(value);
      setForm({ ...value, apiKey: '' });
    } catch (err) {
      if (current() && !operation.controller.signal.aborted) setError(`读取${configuration.settingsLabel}失败：${err.message}`);
    } finally {
      if (current()) { operationRef.current = null; setLoading(false); }
    }
  }, [configuration]);

  useEffect(() => {
    mountedRef.current = true;
    loadSettings();
    return () => {
      mountedRef.current = false;
      operationRef.current?.controller.abort();
      operationRef.current = null;
    };
  }, [loadSettings]);

  useEffect(() => {
    if (!focusRequested) return undefined;
    const frame = window.requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequested]);

  async function save(event) {
    event.preventDefault();
    if (operationRef.current || !settings) return;
    const operation = { controller: new AbortController() };
    operationRef.current = operation;
    const current = () => mountedRef.current && operationRef.current === operation;
    const body = { baseUrl: form.baseUrl.trim(), model: form.model.trim() };
    if (configuration.protocolOptions) body.protocol = form.protocol;
    if (configuration.effortOptions) body.reasoningEffort = form.reasoningEffort;
    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
    setSaving(true); setError(''); setMessage('');
    try {
      const value = await readResponse(await fetch(configuration.endpoint, {
        method: 'PATCH', signal: operation.controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
      if (!current()) return;
      setSettings(value);
      setForm({ ...value, apiKey: '' });
      setMessage(value.configured ? `${configuration.savedLabel}已保存。` : `${configuration.savedLabel}已保存，请补充密钥后使用。`);
    } catch (err) {
      if (current() && !operation.controller.signal.aborted) setError(`保存${configuration.settingsLabel}失败：${err.message} 输入内容已保留，可重试保存。`);
    } finally {
      if (current()) { operationRef.current = null; setSaving(false); }
    }
  }

  const disabled = loading || saving || !settings;
  const update = (field, value) => {
    setForm(current => ({ ...current, [field]: value }));
    setMessage('');
  };
  return <section ref={cardRef} className="ws-settings-card" aria-labelledby={`${id}-title`} aria-busy={loading || saving}>
    <h2 ref={headingRef} id={`${id}-title`} tabIndex={-1}>{configuration.title}</h2>
    <p>{configuration.description}</p>
    <div className="ws-settings-heading">
      <span className={`ws-settings-status ${settings?.configured ? 'ready' : ''}`}><span/>{loading ? '正在读取配置…' : !settings ? '配置未加载' : `${configuration.statusLabel}${settings.configured ? '已配置' : '未配置'}`}</span>
      {settings && <small>{settings.maskedKey || '密钥只保存在本机'}{settings.imported ? ' · 已导入本地配置' : ''}</small>}
    </div>
    <form onSubmit={save}>
      <div className="ws-settings-grid">
        {configuration.protocolOptions && <label className="wide" htmlFor={`${id}-protocol`}>接口类型<select id={`${id}-protocol`} value={form.protocol} onChange={event => update('protocol', event.target.value)} disabled={disabled}><option value="gemini">Gemini 原生接口（原设计工作台）</option><option value="openai">OpenAI 兼容图像接口</option></select></label>}
        <label className="wide" htmlFor={`${id}-base-url`}>接口地址<input id={`${id}-base-url`} value={form.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder={configuration.baseUrlPlaceholder} disabled={disabled} autoComplete="off" required/></label>
        <label className="wide" htmlFor={`${id}-model`}>{configuration.modelLabel}{configuration.modelOptions ? <select id={`${id}-model`} value={form.model} onChange={event => update('model', event.target.value)} disabled={disabled}>{configuration.modelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <input id={`${id}-model`} value={form.model} onChange={event => update('model', event.target.value)} placeholder={configuration.modelPlaceholder} disabled={disabled} autoComplete="off" required/>}</label>
        {configuration.effortOptions && <label className="wide" htmlFor={`${id}-effort`}>默认推理强度<select id={`${id}-effort`} value={form.reasoningEffort || 'high'} onChange={event => update('reasoningEffort', event.target.value)} disabled={disabled}>{configuration.effortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <label className="wide" htmlFor={`${id}-key`}>API 密钥<input id={`${id}-key`} type="password" value={form.apiKey} onChange={event => update('apiKey', event.target.value)} placeholder={settings?.maskedKey ? '留空保留现有密钥' : configuration.keyPlaceholder} disabled={disabled} autoComplete="new-password"/></label>
      </div>
      <p className="ws-settings-help">密钥留空会保留现有密钥。保存设置不会调用 AI。{configuration.protocolOptions && '模型名称按填写值发送，请选择服务商支持的接口类型。设计出图与搭配共用最长等待时间和任务队列。'}</p>
      {message && <p className="ws-settings-message" role="status">{message}</p>}
      {error && <p className="ws-error" role="alert">{error}</p>}
      <footer>
        {!settings && !loading ? <button className="ws-button" type="button" onClick={loadSettings}><ArrowClockwise size={18}/>重新加载</button> : <button className="ws-button primary" type="submit" disabled={disabled}><FloppyDisk size={18}/>{saving ? '正在保存…' : `保存${configuration.settingsLabel}`}</button>}
      </footer>
    </form>
  </section>;
}

export function AnalysisSettingsCard({ focusRequested = false }) {
  return <IndependentApiSettingsCard configuration={ANALYSIS_SETTINGS} focusRequested={focusRequested}/>;
}

export function DesignGenerationSettingsCard({ focusRequested = false }) {
  return <IndependentApiSettingsCard configuration={DESIGN_GENERATION_SETTINGS} focusRequested={focusRequested}/>;
}

export function QuiverSettingsCard({ focusRequested = false }) {
  return <IndependentApiSettingsCard configuration={QUIVER_SETTINGS} focusRequested={focusRequested}/>;
}

export function TypeSafeSettingsCard({ focusRequested = false }) {
  return <IndependentApiSettingsCard configuration={TYPESAFE_SETTINGS} focusRequested={focusRequested}/>;
}
