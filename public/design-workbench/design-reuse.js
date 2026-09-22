/* Reuse saved originals and instructions locally. This flow never calls AI. */
'use strict';
const reuseText=value=>typeof value==='string'?value:'';
function designReuseSettings(job){
  let profile={};try{const parsed=JSON.parse(job.designPrompt||'{}');profile=parsed.garment_profile_compact||parsed;}catch{profile={basic_info:{style:reuseText(job.designPrompt)}};}
  const savedStyle=job.designStyle||profile.style_settings;
  const fabricText=reuseText(profile.materials?.main_fabric),colorText=reuseText(profile.colors?.base_color);
  const style=savedStyle?structuredClone(savedStyle):{
    fabric:fabricText?{mode:'text',text:fabricText}:{mode:'primary'},
    color:colorText?{mode:'text',text:colorText}:{mode:'primary'}
  };
  // Before version 2, selecting a fabric image accidentally left the color
  // source at the UI default (the primary garment). Treat that historical
  // combination as automatic fabric color when it is reused.
  if(style.fabric?.mode==='image'&&style.color?.mode==='primary'&&style.version!==2){style.version=2;style.color.mode='auto';delete style.color.text;delete style.color.hex;}
  const derived=new Set((job.references||[]).flatMap(ref=>(ref.regions||[]).filter(region=>region.priority==='high').map(region=>`${region.part}：${region.note}`)));
  const mustHave=(profile.critical_rules?.must_have||[]).filter(value=>typeof value==='string'&&!derived.has(value));
  const mustAvoid=(profile.critical_rules?.must_avoid||[]).filter(value=>typeof value==='string'&&value!=='不要生成拼贴、分屏、背面小图或多件服装');
  return {style,form:{
    category:reuseText(profile.basic_info?.type),fit:reuseText(profile.silhouette?.fit),goal:reuseText(profile.basic_info?.style),
    colorRatio:savedStyle?reuseText(savedStyle.colorRatio??profile.colors?.strategy):reuseText(profile.colors?.strategy),
    hardware:savedStyle?reuseText(savedStyle.hardware):reuseText(profile.hardware?.finish),
    mustKeep:mustHave.join('\n'),avoid:reuseText(profile.prompt_output?.negative)||mustAvoid.join('\n'),designName:reuseText(job.name),
    outputAspect:job.aspectRatio||'3:4',outputResolution:job.resolution||'1K',outputCount:String(job.count||1),outputModeration:job.moderation||'auto',
    outputSafety:job.safetyPreset||'default',outputSearch:String(job.googleSearch===true)
  }};
}
function restoreReuseForm(form){
  for(const id of formIds){
    const input=$(id),value=String(form[id]??'');
    if(input.tagName==='SELECT'&&!Array.from(input.options).some(option=>option.value===value)){
      const option=node('option','',value||'沿用主体款式');option.value=value;input.append(option);
    }
    input.value=value;
  }
}
function reuseLoading(value){
  importing=value;document.querySelector('.workspace').inert=value;
  $('generateBtn').disabled=value;$('generateTopBtn').disabled=value;
  updateClearButton();renderStyleControls();
}
function reuseFileUrl(value){
  const url=new URL(value,location.origin);
  if(url.origin!==location.origin||!/^\/api\/(?:studio\/files|import\/library)\/[\w.-]+$/.test(url.pathname)||url.search||url.hash)throw new Error('记录中的参考图地址无效');
  return url.href;
}
async function reuseDesignRecord(jobId){
  if(!draftReady||importing||submitting||analysisBusy.size||regionAnalysisBusy.size)throw new Error('当前工作台正在读取、识别或提交，请完成后再复用');
  if($('assetPicker')?.open)throw new Error('请先关闭素材选择窗口，再复用设计');
  reuseLoading(true);const previousStatus=$('generateStatus').textContent;
  const revision=designRevision;let committed=false;
  try{
    const snapshot=await api('state',{signal:AbortSignal.timeout(15000)}),job=snapshot.jobs?.find(item=>item.id===jobId&&item.kind==='design');
    if(!job)throw new Error('这条设计记录已不存在');
    if(['photo_to_sketch','sketch_to_garment'].includes(job.designMode))throw new Error('请在线稿成衣页签复用这条记录，参考改款草稿已保留');
    const references=job.references||[];
    if(!references.length||references.length>10||references.filter(ref=>ref.role==='主体款式参考').length!==1)throw new Error('这条记录的参考图信息不完整');
    const restored=designReuseSettings(job),images=[],styleImages={fabric:null,color:null},annotations=[];let primaryImageId=null;
    for(const [index,reference] of references.entries()){
      generationStatus(`正在复用设计，读取参考图 ${index+1} / ${references.length}…`);
      const response=await fetch(reuseFileUrl(reference.originalImage||reference.image),{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error(`参考图“${reference.name||index+1}”读取失败，当前草稿已保留`);
      const blob=await response.blob();if(blob.size>50*1024*1024||!/^image\/(png|jpeg|webp)$/i.test(blob.type))throw new Error('参考图片格式或大小不受支持');
      const src=await readFile(blob),preview=await displayThumbnail(src),image={id:crypto.randomUUID(),name:reference.name||`参考图 ${index+1}`,src,...preview,type:'history',sourceJobId:job.id};
      if(reference.role==='面料参考'||reference.role==='配色参考'){
        const kind=reference.role==='面料参考'?'fabric':'color';if(styleImages[kind])throw new Error('这条记录有重复的面料或色卡参考');styleImages[kind]=image;
      }else{
        if(!['主体款式参考','局部细节参考'].includes(reference.role))throw new Error('这条记录的参考图用途无法恢复');
        images.push(image);if(reference.role==='主体款式参考')primaryImageId=image.id;
        for(const region of reference.regions||[])annotations.push({...structuredClone(region),id:crypto.randomUUID(),imageId:image.id,source:'history',revision:0});
      }
    }
    for(const kind of ['fabric','color'])if(restored.style[kind]?.mode==='image'&&!styleImages[kind])throw new Error('这条记录缺少面料或配色参考，当前草稿已保留');
    if(designRevision!==revision)throw new Error('当前草稿已变化，请重新选择复用');
    await saveDraft();if(savedRevision!==draftRevision)throw new Error('当前草稿尚未保存成功，请稍后再复用');
    designRevision+=1;clearTimeout(pollTimer);lastJobId=null;
    Object.assign(state,{images,styleImages,annotations,primaryImageId,activeImageId:primaryImageId,selectedAnnotationId:null,drawing:null});
    restoreReuseForm(restored.form);restoreStyleDraft({style:restored.style});
    const selectedRatio=$('outputAspect').value,selectedResolution=$('outputResolution').value;
    if(outputCatalog)applyOutputProtocol({protocol:outputProtocol});
    committed=true;renderAll();await saveDraft();activateTab('design');$('tab-design').scrollTop=0;
    const adjusted=selectedRatio!==$('outputAspect').value||selectedResolution!==$('outputResolution').value;
    const message=`已复用设计，恢复 ${images.length+styleImageCount()} 张参考图、${annotations.length} 处标注。${savedRevision!==draftRevision?'草稿保存失败，请勿关闭页面。':adjusted?'当前接口不支持历史尺寸，请检查出图设置。':'修改后可再次生成。'}`;
    generationStatus(message);toast(message);return message;
  }finally{reuseLoading(false);if(!committed)generationStatus(previousStatus);}
}
window.addEventListener('message',async event=>{
  if(event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='fpa:design-reuse')return;
  const {jobId,requestId}=event.data;let message,ok=false;
  try{message=await reuseDesignRecord(jobId);ok=true;}catch(error){message=`复用失败：${error.message}`;toast(message);}
  window.parent.postMessage({type:'fpa:design-reused',requestId,ok,message},location.origin);
});
