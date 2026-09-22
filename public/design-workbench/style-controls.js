/* Style reference originals are separate from the apparel reference canvas. */
'use strict';
const styleRoles={fabric:'面料参考',color:'配色参考'};
const styleModes={fabric:['primary','image','text'],color:['auto','primary','image','custom','text']};
const styleText=id=>String($(id)?.value||'').trim();
function styleBusy(){return typeof importing!=='undefined'&&importing||typeof submitting!=='undefined'&&submitting||typeof draftReady!=='undefined'&&!draftReady;}
function normalizeStyleHex(value){const text=String(value||'').trim();const match=text.match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i);if(!match)return '';const digits=match[1];return '#'+(digits.length===3?[...digits].map(character=>character+character).join(''):digits).toUpperCase();}
function activeStyleMode(kind){const mode=$(kind+'Mode')?.value||state.styleModes[kind];return styleModes[kind].includes(mode)?mode:kind==='color'?'auto':'primary';}
function getDesignStyle(){
  const style={version:2,fabric:{mode:activeStyleMode('fabric')},color:{mode:activeStyleMode('color')}};
  if(style.fabric.mode!=='primary'&&styleText('fabric'))style.fabric.text=styleText('fabric');
  if(!['primary','auto'].includes(style.color.mode)&&styleText('colorText'))style.color.text=styleText('colorText');
  if(style.color.mode==='custom')style.color.hex=normalizeStyleHex(styleText('colorHex'));
  return style;
}
function getStyleReferences(){return ['fabric','color'].flatMap(kind=>{const image=state.styleImages[kind];return activeStyleMode(kind)==='image'&&image?.src?[{id:image.id,name:image.name,role:styleRoles[kind],imageDataUrl:image.src,regions:[]}]:[];});}
function styleImageCount(){return Object.values(state.styleImages).filter(Boolean).length;}
function getStyleDraft(){return {version:2,fabric:{mode:activeStyleMode('fabric'),text:$('fabric')?.value||''},color:{mode:activeStyleMode('color'),text:$('colorText')?.value||'',hex:$('colorHex')?.value||''}};}
function restoreStyleDraft(draft){
  const saved=draft?.style||{};
  for(const kind of ['fabric','color']){
    let mode=styleModes[kind].includes(saved[kind]?.mode)?saved[kind].mode:kind==='color'?'auto':'primary';
    // Older drafts used primary as their automatic default, even with a fabric image.
    if(kind==='color'&&saved.version!==2&&mode==='primary')mode='auto';
    state.styleModes[kind]=mode;if($(kind+'Mode'))$(kind+'Mode').value=mode;
  }
  if($('fabric'))$('fabric').value=typeof saved.fabric?.text==='string'?saved.fabric.text:'';
  if($('colorText'))$('colorText').value=typeof saved.color?.text==='string'?saved.color.text:'';
  if($('colorHex'))$('colorHex').value=typeof saved.color?.hex==='string'?saved.color.hex:'';
  const hex=normalizeStyleHex(saved.color?.hex);if(hex&&$('colorPicker'))$('colorPicker').value=hex;
  renderStyleControls();
}
function resetStyleReferences(){const previous={...state.styleImages};state.styleImages={fabric:null,color:null};renderStyleControls();return previous;}
function validateDesignStyle(){
  const style=getDesignStyle();
  for(const kind of ['fabric','color']){
    const label=kind==='fabric'?'面料':'配色';
    if(style[kind].mode==='image'&&!state.styleImages[kind]?.src)return `请上传${label}参考图，或切换${label}方式。`;
    if(style[kind].mode==='text'&&!style[kind].text)return `请填写${label}说明。`;
  }
  if(style.color.mode==='custom'&&!style.color.hex)return '请选择颜色，或填写有效的 HEX 色值，例如 #708A76。';
  const references=getStyleReferences();if(state.images.length+references.length>10)return '款式、面料和配色参考合计最多 10 张，请移除不用的图片。';
  const urls=[...state.images.map(image=>image.src),...references.map(image=>image.imageDataUrl)];
  const bytes=urls.reduce((total,src)=>{const data=String(src||'').split(',')[1]||'';return total+Math.max(0,Math.floor(data.length*3/4)-(data.endsWith('==')?2:data.endsWith('=')?1:0));},0);
  if(bytes>128*1024*1024)return '本次参考原图合计超过 128 MB，请移除不用的图片。';
  return '';
}
function renderStyleControls(){
  if(!$('styleControls')?.dataset.ready)return;
  for(const kind of ['fabric','color']){
    const mode=activeStyleMode(kind),image=state.styleImages[kind];state.styleModes[kind]=mode;
    $(kind+'PrimaryHint').hidden=!['primary','auto'].includes(mode);$(kind+'ImageFields').hidden=mode!=='image';
    $(kind+'TextField').hidden=['primary','auto'].includes(mode);
    $(kind+'TextLabel').textContent=mode==='text'?`${kind==='fabric'?'面料':'配色'}说明`:'补充说明（可选）';
    $(kind+'PreviewBox').hidden=!image;$(kind+'UploadLabel').textContent=image?'更换参考图':'上传参考图';
    const preview=$(kind+'Preview');if(image){if(preview.dataset.imageId!==image.id){preview.src=image.thumbnail||image.src;preview.dataset.imageId=image.id;}$(kind+'ImageName').textContent=image.name;}else{preview.removeAttribute('src');delete preview.dataset.imageId;}
    $(kind+'ImageInput').disabled=styleBusy();$(kind+'RemoveImage').disabled=styleBusy();
    if($(kind+'LibraryBtn'))$(kind+'LibraryBtn').disabled=styleBusy();
  }
  const fabricColor=activeStyleMode('fabric')==='image'&&Boolean(state.styleImages.fabric);
  $('colorMode').querySelector('option[value="auto"]').textContent=fabricColor?'自动（跟随面料颜色）':'自动（有面料图则跟随）';
  $('colorPrimaryHint').textContent=activeStyleMode('color')==='auto'
    ?fabricColor?'跟随面料图的真实颜色，衣身、袖子、领口和口袋等面料部位统一应用；明确指定的局部保留颜色除外。':'选择面料图后自动采用面料颜色；未选面料图时沿用主体款式配色。'
    :'已指定沿用主体款式配色，面料图仅影响材质与纹理。';
  $('colorCustomFields').hidden=activeStyleMode('color')!=='custom';
}
async function uploadStyleImage(kind,file){
  if(!file)return;if(styleBusy())return toast('正在读取或提交，请稍候再添加参考图。');
  if(!/^image\/(png|jpe?g|webp)$/i.test(file.type))return toast('请使用 PNG、JPEG 或 WebP 图片。');
  if(file.size>50*1024*1024)return toast('单张原图不能超过 50 MB。');
  if(!state.styleImages[kind]&&state.images.length+styleImageCount()>=10)return toast('款式、面料和配色参考合计最多 10 张，请先移除不用的图片。');
  importing=true;updateClearButton();renderStyleControls();
  try{
    const src=await readFile(file),preview=await displayThumbnail(src);
    if(preview.width>16384||preview.height>16384||preview.width*preview.height>64*1024*1024)throw new Error('原图超过尺寸上限，请使用单边 16384 像素、总像素 6710 万以内的图片。');
    state.styleImages[kind]={id:crypto.randomUUID(),name:file.name,src,...preview,type:'style',styleKind:kind,originalBytes:file.size};
    state.styleModes[kind]='image';$(kind+'Mode').value='image';
    renderStyleControls();compile();toast(`已添加${kind==='fabric'?'面料':'配色'}参考图，生成时使用原图。`);
  }catch(error){toast(error.message);}finally{importing=false;$(kind+'ImageInput').value='';renderStyleControls();updateClearButton();}
}
function initStyleControls(){
  const host=$('styleControls');if(!host||host.dataset.ready)return;
  host.innerHTML=`<section class="style-control" aria-labelledby="fabricStyleTitle">
    <div class="section-label" id="fabricStyleTitle">面料</div>
    <label class="style-mode-label" for="fabricMode">面料方式</label><select class="select" id="fabricMode"><option value="primary">沿用主体款式</option><option value="image">参考图片</option><option value="text">文字描述</option></select>
    <p class="style-hint" id="fabricPrimaryHint">沿用主体款式的面料，可通过局部标注调整。</p>
    <div id="fabricImageFields" hidden><label class="style-upload" for="fabricImageInput"><input id="fabricImageInput" type="file" accept="image/png,image/jpeg,image/webp"><span id="fabricUploadLabel">上传参考图</span></label><button class="btn library-picker-button" id="fabricLibraryBtn" type="button">从素材库选择面料</button><div class="style-preview" id="fabricPreviewBox" hidden><img id="fabricPreview" alt="面料参考图"><div><span id="fabricImageName"></span><button class="tool" type="button" id="fabricRemoveImage">移除面料图</button></div></div><p class="style-hint">默认采用面料的颜色、纹理与质感，保持款式结构。可在下方配色设置中另行指定颜色。</p></div>
    <div class="field style-text" id="fabricTextField" hidden><label id="fabricTextLabel" for="fabric">面料说明</label><textarea class="textarea" id="fabric" rows="2" maxlength="2000" placeholder="例如：细密棉斜纹，柔软哑光；仅用于衣身"></textarea></div>
  </section><section class="style-control" aria-labelledby="colorStyleTitle">
    <div class="section-label" id="colorStyleTitle">配色</div>
    <label class="style-mode-label" for="colorMode">配色方式</label><select class="select" id="colorMode"><option value="auto">自动（有面料图则跟随）</option><option value="primary">沿用主体款式</option><option value="image">参考图片</option><option value="custom">自选颜色</option><option value="text">文字描述</option></select>
    <p class="style-hint" id="colorPrimaryHint">选择面料图后自动采用面料颜色；未选面料图时沿用主体款式配色。</p>
    <div id="colorImageFields" hidden><label class="style-upload" for="colorImageInput"><input id="colorImageInput" type="file" accept="image/png,image/jpeg,image/webp"><span id="colorUploadLabel">上传参考图</span></label><div class="style-preview" id="colorPreviewBox" hidden><img id="colorPreview" alt="配色参考图"><div><span id="colorImageName"></span><button class="tool" type="button" id="colorRemoveImage">移除配色图</button></div></div><p class="style-hint">只参考颜色关系，不复制款式或背景。</p></div>
    <div class="style-custom-color" id="colorCustomFields" hidden><label for="colorPicker">选取颜色<input id="colorPicker" type="color" value="#808080"></label><label for="colorHex">HEX 色值<input class="input" id="colorHex" maxlength="7" placeholder="#708A76" autocomplete="off" spellcheck="false"></label></div>
    <div class="field style-text" id="colorTextField" hidden><label id="colorTextLabel" for="colorText">配色说明</label><textarea class="textarea" id="colorText" rows="2" maxlength="2000" placeholder="例如：米白为主色，领口和袖口用深绿色"></textarea></div>
  </section>`;
  host.dataset.ready='true';
  $('fabricLibraryBtn').onclick=()=>openAssetPicker('fabric');
  for(const kind of ['fabric','color']){
    $(kind+'Mode').addEventListener('change',()=>{state.styleModes[kind]=$(kind+'Mode').value;renderStyleControls();compile();});
    $(kind+'ImageInput').addEventListener('change',event=>uploadStyleImage(kind,event.target.files[0]));
    $(kind+'RemoveImage').onclick=()=>{if(styleBusy())return;state.styleImages[kind]=null;renderStyleControls();compile();updateClearButton();};
  }
  for(const id of ['fabric','colorText'])$(id).addEventListener('input',()=>compile());
  $('colorHex').addEventListener('input',()=>{const hex=normalizeStyleHex($('colorHex').value);if(hex)$('colorPicker').value=hex;compile();});
  $('colorHex').addEventListener('change',()=>{const hex=normalizeStyleHex($('colorHex').value);if(hex)$('colorHex').value=hex;compile();});
  $('colorPicker').addEventListener('input',()=>{$('colorHex').value=$('colorPicker').value.toUpperCase();compile();});
  renderStyleControls();
}
