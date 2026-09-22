/* Formmark editor adapted for FPA. Originals and display thumbnails are stored separately. */
'use strict';
const formIds=['category','fit','goal','colorRatio','hardware','mustKeep','avoid','designName','outputAspect','outputResolution','outputCount','outputModeration','outputSafety','outputSearch'];
const allowedParts=['领型','帽型','肩部','袖型','袖口','门襟','胸袋','下袋','分割线','下摆','面料质感','装饰结构','图案','其他结构'];
const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number(value)||0));
const analysisBusy=new Set();
const regionAnalysisBusy=new Set();
let draftReady=false,draftTimer,toastTimer,pollTimer,submitting=false,importing=false,lastJobId=null;
let savedRevision=0,draftRevision=0,draftWrite=Promise.resolve(),analysisConfigured=false;
let designRevision=0;
const storage=new Promise((resolve,reject)=>{
  const request=indexedDB.open('fpa-design-workbench',1);
  request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('images',{keyPath:'id'});db.createObjectStore('drafts');};
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});
storage.catch(()=>{});
function storeRequest(storeName,action,value,key){return storage.then(db=>new Promise((resolve,reject)=>{
  const transaction=db.transaction(storeName,action==='get'?'readonly':'readwrite'),store=transaction.objectStore(storeName);
  const request=action==='get'?store.get(key):action==='delete'?store.delete(key):key===undefined?store.put(value):store.put(value,key);let result;
  request.onsuccess=()=>{result=request.result;};transaction.oncomplete=()=>resolve(result);
  transaction.onerror=()=>reject(transaction.error||request.error);transaction.onabort=()=>reject(transaction.error||new Error('本机草稿保存中断'));
}));}
function scheduleSave(){if(!draftReady)return;draftRevision+=1;$('draftStatus').textContent='正在保存草稿…';clearTimeout(draftTimer);draftTimer=setTimeout(saveDraft,300);}
function saveDraft(){
  if(!draftReady)return;clearTimeout(draftTimer);const revision=draftRevision;
  const images=[...state.images,...Object.values(state.styleImages).filter(Boolean)];
  const draft={imageIds:state.images.map(image=>image.id),styleImageIds:Object.fromEntries(Object.entries(state.styleImages).map(([kind,image])=>[kind,image?.id||null])),style:getStyleDraft(),activeImageId:state.activeImageId,primaryImageId:state.primaryImageId,selectedAnnotationId:state.selectedAnnotationId,annotations:structuredClone(state.annotations),color:state.color,form:Object.fromEntries(formIds.map(id=>[id,$(id).value])),autoAnalyze:$('autoAnalyze').checked,annotationModeVersion:2,lastJobId};
  draftWrite=draftWrite.catch(()=>{}).then(async()=>{
    // Editing a note does not rewrite large source images.
    for(const image of images)if(!image.stored){await storeRequest('images','put',{...image,stored:true});image.stored=true;}
    await storeRequest('drafts','put',draft,'current');savedRevision=revision;
    $('draftStatus').textContent=savedRevision===draftRevision?'草稿已保存在本机':'正在保存草稿…';
  }).catch(error=>{$('draftStatus').textContent='草稿保存失败，请勿关闭页面';toast(`草稿保存失败：${error.message}`);});return draftWrite;
}
async function restoreDraft(){
  try{const draft=await storeRequest('drafts','get',null,'current');if(draft){
    const images=[];for(const id of draft.imageIds||[]){const image=await storeRequest('images','get',null,id);if(image?.src)images.push({...image,stored:true});}
    state.images=images;state.activeImageId=images.some(image=>image.id===draft.activeImageId)?draft.activeImageId:images[0]?.id||null;
    state.primaryImageId=images.some(image=>image.id===draft.primaryImageId)?draft.primaryImageId:images[0]?.id||null;
    state.annotations=(draft.annotations||[]).filter(annotation=>images.some(image=>image.id===annotation.imageId)).map(annotation=>({...annotation,part:annotation.part==='识别中…'?'其他结构':annotation.part,...(annotation.analysisState==='loading'||annotation.part==='识别中…'?{analysisState:'error',analysisError:'上次识别未完成，可点击“重新识别此处”。'}:{})}));
    state.selectedAnnotationId=draft.selectedAnnotationId||null;state.color=draft.color||'';
    for(const id of formIds)if(draft.form?.[id]!=null){
      if(['outputAspect','category','fit'].includes(id)&&!Array.from($(id).options).some(option=>option.value===draft.form[id])){const option=node('option','',draft.form[id]||'沿用主体款式');option.value=draft.form[id];$(id).append(option);}
      $(id).value=draft.form[id];
    }
    if(!['1K','2K','4K'].includes($('outputResolution').value))$('outputResolution').value='1K';
    for(const kind of ['fabric','color']){const id=draft.styleImageIds?.[kind];const image=id?await storeRequest('images','get',null,id):null;state.styleImages[kind]=image?.src?{...image,stored:true}:null;}
    restoreStyleDraft(draft);
    if(!draft.style){
      // Old starter text was not a user selection. Preserve custom edits while
      // removing the bundled defaults that used to force the same look.
      const legacy={fabric:'哑光轻量防泼水尼龙，细密斜纹，轻微挺度',goal:'开发一件适合城市通勤与轻户外场景的原创夹克，结构清晰、商业可穿，但具有可识别的局部设计语言。',colorRatio:'主色 85% / 辅色 15%',hardware:'哑光黑'};
      for(const id of ['goal','colorRatio','hardware'])if($(id).value===legacy[id])$(id).value='';
      if(draft.form?.fabric&&draft.form.fabric!==legacy.fabric){$('fabricMode').value='text';$('fabric').value=draft.form.fabric;}
      if(draft.color&&draft.color!=='炭黑'){$('colorMode').value='text';$('colorText').value=draft.color;}
    }
    $('autoAnalyze').checked=draft.annotationModeVersion===2?draft.autoAnalyze!==false:true;lastJobId=draft.lastJobId||null;
  }$('draftStatus').textContent=draft?'已恢复本机草稿':'草稿自动保存在本机';
  }catch(error){$('draftStatus').textContent='本机草稿不可用';toast(`无法读取草稿：${error.message}`);}
  finally{draftReady=true;renderAll(false);await loadOutputControls();if(lastJobId)pollJob(lastJobId);window.parent.postMessage({type:'fpa:design-ready'},location.origin);}
}
function node(tag,className,text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;}
function toast(message){clearTimeout(toastTimer);$('toast').textContent=String(message);$('toast').classList.add('show');toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4200);}
function activateTab(name){document.querySelectorAll('.tab').forEach(button=>{const active=button.dataset.tab===name;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});document.querySelectorAll('.tab-view').forEach(view=>view.classList.toggle('active',view.id===`tab-${name}`));}
function compile(save=true){const data=compileData();$('promptBox').textContent=compilePrompt(data);$('jsonBox').textContent=JSON.stringify(data,null,2);$('promptStats').textContent=`${state.images.length} 张参考 · ${state.annotations.length} 处标注`;$('promptTime').textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false});if(save)scheduleSave();}
function renderAll(save=true){renderImages();renderCanvas();renderChips();renderAnnotationForm();updateAnalyzeButton();updateClearButton();renderStyleControls();renderOutputControls();compile(save);}
function updateClearButton(){
  const button=$('clearDesignBtn');
  button.disabled=!draftReady||importing||submitting||(!state.images.length&&!styleImageCount()&&!state.annotations.length&&!lastJobId);
}
function clearDesign(){
  if(!draftReady||importing||submitting)return;
  if(!state.images.length&&!styleImageCount()&&!state.annotations.length&&!lastJobId)return;
  const removed=[...state.images,...Object.values(state.styleImages).filter(Boolean)];
  designRevision+=1;clearTimeout(pollTimer);lastJobId=null;analysisBusy.clear();regionAnalysisBusy.clear();
  Object.assign(state,{images:[],styleImages:{fabric:null,color:null},annotations:[],activeImageId:null,primaryImageId:null,selectedAnnotationId:null,drawing:null});
  $('fileInput').value='';
  generationStatus('选择新的参考图，开始下一款设计。');activateTab('design');renderAll();
  const clearedRevision=draftRevision;
  // Delete only browser draft copies after the empty draft is saved.
  draftWrite=saveDraft().then(async()=>{
    if(savedRevision<clearedRevision)return;
    for(const image of removed){
      if([...state.images,...Object.values(state.styleImages).filter(Boolean)].some(current=>current.id===image.id))continue;
      image.stored=false;await storeRequest('images','delete',null,image.id);
    }
  }).catch(()=>{});
  toast('已清除参考图和标注；素材库和生成记录已保留');
}
function renderImages(){
  $('imageCount').textContent=`${state.images.length} 张`;const fragment=document.createDocumentFragment();
  state.images.forEach(image=>{
    const card=node('article',`thumb${image.id===state.activeImageId?' active':''}`),select=node('button','thumb-select');select.type='button';select.setAttribute('aria-label',`选择参考图 ${image.name}`);select.setAttribute('aria-pressed',String(image.id===state.activeImageId));
    const picture=node('img');picture.src=image.thumbnail||image.src;picture.alt=image.name;picture.loading='lazy';picture.decoding='async';picture.width=148;picture.height=112;
    const info=node('div','thumb-info'),title=node('strong','',image.name);title.title=image.name;info.append(title,node('span','',`${state.annotations.filter(a=>a.imageId===image.id).length} 处标注`));select.append(picture,info);
    select.onclick=()=>{state.activeImageId=image.id;state.selectedAnnotationId=null;renderAll();};select.ondblclick=()=>{state.primaryImageId=image.id;renderImages();compile();toast('已设为主体款式');};card.append(select);
    if(image.id===state.primaryImageId)card.append(node('span','primary-badge','主体款式'));
    const remove=node('button','thumb-delete','×');remove.type='button';remove.setAttribute('aria-label',`删除参考图 ${image.name}`);remove.title='删除参考图';remove.onclick=()=>removeImage(image.id);card.append(remove);fragment.append(card);
  });$('thumbList').replaceChildren(fragment);
}
function removeImage(id){const image=state.images.find(record=>record.id===id);if(!image)return;
  state.images=state.images.filter(record=>record.id!==id);state.annotations=state.annotations.filter(annotation=>annotation.imageId!==id);
  if(state.activeImageId===id)state.activeImageId=state.images[0]?.id||null;if(state.primaryImageId===id)state.primaryImageId=state.images[0]?.id||null;if(!selectedAnn())state.selectedAnnotationId=null;
  renderAll();saveDraft()?.then(()=>{if(savedRevision===draftRevision)storeRequest('images','delete',null,id).catch(()=>{});});
}
function fitCanvas(){const image=$('canvasImage'),record=activeImage();if(!record||!image.naturalWidth||image.dataset.imageId!==record.id)return;
  const width=$('canvasWrap').clientWidth-28,height=$('canvasWrap').clientHeight-28;if(width<1||height<1)return;
  const scale=Math.min(width/image.naturalWidth,height/image.naturalHeight);
  // The overlay shares the image's intrinsic aspect ratio; no object-fit letterbox can shift coordinates.
  $('canvasShell').style.width=`${image.naturalWidth*scale}px`;$('canvasShell').style.height=`${image.naturalHeight*scale}px`;
}
function renderCanvas(){const image=activeImage();$('emptyCanvas').hidden=Boolean(image);$('canvasShell').hidden=!image;$('activeImageName').textContent=image?image.name:'未选择参考图';$('activeImageName').title=image?.name||'';
  if(!image){$('canvasImage').removeAttribute('src');delete $('canvasImage').dataset.imageId;$('canvasLayer').replaceChildren();return;}
  const canvasImage=$('canvasImage');if(canvasImage.dataset.imageId!==image.id){canvasImage.dataset.imageId=image.id;canvasImage.src=image.src;canvasImage.alt=image.name;}
  const fragment=document.createDocumentFragment();state.annotations.filter(annotation=>annotation.imageId===image.id).forEach(annotation=>{
    const box=node('button',`annotation${annotation.id===state.selectedAnnotationId?' active':''}${annotation.y<.08?' near-top':''}`);box.type='button';box.dataset.id=annotation.id;
    Object.assign(box.style,{left:`${annotation.x*100}%`,top:`${annotation.y*100}%`,width:`${annotation.w*100}%`,height:`${annotation.h*100}%`});
    box.append(node('span','ann-label',`${regionLabel(annotation)} ${annotation.analysisState==='loading'?'识别中…':annotation.part} · ${modeLabel(annotation.mode)||'借鉴并调整'}`));box.setAttribute('aria-label',`编辑标注：${annotation.part}`);box.onpointerdown=event=>event.stopPropagation();
    box.onclick=event=>{event.stopPropagation();state.selectedAnnotationId=annotation.id;renderCanvas();renderChips();renderAnnotationForm();activateTab('annotation');};fragment.append(box);
  });$('canvasLayer').replaceChildren(fragment);fitCanvas();
}
function regionLabel(annotation){return `R${state.images.findIndex(image=>image.id===annotation.imageId)+1}.${state.annotations.filter(item=>item.imageId===annotation.imageId).findIndex(item=>item.id===annotation.id)+1}`;}
function renderChips(){$('annCount').textContent=`${state.annotations.length} 处`;const fragment=document.createDocumentFragment();state.annotations.forEach(annotation=>{const image=state.images.find(record=>record.id===annotation.imageId),chip=node('button',`ann-chip${annotation.id===state.selectedAnnotationId?' active':''}`,`${regionLabel(annotation)} ${annotation.analysisState==='loading'?'识别中…':annotation.part}`);chip.type='button';chip.title=`${image?.name||''} · ${annotation.placement}`;chip.onclick=()=>{state.selectedAnnotationId=annotation.id;state.activeImageId=annotation.imageId;renderAll();activateTab('annotation');};fragment.append(chip);});if(!state.annotations.length)fragment.append(node('span','count','框选服装局部，或添加标注'));$('annChips').replaceChildren(fragment);}
function renderAnnotationForm(){const annotation=selectedAnn();$('annotationEmpty').hidden=Boolean(annotation);$('annotationForm').hidden=!annotation;if(!annotation)return;
  updateRegionAnalysisStatus();
  for(const[id,property]of[['annPart','part'],['annPlacement','placement'],['annMode','mode'],['annNote','note'],['annColor','color'],['annFabric','fabric']])$(id).value=annotation[property]||'';
  document.querySelectorAll('.priority').forEach(button=>{const active=button.dataset.priority===annotation.priority;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  for(const[id,property]of[['annX','x'],['annY','y'],['annW','w'],['annH','h']])if($(id))$(id).value=Math.round(annotation[property]*100);
}
function updateRegionAnalysisStatus(){
  const annotation=selectedAnn();if(!annotation)return;const busy=regionAnalysisBusy.has(annotation.id);
  $('reanalyzeRegionBtn').disabled=busy;$('reanalyzeRegionBtn').textContent=busy?'识别中…':'重新识别此处';
  $('regionAnalysisStatus').classList.toggle('error',annotation.analysisState==='error');
  $('regionAnalysisStatus').textContent=busy?'正在识别这个区域的部位和结构细节…':annotation.analysisState==='error'?`识别未完成：${annotation.analysisError||'请重试或手动填写。'}`:annotation.analysisState==='stale'?'已保留你的修改；如需识别新的区域，请重新识别。':annotation.analysisState==='complete'?'AI 已填写部位与细节，你可以继续修改。':'可手动填写，或点击“重新识别此处”让 AI 分析。';
}
function updateAnalyzeButton(){const busy=analysisBusy.has(state.activeImageId);$('analyzeBtn').disabled=busy;$('analyzeBtn').textContent=busy?'识别中…':'AI 识别本图';}
function loadImage(src){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('无法读取图片，请使用 PNG、JPEG 或 WebP 图片'));image.src=src;});}
async function displayThumbnail(src){const image=await loadImage(src),canvas=document.createElement('canvas');const scale=Math.min(1,320/Math.max(image.naturalWidth,image.naturalHeight));canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);return{thumbnail:canvas.toDataURL('image/webp',.78),width:image.naturalWidth,height:image.naturalHeight};}
function readFile(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error(`无法读取 ${file.name}`));reader.readAsDataURL(file);});}
async function uploadFiles(files){
  if(importing||!draftReady||submitting)return toast('正在读取或提交，请稍候');const selected=[...files];if(!selected.length)return;if(state.images.length+styleImageCount()+selected.length>10)return toast('款式、面料和配色参考合计最多 10 张，请先删除不用的图片');
  importing=true;$('fileInput').disabled=true;updateClearButton();let added=0;
  try{for(const file of selected){
    if(!/^image\/(png|jpe?g|webp)$/i.test(file.type)){toast(`“${file.name}”格式不支持，请使用 PNG、JPEG 或 WebP`);continue;}
    if(file.size>50*1024*1024){toast(`“${file.name}”超过 50 MB，请使用更小的图片`);continue;}
    const src=await readFile(file),preview=await displayThumbnail(src),image={id:crypto.randomUUID(),name:file.name,src,...preview,type:'upload'};
    state.images.push(image);added+=1;if(!state.activeImageId)state.activeImageId=image.id;if(!state.primaryImageId)state.primaryImageId=image.id;renderAll();
  }if(added)toast(`已上传 ${added} 张参考图，生成时使用原图`);
  }catch(error){toast(error.message);}finally{importing=false;$('fileInput').disabled=false;$('fileInput').value='';updateClearButton();}
}
async function api(path,options={}){const response=await fetch(`/api/studio/${path}`,{...options,headers:{'Content-Type':'application/json',...options.headers}});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(typeof result.error==='string'?result.error:result.error?.message||result.message||`请求失败（${response.status}）`);return result;}
let analysisSettingsRequest=0;
async function loadAnalysisSettings(){const request=++analysisSettingsRequest;try{const settings=await api('design/settings');if(request===analysisSettingsRequest)analysisConfigured=Boolean(settings.configured);}catch(error){if(request===analysisSettingsRequest){analysisConfigured=false;toast(`暂时无法读取识别设置：${error.message}`);}}}
function openDesignSettings(section){if(window.parent!==window)window.parent.postMessage({type:'fpa:design-settings',section},location.origin);else window.location.assign(`/?view=settings&section=${section}`);}
function openAnalysisSettings(){openDesignSettings('analysis');}
function requireAnalysisSettings(){if(analysisConfigured)return true;toast('请先在“系统设置 → AI 识别接口”完成配置');openAnalysisSettings();return false;}
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===window.parent&&event.data?.type==='fpa:design-activated'){loadAnalysisSettings();if(draftReady)loadOutputControls();}});
function normalizePart(part){const aliases={'衣领':'领型','领口':'领型','翻领':'领型','立领':'领型','衬衫领':'领型','袖口结构':'袖口'};return allowedParts.includes(part)?part:aliases[part]||'其他结构';}
function normalizeRegion(region,imageId){const x=clamp(region.x,0,.975),y=clamp(region.y,0,.975),w=clamp(region.w,.025,1-x),h=clamp(region.h,.025,1-y);return{id:crypto.randomUUID(),imageId,x,y,w,h,part:normalizePart(region.part),placement:String(region.placement||'对应部位').slice(0,300),mode:'adapt',note:String(region.note||'借鉴该区域的结构关系和视觉语言，不继承原图其它部位。').slice(0,4000),priority:Number(region.confidence)>=.85?'high':'medium',color:'ignore',fabric:'adapt',source:'ai'};}
async function analyzeActiveImage(){
  const source=activeImage();if(!source)return toast('请先上传并选择参考图');if(analysisBusy.has(source.id)||!requireAnalysisSettings())return;analysisBusy.add(source.id);updateAnalyzeButton();
  const revision=designRevision;
  try{const result=await api('design/analyze',{method:'POST',body:JSON.stringify({imageDataUrl:source.src})});if(revision!==designRevision||!state.images.some(image=>image.id===source.id))return;
    const regions=(Array.isArray(result.regions)?result.regions:[]).slice(0,30).map(region=>normalizeRegion(region,source.id));state.annotations=state.annotations.filter(annotation=>!(annotation.imageId===source.id&&annotation.source==='ai'));state.annotations.push(...regions);
    if(state.activeImageId===source.id){state.selectedAnnotationId=regions[0]?.id||null;if(regions.length)activateTab('annotation');}renderAll();toast(regions.length?`“${source.name}”已识别 ${regions.length} 处结构`:'未识别到明确局部，可以手动框选');
  }catch(error){if(revision===designRevision)toast(`识别失败：${error.message}`);}finally{if(revision===designRevision){analysisBusy.delete(source.id);updateAnalyzeButton();}}
}
async function analyzeSelectedRegion(annotation,source){
  if(regionAnalysisBusy.has(annotation.id))return;
  const revision=designRevision,initialRevision=annotation.revision||0,selection={x:annotation.x,y:annotation.y,w:annotation.w,h:annotation.h};
  regionAnalysisBusy.add(annotation.id);annotation.analysisState='loading';annotation.analysisError='';renderAll();
  try{const image=await loadImage(source.src),canvas=document.createElement('canvas');const sourceW=Math.max(1,Math.round(selection.w*image.naturalWidth)),sourceH=Math.max(1,Math.round(selection.h*image.naturalHeight));const scale=Math.min(1,960/Math.max(sourceW,sourceH));canvas.width=Math.max(1,Math.round(sourceW*scale));canvas.height=Math.max(1,Math.round(sourceH*scale));
    canvas.getContext('2d').drawImage(image,Math.round(selection.x*image.naturalWidth),Math.round(selection.y*image.naturalHeight),sourceW,sourceH,0,0,canvas.width,canvas.height);
    if(revision!==designRevision)return;
    const result=await api('design/analyze',{method:'POST',body:JSON.stringify({imageDataUrl:source.src,cropDataUrl:canvas.toDataURL('image/png'),selection})});
    if(revision!==designRevision)return;
    const current=state.annotations.find(item=>item.id===annotation.id);if(!current||(current.revision||0)!==initialRevision)return;
    current.part=normalizePart(result.part);current.placement=String(result.placement||'对应部位');current.note=String(result.note||'参考框选区域的结构');current.priority=Number(result.confidence)>=.85?'high':'medium';current.source='selection-ai';current.analysisState='complete';toast(`局部已识别为：${current.part}`);
  }catch(error){const current=state.annotations.find(item=>item.id===annotation.id);if(revision===designRevision&&current&&(current.revision||0)===initialRevision){current.analysisState='error';current.analysisError=error.message;toast(`局部识别失败：${error.message}`);}}
  finally{if(revision===designRevision){regionAnalysisBusy.delete(annotation.id);const current=state.annotations.find(item=>item.id===annotation.id);if(current){if((current.revision||0)!==initialRevision)current.analysisState='stale';renderAll();}}}
}
function createAnnotation(selection,auto=false){const source=activeImage();if(!source)return toast('请先上传参考图片');if(!draftReady)return toast('正在恢复草稿，请稍候');const annotation={id:crypto.randomUUID(),imageId:source.id,...selection,part:'其他结构',placement:'对应部位',mode:'adapt',note:'',priority:'medium',color:'ignore',fabric:'adapt',source:'manual'};state.annotations.push(annotation);state.selectedAnnotationId=annotation.id;renderAll();activateTab('annotation');if(auto){if(requireAnalysisSettings())analyzeSelectedRegion(annotation,source);else{annotation.analysisState='error';annotation.analysisError='请先在系统设置中配置 AI 识别接口，再点击“重新识别此处”。';renderAll();}}}
function generationStatus(message,error=false){$('generateStatus').textContent=message;$('generateStatus').classList.toggle('error',error);}
async function generateImage(){
  if(submitting)return;if(importing||!draftReady)return toast('图片仍在读取，请稍候');if(!outputReady)return toast('请先重新读取出图选项');if(!state.images.length)return toast('请先上传至少一张参考图');const styleError=validateDesignStyle();if(styleError){activateTab('design');return toast(styleError);}if(state.annotations.some(annotation=>regionAnalysisBusy.has(annotation.id))||state.images.some(image=>analysisBusy.has(image.id)))return toast('参考图仍在识别，请完成后再生成');
  // Lock before preparing references to prevent a double-click submitting twice.
  submitting=true;$('generateBtn').disabled=true;$('generateTopBtn').disabled=true;updateClearButton();activateTab('generate');generationStatus('正在提交设计任务…');
  let submissionStarted=false;
  try{const settings=await api('design/generation-settings');
    if(!settings.configured){generationStatus('请先在“系统设置 → 设计出图接口”完成配置',true);toast('请先配置独立的设计出图接口');openDesignSettings('design-generation');return;}
    const chosenOutput=designOutputValues();applyOutputProtocol(settings);
    if(JSON.stringify(chosenOutput)!==JSON.stringify(designOutputValues())){generationStatus('接口配置已变化，出图选项已更新，请检查后再次生成。');return;}
    const references=state.images.map(image=>({id:image.id,name:image.name,role:image.id===state.primaryImageId?'主体款式参考':'局部细节参考',imageDataUrl:image.src,regions:state.annotations.filter(annotation=>annotation.imageId===image.id)}));
    references.push(...getStyleReferences());
    const body={name:$('designName').value.trim()||`设计稿 · ${$('category').value}`,prompt:compilePrompt(compileData()),...designOutputValues(),style:{...getDesignStyle(),colorRatio:$('colorRatio').value.trim(),hardware:$('hardware').value.trim()},references};
    submissionStarted=true;const result=await api('design/generate',{method:'POST',body:JSON.stringify(body)}),job=result.job||result;if(!job.id)throw new Error('服务端未返回任务编号，请在生成记录核对，勿重复提交');
    lastJobId=job.id;scheduleSave();generationStatus('已加入生成队列，可在生成记录查看');clearTimeout(pollTimer);pollJob(job.id);toast('设计任务已提交');
  }catch(error){generationStatus(submissionStarted?`提交未完成：${error.message}。请先查看生成记录再决定是否重试。`:`设计任务尚未提交：${error.message}`,true);}finally{submitting=false;$('generateBtn').disabled=false;$('generateTopBtn').disabled=false;updateClearButton();}
}
async function pollJob(id){
  const revision=designRevision;
  if(id!==lastJobId)return;try{const snapshot=await api('state');if(id!==lastJobId||revision!==designRevision)return;const job=(snapshot.jobs||[]).find(item=>item.id===id);if(!job){generationStatus('该任务已移除，请在生成记录查看其他结果');return;}
    if(job.status==='queued'||job.status==='processing'){generationStatus(job.status==='queued'?`排队中${job.queuePosition?` · 第 ${job.queuePosition} 位`:''}，等待生成`:'正在生成，完成后保存到生成记录');pollTimer=setTimeout(()=>pollJob(id),1800);return;}
    if(job.status!=='complete'||!job.image){generationStatus(job.resultUncertain?`结果待确认，可能已经扣费。${job.error||'请核对服务商后台'}`:`${job.status==='cancelled'?'任务已取消':'生成失败'}：${job.error||'未返回图片'}`,true);return;}
    generationStatus(`生成完成${job.actualSize?` · 实际 ${String(job.actualSize).replace('x',' × ')}`:''} · 已保存到生成记录${job.sizeNotice?`。${job.sizeNotice}`:''}`);
    // Results are viewed and downloaded from generation history.
  }catch(error){if(id!==lastJobId||revision!==designRevision)return;generationStatus(`暂时无法读取进度，正在恢复连接：${error.message}`);pollTimer=setTimeout(()=>pollJob(id),5000);}
}
async function copyPrompt(){try{await navigator.clipboard.writeText($('promptBox').textContent);toast('设计提示词已复制');}catch{const fallback=document.createElement('textarea');fallback.value=$('promptBox').textContent;document.body.append(fallback);fallback.select();const copied=document.execCommand('copy');fallback.remove();toast(copied?'设计提示词已复制':'复制失败，请手动选择提示词复制');}}
function exportJson(){const url=URL.createObjectURL(new Blob([$('jsonBox').textContent],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='FPA-设计参考标注.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('标注数据已导出');}
// Canvas interactions use normalized coordinates so resizing the window never changes a region.
$('canvasImage').onload=fitCanvas;
new ResizeObserver(fitCanvas).observe($('canvasWrap'));
$('canvasLayer').addEventListener('pointerdown',event=>{if(event.button!==0||state.tool!=='box'||!activeImage())return;const rect=event.currentTarget.getBoundingClientRect();if(!rect.width||!rect.height)return;const sx=clamp((event.clientX-rect.left)/rect.width,0,1),sy=clamp((event.clientY-rect.top)/rect.height,0,1);state.drawing={imageId:state.activeImageId,sx,sy,x:sx,y:sy,w:0,h:0};event.currentTarget.setPointerCapture(event.pointerId);});
$('canvasLayer').addEventListener('pointermove',event=>{if(!state.drawing)return;const rect=event.currentTarget.getBoundingClientRect(),ex=clamp((event.clientX-rect.left)/rect.width,0,1),ey=clamp((event.clientY-rect.top)/rect.height,0,1),drawing=state.drawing;Object.assign(drawing,{x:Math.min(drawing.sx,ex),y:Math.min(drawing.sy,ey),w:Math.abs(ex-drawing.sx),h:Math.abs(ey-drawing.sy)});let preview=$('drawingPreview');if(!preview){preview=node('div','annotation active');preview.id='drawingPreview';preview.style.pointerEvents='none';$('canvasLayer').append(preview);}Object.assign(preview.style,{left:`${drawing.x*100}%`,top:`${drawing.y*100}%`,width:`${drawing.w*100}%`,height:`${drawing.h*100}%`});});
$('canvasLayer').addEventListener('pointerup',event=>{const drawing=state.drawing;state.drawing=null;$('drawingPreview')?.remove();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(!drawing||drawing.imageId!==state.activeImageId||drawing.w<.025||drawing.h<.025)return;createAnnotation({x:drawing.x,y:drawing.y,w:drawing.w,h:drawing.h},$('autoAnalyze').checked);});
$('canvasLayer').addEventListener('pointercancel',()=>{state.drawing=null;$('drawingPreview')?.remove();});
$('manualAnnBtn').onclick=()=>createAnnotation({x:.25,y:.25,w:.5,h:.5});
$('reanalyzeRegionBtn').onclick=()=>{const annotation=selectedAnn(),source=state.images.find(image=>image.id===annotation?.imageId);if(annotation&&source&&requireAnalysisSettings())analyzeSelectedRegion(annotation,source);};
document.querySelectorAll('[data-tool]').forEach(button=>button.onclick=()=>{state.tool=button.dataset.tool;document.querySelectorAll('[data-tool]').forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});$('canvasLayer').style.cursor=state.tool==='box'?'crosshair':'default';});
document.querySelector('.inspector-tabs').setAttribute('role','tablist');document.querySelectorAll('.tab').forEach(button=>{button.setAttribute('role','tab');button.setAttribute('aria-controls',`tab-${button.dataset.tab}`);button.onclick=()=>activateTab(button.dataset.tab);});document.querySelectorAll('.tab-view').forEach(view=>view.setAttribute('role','tabpanel'));
document.querySelectorAll('.compile').forEach(element=>element.addEventListener('input',()=>compile()));
document.querySelectorAll('.ann-edit').forEach(element=>element.addEventListener('input',()=>{const annotation=selectedAnn();if(!annotation)return;for(const[id,property]of[['annPart','part'],['annPlacement','placement'],['annMode','mode'],['annNote','note'],['annColor','color'],['annFabric','fabric']])annotation[property]=$(id).value;annotation.revision=(annotation.revision||0)+1;annotation.source='manual';renderCanvas();renderChips();compile();}));
document.querySelectorAll('.region-edit').forEach(element=>element.addEventListener('change',()=>{const annotation=selectedAnn();if(!annotation)return;annotation.x=clamp(Number($('annX').value)/100,0,.97);annotation.y=clamp(Number($('annY').value)/100,0,.97);annotation.w=clamp(Number($('annW').value)/100,.03,1-annotation.x);annotation.h=clamp(Number($('annH').value)/100,.03,1-annotation.y);annotation.revision=(annotation.revision||0)+1;annotation.source='manual';renderCanvas();renderAnnotationForm();compile();}));
document.querySelectorAll('.priority').forEach(button=>button.onclick=()=>{const annotation=selectedAnn();if(!annotation)return;annotation.priority=button.dataset.priority;annotation.revision=(annotation.revision||0)+1;annotation.source='manual';renderAnnotationForm();compile();});
document.querySelectorAll('.swatch').forEach(button=>{button.setAttribute('aria-label',button.dataset.color);button.onclick=()=>{state.color=button.dataset.color;document.querySelectorAll('.swatch').forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});compile();};});
$('deleteAnnBtn').onclick=()=>{if(!selectedAnn())return toast('请先选择标注');state.annotations=state.annotations.filter(annotation=>annotation.id!==state.selectedAnnotationId);state.selectedAnnotationId=null;renderAll();};
$('primaryBtn').onclick=()=>{if(!activeImage())return toast('请先上传参考图');state.primaryImageId=state.activeImageId;renderImages();compile();toast('已设为主体款式');};
$('fileInput').addEventListener('change',event=>uploadFiles(event.target.files));
const library=document.querySelector('.library');library.addEventListener('dragover',event=>{event.preventDefault();library.classList.add('dragging');});library.addEventListener('dragleave',event=>{if(!library.contains(event.relatedTarget))library.classList.remove('dragging');});library.addEventListener('drop',event=>{event.preventDefault();library.classList.remove('dragging');uploadFiles(event.dataTransfer.files);});
$('clearDesignBtn').onclick=clearDesign;$('autoAnalyze').onchange=scheduleSave;$('analyzeBtn').onclick=analyzeActiveImage;$('generateBtn').onclick=generateImage;$('generateTopBtn').onclick=generateImage;$('copyTopBtn').onclick=copyPrompt;$('copyPromptBtn').onclick=copyPrompt;$('downloadJsonBtn').onclick=exportJson;
window.addEventListener('beforeunload',event=>{if(submitting||importing||regionAnalysisBusy.size||analysisBusy.size||savedRevision!==draftRevision){saveDraft();event.preventDefault();event.returnValue='';}});window.addEventListener('pagehide',()=>{clearTimeout(pollTimer);if(savedRevision!==draftRevision)saveDraft();});
$('reloadOutputBtn').onclick=loadOutputControls;initStyleControls();activateTab('design');renderAll(false);loadAnalysisSettings();restoreDraft();
