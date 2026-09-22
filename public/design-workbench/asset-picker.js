/* Library imports snapshot the active image bytes. Thumbnails are display-only. */
'use strict';
const assetCategories={upperbody:'上衣',wholebody_up:'外套',lowerbody:'下装',dress:'内搭',shoes:'鞋子',accessories_up:'配饰',fabric:'面料',trims:'辅料',person:'人物体型',face:'人物人脸',pose:'人物姿势',scene:'场景'};
const assetPicker={assets:[],selected:new Set(),page:0,pageSize:8,loading:false,busy:false,request:null,previews:null,previewCache:new Map(),target:'references'};
const assetKey=asset=>JSON.stringify([String(asset.id),asset.image]);
const assetImported=asset=>asset&& (assetPicker.target==='fabric'?[state.styleImages.fabric].filter(Boolean):state.images).some(image=>String(image.sourceAssetId)===String(asset.id)&&image.sourceImageUrl===asset.image);
const assetCapacity=()=>assetPicker.target==='fabric'?Math.min(1,Math.max(0,10-state.images.length-styleImageCount()+(state.styleImages.fabric?1:0))):Math.max(0,10-state.images.length-styleImageCount());
function assetFileUrl(path){
  const url=new URL(path,location.origin);
  if(url.origin!==location.origin||!/^\/api\/(?:studio\/files\/|import\/library\/)/.test(url.pathname))throw new Error('素材图片地址无效，请在素材库重新上传');
  return url.href;
}
function pickerStatus(message,error=false){$('assetPickerStatus').textContent=message;$('assetPickerStatus').classList.toggle('error',error);}
function pickerControls(){
  const busy=assetPicker.busy;
  for(const id of ['closeAssetPickerBtn','cancelAssetPickerBtn','assetSearch','assetCategory','reloadAssetsBtn'])$(id).disabled=busy;
  $('assetSelectionCount').textContent=`已选 ${assetPicker.selected.size} 张 · 还可加入 ${assetCapacity()} 张`;
  $('addAssetsBtn').disabled=busy||assetPicker.loading||!assetPicker.selected.size||assetPicker.selected.size>assetCapacity();
  $('addAssetsBtn').textContent=busy?'正在加入…':assetPicker.target==='fabric'?'用作面料参考':`加入参考图库${assetPicker.selected.size?`（${assetPicker.selected.size}）`:''}`;
  document.querySelectorAll('.asset-choice').forEach(card=>{
    const asset=assetPicker.assets.find(item=>assetKey(item)===card.dataset.key),selected=assetPicker.selected.has(card.dataset.key),already=assetImported(asset);
    card.disabled=busy||already||(!selected&&assetPicker.target!=='fabric'&&assetPicker.selected.size>=assetCapacity());card.setAttribute('aria-pressed',String(selected));card.classList.toggle('selected',selected);
    card.querySelector('.asset-choice-mark').textContent=already?'已加入':selected?'✓ 已选':'选择';
  });
}
function filteredAssets(){const query=$('assetSearch').value.trim().toLocaleLowerCase(),part=$('assetCategory').value;return assetPicker.assets.filter(asset=>(!part||asset.part===part)&&(!query||String(asset.name||'').toLocaleLowerCase().includes(query)));}
function renderAssetPicker(){
  assetPicker.previews?.abort();const filtered=filteredAssets(),pages=Math.max(1,Math.ceil(filtered.length/assetPicker.pageSize));assetPicker.page=Math.min(assetPicker.page,pages-1);
  const fragment=document.createDocumentFragment(),visible=filtered.slice(assetPicker.page*assetPicker.pageSize,(assetPicker.page+1)*assetPicker.pageSize),previews=[];
  for(const asset of visible){
    const card=node('button','asset-choice');card.type='button';card.dataset.key=assetKey(asset);card.setAttribute('aria-label',`选择素材 ${asset.name||'未命名素材'}`);
    const preview=node('div','asset-choice-preview'),picture=node('img');picture.alt='';picture.decoding='async';picture.width=240;picture.height=150;picture.hidden=true;preview.append(picture,node('span','asset-preview-status','预览加载中…'));
    const info=node('div','asset-choice-info'),name=node('strong','',asset.name||'未命名素材');name.title=asset.name||'未命名素材';info.append(name,node('span','',assetCategories[asset.part]||'其他素材'));
    card.append(preview,info,node('span','asset-choice-mark','选择'));
    card.onclick=()=>{const key=assetKey(asset);if(assetPicker.selected.has(key))assetPicker.selected.delete(key);else if(!assetImported(asset)){if(assetPicker.target==='fabric')assetPicker.selected.clear();if(assetPicker.selected.size<assetCapacity())assetPicker.selected.add(key);}pickerControls();};
    fragment.append(card);previews.push({asset,picture,preview});
  }
  if(!visible.length)fragment.append(node('div','asset-picker-empty',assetPicker.loading?'正在读取素材库…':assetPicker.assets.length?'没有找到素材，试试其他名称或分类。':'素材库里还没有图片，先在素材库上传，或直接上传本地参考图。'));
  $('assetPickerGrid').replaceChildren(fragment);$('assetPickerGrid').scrollTop=0;
  $('assetPageInfo').textContent=`${assetPicker.page+1} / ${pages} 页 · ${filtered.length} 个素材`;
  $('assetPrevBtn').disabled=assetPicker.busy||assetPicker.loading||assetPicker.page===0;$('assetNextBtn').disabled=assetPicker.busy||assetPicker.loading||assetPicker.page>=pages-1;
  pickerControls();if(previews.length&&!assetPicker.busy)loadAssetPreviews(previews);
}
async function loadAssetPreviews(items){
  const controller=new AbortController();assetPicker.previews=controller;
  // Decode only one preview at a time; do not retain all full-resolution library images.
  for(const {asset,picture,preview} of items){
    if(controller.signal.aborted)return;
    try{
      const url=assetFileUrl(asset.image);let thumbnail=assetPicker.previewCache.get(url);
      if(!thumbnail){
        const response=await fetch(url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});if(!response.ok)throw new Error('无法读取预览');
        const blob=await response.blob();if(blob.size>50*1024*1024)throw new Error('图片过大');
        if(typeof createImageBitmap==='function'){
          const bitmap=await createImageBitmap(blob,{resizeWidth:240,resizeQuality:'medium'});
          try{const canvas=document.createElement('canvas');const scale=Math.min(1,240/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);thumbnail=canvas.toDataURL('image/webp',.78);}finally{bitmap.close();}
        }else{
          const objectUrl=URL.createObjectURL(blob);try{thumbnail=(await displayThumbnail(objectUrl)).thumbnail;}finally{URL.revokeObjectURL(objectUrl);}
        }
        if(controller.signal.aborted)return;
        if(assetPicker.previewCache.size>=64)assetPicker.previewCache.delete(assetPicker.previewCache.keys().next().value);
        assetPicker.previewCache.set(url,thumbnail);
      }
      if(controller.signal.aborted)return;picture.src=thumbnail;picture.hidden=false;preview.querySelector('span').hidden=true;
    }catch{if(controller.signal.aborted)return;preview.querySelector('span').textContent='预览暂不可用';}
  }
}
async function loadPickerAssets(){
  assetPicker.request?.abort();const controller=new AbortController();assetPicker.request=controller;assetPicker.loading=true;assetPicker.assets=[];$('reloadAssetsBtn').hidden=true;pickerStatus('正在读取素材库…');renderAssetPicker();
  try{
    const snapshot=await api('state',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});if(controller.signal.aborted)return;
    assetPicker.assets=(snapshot.assets||[]).filter(asset=>asset&&asset.id&&typeof asset.image==='string'&&asset.image&&!asset.archived);
    const keys=new Set(assetPicker.assets.map(assetKey));assetPicker.selected=new Set([...assetPicker.selected].filter(key=>keys.has(key)));
    pickerStatus(assetPicker.target==='fabric'?'选择一张面料参考，替换当前面料图；保留图片的原始质量。':'选中需要的图片，再点击“加入参考图库”。');
  }catch(error){if(controller.signal.aborted)return;pickerStatus(`读取素材库失败，请重新加载。${error.name==='TimeoutError'?'连接超时。':error.message}`,true);$('reloadAssetsBtn').hidden=false;}
  finally{if(!controller.signal.aborted){assetPicker.loading=false;renderAssetPicker();}}
}
function openAssetPicker(target='references'){
  if(!draftReady)return toast('正在恢复设计草稿，请稍候');if(importing||submitting)return toast('正在读取或提交，请稍候');
  assetPicker.target=target==='fabric'?'fabric':'references';
  if(!assetCapacity())return toast('已达到 10 张参考图，请先删除不用的图片');
  $('assetPickerTitle').textContent=assetPicker.target==='fabric'?'从素材库选择面料':'从素材库选择';
  $('assetPickerHint').textContent=assetPicker.target==='fabric'?'选择一张面料图，默认采用它的材质与颜色；可另行指定配色。':'可多选，使用素材库中当前的图片版本。';
  assetPicker.selected.clear();assetPicker.page=0;$('assetSearch').value='';$('assetCategory').value=assetPicker.target==='fabric'?'fabric':'';$('assetPicker').showModal();loadPickerAssets();
}
function closeAssetPicker(){if(!assetPicker.busy)$('assetPicker').close();}
async function importPickedAssets(){
  if(assetPicker.busy||assetPicker.loading||importing||!draftReady)return;
  const selected=assetPicker.assets.filter(asset=>assetPicker.selected.has(assetKey(asset))&&!assetImported(asset));if(!selected.length)return;
  if(selected.length>assetCapacity()){pickerStatus(`还可加入 ${assetCapacity()} 张，请减少选择。`,true);return;}
  assetPicker.busy=true;importing=true;updateClearButton();assetPicker.previews?.abort();$('fileInput').disabled=true;renderAssetPicker();assetPicker.previews?.abort();
  let added=0,persisted=true;const failed=[];
  try{
    for(const [index,asset] of selected.entries()){
      pickerStatus(`正在加入 ${index+1} / ${selected.length}：${asset.name||'未命名素材'}`);
      try{
        const response=await fetch(assetFileUrl(asset.image),{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(response.status===404?'图片已不存在，请重新选择素材':`读取失败（${response.status}）`);
        const blob=await response.blob();if(blob.size>50*1024*1024)throw new Error('超过 50 MB');if(!/^image\/(png|jpe?g|webp)$/i.test(blob.type))throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
        // FileReader preserves the selected original/cleaned version. Never use preview bytes here.
        const src=await readFile(blob),preview=await displayThumbnail(src),image={id:crypto.randomUUID(),name:asset.name||'未命名素材',src,...preview,type:'library',sourceAssetId:asset.id,sourceImageUrl:asset.image};
        if(assetPicker.target==='fabric'){
          state.styleImages.fabric={...image,type:'style',styleKind:'fabric'};state.styleModes.fabric='image';$('fabricMode').value='image';
        }else{
          state.images.push(image);if(!state.activeImageId)state.activeImageId=image.id;if(!state.primaryImageId)state.primaryImageId=image.id;
        }
        assetPicker.selected.delete(assetKey(asset));added+=1;renderAll();pickerControls();
      }catch(error){failed.push(`${asset.name||'未命名素材'}：${error.name==='TimeoutError'?'读取超时':error.message}`);}
    }
    if(added){await saveDraft();persisted=savedRevision===draftRevision;}
  }finally{
    assetPicker.busy=false;importing=false;updateClearButton();$('fileInput').disabled=false;renderAssetPicker();
    if(!persisted)pickerStatus(`已加入 ${added} 张，但本机草稿保存失败，请勿刷新或关闭页面。${failed.length?`未加入：${failed.join('；')}`:''}`,true);
    else if(failed.length)pickerStatus(`${added?`已加入 ${added} 张。`:''}以下素材未加入，可重试：${failed.join('；')}`,true);
    else{closeAssetPicker();toast(assetPicker.target==='fabric'?'已设置面料参考，生成时使用所选图片的原始质量。':`已从素材库加入 ${added} 张参考图`);}
  }
}
for(const [value,label] of Object.entries(assetCategories)){const option=node('option','',label);option.value=value;$('assetCategory').append(option);}
$('openAssetPickerBtn').onclick=()=>openAssetPicker();$('closeAssetPickerBtn').onclick=closeAssetPicker;$('cancelAssetPickerBtn').onclick=closeAssetPicker;$('addAssetsBtn').onclick=importPickedAssets;$('reloadAssetsBtn').onclick=loadPickerAssets;
for(const id of ['assetSearch','assetCategory'])$(id).addEventListener('input',()=>{assetPicker.page=0;renderAssetPicker();});
$('assetPrevBtn').onclick=()=>{assetPicker.page-=1;renderAssetPicker();};$('assetNextBtn').onclick=()=>{assetPicker.page+=1;renderAssetPicker();};
$('assetPicker').addEventListener('cancel',event=>{if(assetPicker.busy)event.preventDefault();});
$('assetPicker').addEventListener('close',()=>{assetPicker.request?.abort();assetPicker.previews?.abort();assetPicker.selected.clear();$('assetPickerGrid').replaceChildren();});
