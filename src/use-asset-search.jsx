import { useEffect, useMemo, useState } from 'react';
import { localAssetSearch, searchFingerprint, applySemanticResult } from './asset-search.mjs';

export function useAssetSearch({query,assets,category,tab,configured,composing}) {
  const local=useMemo(()=>localAssetSearch(query,assets,category,tab),[query,assets,category,tab]);
  const fingerprint=useMemo(()=>searchFingerprint(local.base),[local.base]);
  const normalized=query.trim();
  const active=['library','compose'].includes(tab);
  const key=JSON.stringify([normalized,category,tab,configured,fingerprint]);
  const [remote,setRemote]=useState(null);
  useEffect(()=>{
    if(!normalized || !configured || !active || composing) return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      setRemote({key,loading:true});
      try {
        const response=await fetch('/api/studio/typesafe/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:normalized,candidateIds:JSON.parse(fingerprint).map(a=>a.id)}),signal:controller.signal});
        const data=await response.json();
        if(!response.ok) throw new Error(data.error || '语义检索暂不可用，显示本地结果。');
        if(!controller.signal.aborted)setRemote({key,...data});
      } catch(error) {
        if(!controller.signal.aborted)setRemote({key,error:error.message});
      }
    },800);
    return()=>{clearTimeout(timer);controller.abort();};
  },[key,normalized,configured,active,composing,fingerprint]);
  const current=remote?.key===key ? remote : null;
  const message=!configured ? '本地标签检索 · TypeSafe 未配置' : current?.loading ? '语义检索中 · 先显示本地结果' : current?.error || (current?.used ? 'TypeSafe 语义筛选' : '本地标签检索');
  return {...local,list:applySemanticResult(local,current),message};
}
