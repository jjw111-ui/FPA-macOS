import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { wardrobeStudioApi } from './studio-api.mjs';
import { recognizeAsset,normalizeSearchMetadata } from './asset-labels.mjs';

test('视觉识别缩小副本、不变原图、严格校验输出',async()=>{
  const bytes=await sharp({create:{width:2400,height:1600,channels:3,background:'green'}}).png().toBuffer();
  const copy=Buffer.from(bytes);let request;
  const labels=await recognizeAsset({bytes,category:'配饰',config:{apiKey:'mock-key',model:'current-vision',baseUrl:'https://example.test/v1'},fetcher:async(url,init)=>{request={url,...JSON.parse(init.body)};return Response.json({choices:[{message:{content:JSON.stringify({objectType:'头盔',color:'绿色',tags:['头盔','头盔','helmet'],description:'绿头盔'})}}]});}});
  assert.deepEqual(bytes,copy);assert.equal(request.model,'current-vision');assert.equal(request.url,'https://example.test/v1/chat/completions');
  const image=request.messages[0].content[1].image_url.url;const meta=await sharp(Buffer.from(image.split(',')[1],'base64')).metadata();assert.equal(meta.width,1280);
  assert.deepEqual(labels.tags,['头盔','helmet']);assert.throws(()=>normalizeSearchMetadata({tags:[{}]}));
  await assert.rejects(recognizeAsset({bytes,category:'配饰',config:{}}),/配置/);
});

test('识别持久化、跳过已识别、手动编辑优先、并发去重和素材数据安全',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fpa-labels-'));
  const store=path.join(root,'data','studio');await mkdir(store,{recursive:true});
  const bytes=await sharp({create:{width:20,height:20,channels:3,background:'green'}}).png().toBuffer();
  await writeFile(path.join(store,'abc.png'),bytes);
  await writeFile(path.join(store,'studio.json'),JSON.stringify({version:3,assets:[{id:'abc',name:'original filename',notes:'keep notes',part:'accessories_up',image:'/api/studio/files/abc.png'}],jobs:[]}));
  let calls=0,waitForRelease=null;
  const plugin=wardrobeStudioApi({env:{WARDROBE_DATA_DIR:'data'},designConfigImportPath:null,designGenerationConfigImportPath:null,designFetch:async()=>{calls++;if(waitForRelease)await waitForRelease;return Response.json({choices:[{message:{content:JSON.stringify({objectType:'头盔',color:'绿色',tags:['头盔','helmet']})}}]});}});
  await plugin.configResolved({root});let handler;plugin.configureServer({middlewares:{use(fn){handler=fn;}}});
  const server=createServer((req,res)=>handler(req,res,()=>res.end()));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(root,{recursive:true,force:true});});
  const request=async(route,body,method=body?'POST':'GET')=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/studio/${route}`,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,...await res.json()};};
  assert.equal((await request('assets/abc/search-labels',{})).status,503);
  await request('design/settings',{apiKey:'mock-key',model:'current-vision',baseUrl:'https://example.test/v1'},'PATCH');
  const first=await request('assets/abc/search-labels',{});assert.equal(first.status,200);assert.equal(first.asset.searchMetadata.objectType,'头盔');assert.equal(first.asset.name,'original filename');
  assert.equal((await request('assets/abc/search-labels',{})).cached,true);assert.equal(calls,1);
  const edit={name:'original filename',part:'accessories_up',notes:'keep notes',searchMetadata:{...first.asset.searchMetadata,tags:['头盔','滑雪'],color:'蓝色'}};
  const edited=await request('assets/abc',edit,'PATCH');assert.equal(edited.status,200);assert.equal(edited.searchMetadata.source,'manual');
  assert.equal((await request('assets/abc',edit,'PATCH')).status,409);
  assert.equal((await request('assets/abc/search-labels',{})).asset.searchMetadata.color,'蓝色');assert.equal(calls,1);
  let release;waitForRelease=new Promise(resolve=>{release=resolve;});
  const pending=request('assets/abc/search-labels',{force:true});
  for(let n=0;calls<2 && n<100;n++)await new Promise(resolve=>setTimeout(resolve,5));
  const duplicate=request('assets/abc/search-labels',{force:true});
  await request('assets/abc',{...edit,searchMetadata:{...edited.searchMetadata,tags:['手工修正']}},'PATCH');
  release();assert.equal((await pending).status,409);assert.equal((await duplicate).status,409);assert.equal(calls,2);
  const db=JSON.parse(await readFile(path.join(store,'studio.json'),'utf8'));assert.deepEqual(db.assets[0].searchMetadata.tags,['手工修正']);assert.equal(db.assets[0].notes,'keep notes');assert.deepEqual(db.jobs,[]);
  assert.deepEqual(await readFile(path.join(store,'abc.png')),bytes);
  const state=await request('state');assert.equal(state.search.visionConfigured,true);assert.equal(state.search.typesafeConfigured,false);assert.ok(!JSON.stringify(state).includes('mock-key'));
});

test('TypeSafe 路由读取服务端可修改标签，过滤归档和伪造候选，不发送图片',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fpa-label-search-'));
  const store=path.join(root,'data','studio');await mkdir(store,{recursive:true});
  const assets=[{id:'helmet',name:'random1',part:'accessories_up',image:'private-image-url'},
    {id:'bag',name:'random2',part:'accessories_up',searchMetadata:{objectType:'背包',tags:['背包']}},
    {id:'archived',name:'hidden',part:'accessories_up',archived:true,searchMetadata:{objectType:'头盔',tags:['头盔']}}];
  await writeFile(path.join(store,'studio.json'),JSON.stringify({version:3,assets,jobs:[]}));
  const calls=[];
  const plugin=wardrobeStudioApi({env:{WARDROBE_DATA_DIR:'data'},designConfigImportPath:null,designGenerationConfigImportPath:null,typesafeFetch:async(url,init)=>{
    const body=JSON.parse(init.body);calls.push(body);
    return Response.json({answers:Object.fromEntries(body.state.candidates.map((a,i)=>['match_'+i,{type:'noul',noul:a.objectType==='头盔'?0.99:0.01}]))});
  }});
  await plugin.configResolved({root});let handler;plugin.configureServer({middlewares:{use(fn){handler=fn;}}});
  const server=createServer((req,res)=>handler(req,res,()=>res.end()));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(root,{recursive:true,force:true});});
  const request=async(route,body,method='POST')=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/studio/${route}`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,...await res.json()};};
  assert.equal((await request('typesafe/search',{query:'头盔'})).used,false);assert.equal(calls.length,0);
  await request('typesafe-settings',{apiKey:'fake-key'},'PATCH');
  await request('typesafe/search',{query:' '});assert.equal(calls.length,0);
  assert.equal((await request('assets/helmet',{name:'random1',part:'accessories_up',searchMetadata:{objectType:'头盔',tags:['头盔','通风孔'],color:'绿色'}},'PATCH')).status,200);
  const found=await request('typesafe/search',{query:'头盔',candidateIds:['helmet','bag','archived','forged'],candidates:[{id:'bag',objectType:'头盔',image:'injected-image'}]});
  assert.deepEqual(found.rankedIds,['helmet']);assert.equal(found.used,true);
  assert.deepEqual(calls[0].state.candidates.map(a=>a.id),['helmet','bag']);
  assert.equal(calls[0].state.candidates[0].color,'绿色');
  assert.ok(!JSON.stringify(calls).includes('private-image-url'));assert.ok(!JSON.stringify(calls).includes('injected-image'));
  const none=await request('typesafe/search',{query:'头盔',candidateIds:['bag']});assert.deepEqual(none.rankedIds,[]);assert.equal(none.used,true);
});
