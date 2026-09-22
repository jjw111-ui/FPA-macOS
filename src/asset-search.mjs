export const SEARCH_PARTS = { upperbody: '上衣', wholebody_up: '外套', lowerbody: '下装', dress: '内搭', shoes: '鞋子', accessories_up: '配饰', fabric: '面料', trims: '辅料', person: '人物体型', face: '人物人脸', pose: '人物姿势', scene: '场景' };
const groups = [
  ['头盔','helmet','headgear'], ['背包','双肩包','backpack'], ['包','手袋','bag','handbag'], ['手套','gloves'], ['帽子','帽','hat','cap'],
  ['登山杖','手杖','trekking poles'], ['夹克','jacket'], ['外套','coat'], ['衬衫','shirt'], ['卫衣','hoodie'], ['毛衣','sweater'],
  ['裤子','长裤','裤','pants','trousers'], ['短裤','shorts'], ['牛仔','denim'], ['裙子','半裙','skirt'], ['鞋','鞋子','shoes'], ['拉链','zipper'], ['纽扣','button'],
  ['黑色','黑','black'], ['白色','白','white'], ['灰色','灰','gray','grey'], ['蓝色','蓝','blue'], ['绿色','绿','green'], ['黄色','黄','yellow'],
  ['红色','红','red'], ['棕色','棕','brown'], ['粉色','粉','pink'], ['紫色','紫','purple'], ['橙色','橙','orange'],
  ['尼龙','nylon'], ['棉','cotton'], ['皮革','leather'], ['金属','metal'], ['针织','knit'], ['防水','waterproof'],
];
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().trim();
const includes = (value, term) => /[a-z]/i.test(term) ? new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(value) : value.includes(term);
export function currentSearchMetadata(asset) {
  const meta = asset.searchMetadata;
  return meta && (!meta.sourceImage || meta.sourceImage === asset.image) ? meta : {};
}
export function needsSearchLabels(asset) {
  const meta = currentSearchMetadata(asset);
  return !meta.updatedAt;
}
export function searchDocument(asset) {
  const meta = currentSearchMetadata(asset);
  return {
    id: asset.id, name: asset.name || '', category: SEARCH_PARTS[asset.part] || '',
    objectType: meta.objectType || '', color: meta.color ?? asset.color ?? '', material: meta.material ?? asset.material ?? asset.fabric ?? '',
    secondaryColor: asset.secondaryColor || '', tags: meta.tags ?? (Array.isArray(asset.tags) ? asset.tags : []),
    description: meta.description || '', notes: asset.notes || '',
  };
}
export function searchFingerprint(assets) { return JSON.stringify(assets.map(searchDocument)); }
export function localAssetSearch(query, assets, category = 'all', tab = 'library') {
  const base = assets.filter(a => !a.archived && (category === 'all' || a.part === category) && (tab !== 'compose' || !['fabric','trims'].includes(a.part)));
  let remainder = normalize(query);
  if (!remainder) return { base, list: base };
  const clauses = [];
  // Longest terms first: "背包" must not be reduced to the much broader "包".
  const terms = groups.flatMap(group => group.map(term => ({ term, group }))).sort((a,b) => b.term.length-a.term.length);
  for (const {term, group} of terms) if (includes(remainder,term)) {
    clauses.push(group); remainder = remainder.replaceAll(term,' ');
  }
  remainder = remainder.replace(/(我想找|我想要|帮我找|找一下|请帮我|有没有|素材|的|一个|一件|一些)/g,' ');
  clauses.push(...remainder.split(/[\s,，、。；;|/]+/).filter(Boolean).map(term=>[term]));
  const matches = base.filter(asset => {
    const doc = searchDocument(asset);
    const haystack = normalize([doc.name,doc.category,doc.objectType,doc.color,doc.secondaryColor,doc.material,doc.description,doc.notes,...doc.tags].join(' '));
    return clauses.length > 0 && clauses.every(group => group.some(term => includes(haystack,term)));
  });
  return { base, list: matches };
}

export function applySemanticResult(local, result) {
  if (!result?.used) return local.list;
  const available = new Map(local.base.map(asset => [asset.id, asset]));
  return [...new Set(result.rankedIds || [])].map(id => available.get(id)).filter(Boolean);
}
