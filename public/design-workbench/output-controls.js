'use strict';
let outputPresets=[],outputCatalog=null,outputResolutions=['1K','2K'],outputReady=false,outputProtocol=null,outputRequest=0;
function outputSegment(label,id,options,disabled=false){
  const group=node('div','design-output-group'),title=node('span','output-label',label),choices=node('div','design-segments');
  choices.setAttribute('role','radiogroup');choices.setAttribute('aria-label',label);
  for(const [value,text] of options){
    const choice=node('label'),input=node('input');input.type='radio';input.name=`design-${id}`;input.value=value;input.checked=$(id).value===String(value);input.disabled=disabled;
    input.onchange=()=>{$(id).value=value;renderOutputControls();compile();};choice.append(input,node('span','',text));choices.append(choice);
  }
  group.append(title,choices);return group;
}
function applyOutputProtocol(settings){
  outputProtocol=settings.protocol==='openai'?'openai':'gemini';
  const catalog=outputProtocol==='gemini'?outputCatalog?.gemini:outputCatalog;
  if(catalog){
    outputPresets=catalog.presets;outputResolutions=catalog.resolutions;
    for(const [id,values,fallback] of [['outputAspect',outputPresets.map(preset=>preset.ratio),'3:4'],['outputResolution',outputResolutions,'1K']]){
      const current=$(id).value;$(id).replaceChildren(...values.map(value=>{const option=node('option','',value);option.value=value;return option;}));$(id).value=values.includes(current)?current:fallback;
    }
  }
  renderOutputControls();
}
function renderOutputControls(){
  const focus=document.activeElement?.matches('#designOutputControls input[type="radio"]')?{name:document.activeElement.name,value:document.activeElement.value}:null;
  const native=outputProtocol==='gemini';
  const ratios=document.createDocumentFragment();
  for(const preset of outputPresets){
    const label=node('label'),input=node('input');input.type='radio';input.name='design-ratio';input.value=preset.ratio;input.checked=$('outputAspect').value===preset.ratio;
    label.title=preset.label;const face=node('span'),shape=node('i');const [w,h]=preset.ratio.split(':').map(Number),scale=24/Math.max(w,h);shape.style.width=`${w*scale}px`;shape.style.height=`${h*scale}px`;face.append(shape,document.createTextNode(preset.ratio));
    input.onchange=()=>{$('outputAspect').value=preset.ratio;renderOutputControls();compile();};label.append(input,face);ratios.append(label);
  }
  $('designRatios').replaceChildren(ratios);
  $('designOutputGroups').replaceChildren(
    outputSegment('分辨率','outputResolution',outputResolutions.map(value=>[value,value])),
    outputSegment('数量','outputCount',[['1','1'],['2','2'],['3','3'],['4','4']]),
    native?outputSegment('安全设置','outputSafety',[...($('outputSafety').value==='default'?[['default','接口默认']]:[]),['off','关闭过滤'],['block_all','拦截全部']]):outputSegment('安全设置','outputModeration',[['auto','默认'],['low','较宽松']]),
    ...(native?[outputSegment('Google 搜索','outputSearch',[['false','关闭'],['true','开启']])]:[])
  );
  const size=outputPresets.find(preset=>preset.ratio===$('outputAspect').value)?.sizes[$('outputResolution').value];
  $('outputPixelSummary').textContent=!outputReady?'正在读取出图选项…':native?`目标 ${$('outputAspect').value} · ${$('outputResolution').value}，以接口实际像素为准`:`输出像素 ${size?.replace('x',' × ')||'—'} px`;
  $('outputCapabilityHint').textContent=native?'同一款式可生成多个版本，实际返回数量以模型为准。':'按所选比例、分辨率、数量和安全设置生成。';
  if(focus)Array.from($('designOutputControls').querySelectorAll('input[type="radio"]')).find(input=>input.name===focus.name&&input.value===focus.value)?.focus({preventScroll:true});
}
async function loadOutputControls(preferredProtocol='openai'){
  const request=++outputRequest;$('reloadOutputBtn').hidden=true;
  try{
    const [options,settings]=await Promise.all([api('design/output-options'),api('design/generation-settings')]);
    if(request!==outputRequest)return;
    if(!Array.isArray(options.presets)||!options.presets.length)throw new Error('出图选项不完整');
    if(settings.protocol==='gemini'&&(!Array.isArray(options.gemini?.presets)||!options.gemini.presets.length))throw new Error('请重启 FPA 以加载新的设计出图选项');
    outputCatalog=options;
    outputReady=true;
    // 成衣效果图与搭配工作台共用 GPT 图像接口；线稿转换仍由后端按所选
    // 线稿服务执行，出图选项保持 GPT 的比例、分辨率和数量配置。
    applyOutputProtocol({protocol:preferredProtocol==='openai'?'openai':settings.protocol});
  }catch(error){if(request!==outputRequest)return;outputReady=false;$('outputPixelSummary').textContent=`无法读取出图选项：${error.message}`;$('reloadOutputBtn').hidden=false;}
}
function designOutputValues(protocol=outputProtocol){return {aspectRatio:$('outputAspect').value,resolution:$('outputResolution').value,quality:'auto',count:Number($('outputCount').value),outputFormat:'png',...(protocol==='gemini'?{safetyPreset:$('outputSafety').value,googleSearch:$('outputSearch').value==='true'}:{moderation:$('outputModeration').value})};}
