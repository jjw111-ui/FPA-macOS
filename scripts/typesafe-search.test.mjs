import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTypeSafeSearchService,parseResult,DEFAULT_ENDPOINT,MATCH_THRESHOLD } from './typesafe-search.mjs';
import { localAssetSearch,applySemanticResult,currentSearchMetadata,searchFingerprint } from '../src/asset-search.mjs';
const sample=[
  {id:'helmet',name:'random-1',part:'accessories_up',searchMetadata:{objectType:'头盔',color:'绿色',tags:['helmet','通风孔']}},
  {id:'bag',name:'random-2',part:'accessories_up',searchMetadata:{objectType:'背包',color:'白色',tags:['backpack']}},
  {id:'glove',name:'random-3',part:'accessories_up',searchMetadata:{objectType:'手套',color:'黑色',tags:['gloves']}},
  {id:'unknown',name:'abcdef123',part:'accessories_up'},
];
test('本地标签检索区分头盔/背包/手套，属性为交集，不以大类兜底',()=>{
  for(const query of ['头盔','helmet','绿色头盔'])assert.deepEqual(localAssetSearch(query,sample).list.map(a=>a.id),['helmet']);
  assert.deepEqual(localAssetSearch('背包',sample).list.map(a=>a.id),['bag']);
  assert.equal(localAssetSearch('黑色头盔',sample).list.length,0);
  assert.equal(localAssetSearch('头盔',[sample[3]]).list.length,0);
  assert.equal(localAssetSearch('头盔',sample,'fabric').list.length,0);
  assert.equal(localAssetSearch('',sample).list.length,4);
  for(const query of ['a[','a(','a.*','a+']) assert.doesNotThrow(()=>localAssetSearch(query,sample));
  assert.equal(localAssetSearch('a.*',sample).list.length,0);
  const local=localAssetSearch('头盔',sample);
  assert.deepEqual(applySemanticResult(local,{used:true,rankedIds:[]}),[]);
  assert.deepEqual(applySemanticResult(local,{used:true,rankedIds:['bogus','helmet','helmet']}).map(a=>a.id),['helmet']);
  assert.deepEqual(applySemanticResult(local,{used:false}),local.list);
  assert.notEqual(searchFingerprint(sample),searchFingerprint(sample.map(a=>({...a,searchMetadata:{tags:['changed']}}))));
  assert.deepEqual(currentSearchMetadata({image:'new',searchMetadata:{sourceImage:'old',tags:['old']}}),{});
});
const temp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'fpa-typesafe-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
test('独立密钥脱敏保存，空查询不调用，逐项过滤、多匹配及缓存',async t=>{
  const calls=[];
  const service=createTypeSafeSearchService({fetch:async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body,auth:init.headers.Authorization});return Response.json({answers:Object.fromEntries(body.state.candidates.map((a,i)=>['match_'+i,{type:'noul',noul:a.id.startsWith('helmet')?0.94:0.03}]))});}});
  await service.init(await temp(t));
  assert.equal(service.settings().configured,false);
  await service.search({query:' ',candidates:[]});assert.equal(calls.length,0);
  await assert.rejects(service.search({query:'头盔',candidates:[{id:'a'}]}),/系统设置/);
  await service.updateSettings({apiKey:'fake-key-1234'});
  assert.equal(service.settings().maskedKey,'••••1234');assert.ok(!JSON.stringify(service.settings()).includes('fake-key'));
  const candidates=[{id:'helmet1',objectType:'头盔',image:'private-image',imageDataUrl:'data:secret'},{id:'bag',objectType:'背包'},{id:'helmet2',objectType:'头盔'}];
  const [one,two]=await Promise.all([service.search({query:'头盔',candidates}),service.search({query:'头盔',candidates})]);
  assert.deepEqual(one.rankedIds,['helmet1','helmet2']);assert.deepEqual(one,two);assert.equal(calls.length,1);
  assert.equal((await service.search({query:'头盔',candidates})).cached,true);assert.equal(calls.length,1);
  assert.equal(calls[0].url,DEFAULT_ENDPOINT);assert.equal(calls[0].auth,'Bearer fake-key-1234');
  assert.equal(calls[0].body.questions.match_0.type,'noul');assert.ok(calls[0].body.questions.match_0.instructions.includes('candidates[0]'));
  assert.ok(!JSON.stringify(calls[0].body).includes('private-image'));assert.ok(!JSON.stringify(calls[0].body).includes('data:secret'));
  await service.search({query:'头盔',candidates:[{...candidates[0],color:'blue'}]});assert.equal(calls.length,2);
  await service.updateSettings({clearKey:true});assert.equal(service.settings().configured,false);
});
test('TypeSafe 返回空结果、低分和坏响应不混入素材',()=>{
  const result=parseResult({answers:{match_0:{type:'noul',noul:0},match_1:{type:'noul',noul:MATCH_THRESHOLD-0.01}}},[{id:'a'},{id:'b'}]);
  assert.deepEqual(result.rankedIds,[]);
  for(const bad of [null,{}, {answers:{match_0:{type:'noul',noul:2}}}, {answers:{match_0:{type:'noul',noul:'1'}}}])assert.throws(()=>parseResult(bad,[{id:'a'}]),/不完整/);
});
test('TypeSafe 失败不自动重试也不缓存失败',async t=>{
  let count=0,status=429;
  const service=createTypeSafeSearchService({fetch:async()=>{count++;return Response.json({error:'sensitive detail'},{status});}});
  await service.init(await temp(t));await service.updateSettings({apiKey:'fake-key'});
  for(status of [401,422,429,529]) await assert.rejects(service.search({query:'头盔',candidates:[{id:'a'}]}),e=>!e.message.includes('sensitive'));
  assert.equal(count,4);
});

test('超过一批完整处理，超过候选上限明确报错，超时不重试',async t=>{
  const batches=[];
  const service=createTypeSafeSearchService({fetch:async(url,init)=>{
    const body=JSON.parse(init.body);batches.push(body.state.candidates.length);
    return Response.json({answers:Object.fromEntries(body.state.candidates.map((a,i)=>['match_'+i,{type:'noul',noul:0.95}]))});
  }});
  await service.init(await temp(t));await service.updateSettings({apiKey:'fake-key'});
  const candidates=Array.from({length:65},(_,i)=>({id:'candidate-'+i,objectType:'头盔'}));
  const result=await service.search({query:'头盔',candidates});
  assert.equal(result.rankedIds.length,65);assert.deepEqual(batches,[32,32,1]);
  await assert.rejects(service.search({query:'头盔',candidates:Array.from({length:257},(_,i)=>({id:String(i)}))}),/256/);
  let calls=0;
  const timeout=createTypeSafeSearchService({timeoutMs:10,fetch:async(url,{signal})=>{
    calls++;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});
  }});
  await timeout.init(await temp(t));await timeout.updateSettings({apiKey:'fake-key'});
  await assert.rejects(timeout.search({query:'头盔',candidates:[candidates[0]]}),/超时/);assert.equal(calls,1);
});
