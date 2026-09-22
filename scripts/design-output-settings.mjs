import { OUTPUT_PRESETS, resolveOutputSettings } from '../src/output-settings.mjs';

const invalid=message=>Object.assign(new Error(message),{status:400});
const geminiRatios=['1:1','4:5','3:4','2:3','9:16','21:9','5:4','4:3','3:2','16:9'];
// Pixel sizes are a history display estimate only. Gemini receives imageSize
// and aspectRatio, never these pixels; save provider output without resizing.
export const GEMINI_DESIGN_PRESETS=geminiRatios.map(ratio=>OUTPUT_PRESETS.find(preset=>preset.ratio===ratio)).map(preset=>({...preset,sizes:{...preset.sizes,'4K':preset.sizes['2K'].split('x').map(edge=>Number(edge)*2).join('x')}}));
export const GEMINI_DESIGN_RESOLUTIONS=['1K','2K','4K'];
const safetyCategories=['HARM_CATEGORY_HARASSMENT','HARM_CATEGORY_HATE_SPEECH','HARM_CATEGORY_SEXUALLY_EXPLICIT','HARM_CATEGORY_DANGEROUS_CONTENT'];
export function resolveDesignOutput(input={},protocol='gemini'){
  if(protocol!=='gemini')return {...resolveOutputSettings(input),nativeSize:false};
  const resolution=input.resolution??'1K';
  if(!GEMINI_DESIGN_RESOLUTIONS.includes(resolution))throw invalid('设计分辨率请选择 1K、2K 或 4K。');
  const base=resolveOutputSettings({...input,size:undefined,resolution:resolution==='4K'?'2K':resolution});
  const preset=GEMINI_DESIGN_PRESETS.find(item=>item.ratio===base.aspectRatio);
  if(!preset)throw invalid('请选择 Gemini 支持的画面比例。');
  return {...base,resolution,size:preset.sizes[resolution],nativeSize:true};
}
export function normalizeDesignNativeOptions(input={},protocol='gemini'){
  const safetyPreset=input.safetyPreset??'default',googleSearch=input.googleSearch??false;
  if(!['default','off','block_all'].includes(safetyPreset))throw invalid('请选择有效的安全设置。');
  if(typeof googleSearch!=='boolean')throw invalid('Google 搜索选项格式无效。');
  if(protocol!=='gemini'&&(safetyPreset!=='default'||googleSearch))throw invalid('安全预设与 Google 搜索仅适用于 Gemini 设计接口。');
  return {safetyPreset,googleSearch};
}
export function geminiDesignNativeFields(input={}){
  const {safetyPreset,googleSearch}=normalizeDesignNativeOptions(input);
  const threshold=safetyPreset==='off'?'OFF':safetyPreset==='block_all'?'BLOCK_LOW_AND_ABOVE':null;
  return {...(threshold?{safetySettings:safetyCategories.map(category=>({category,threshold}))}:{}),...(googleSearch?{tools:[{google_search:{searchTypes:{webSearch:{}}}}]}:{})};
}
