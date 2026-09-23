// Candidate narrowing is never evidence that an answer is responsive.
export const words = (s) => (String(s ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(w=>w.replace(/(?:ing|ion|ed|e|s)$/,''));
const STOP = new Set(words('the a an your you is are what do to of in for would could can have has how which where when does did tell us about applicant candidate please and or with this that it be if as at on from their they most'));
export function canonCandidatesFor(q, canon) {
  const all = canon?.questions ?? canon ?? [];
  const labelTokens = new Set(words(q.label).filter(w=>!STOP.has(w)));
  const helpTokens = new Set(words(q.help??'').filter(w=>!STOP.has(w)));
  const ranked = all.map((row, index) => {
    const tokens=[...new Set(words(`${row.text} ${(row.surface_forms??[]).join(' ')}`))];
    return {row,index,score:tokens.filter(w=>labelTokens.has(w)).length*8+tokens.filter(w=>helpTokens.has(w)).length};
  });
  ranked.sort((a,b) => b.score-a.score || a.index-b.index);
  return ranked.slice(0,16).map(x => x.row);
}
const QUALIFIERS = [
  ['llm', /\bllms?\b|large language model/i], ['gpu', /\bgpus?\b|cuda/i],
  ['distributed systems', /distributed systems?/i], ['production', /\bproduction\b/i],
  ['leadership', /\bleadership\b|led a team/i], ['machine learning', /machine learning|\bml\b/i],
];
export function qualifiersIn(q) { return QUALIFIERS.filter(([,re]) => re.test(`${q.label} ${q.help ?? ''}`)).slice(0,3).map(([text]) => text); }
export function parentCandidates(q, questions) {
  const index = questions.findIndex(row => row.qid === q.qid);
  return questions.slice(Math.max(0,index-8), index);
}
export function itemCandidates(mem, kind, canonical=null) {
  const items = mem.items ?? [];
  const tags = new Set(words(canonical?.text ?? canonical ?? ''));
  const overlaps = item => item.id===canonical?.qid || item.answers_questions.some(q=>words(q).filter(w=>!STOP.has(w)).some(w=>tags.has(w)));
  const narrowed = items.filter(item => kind==='narrative' || item.kinds.includes(kind) || overlaps(item));
  return narrowed.length ? narrowed : items;
}
export function rankItemCandidates(items,q,canonical=null) {
  const canonTokens=new Set(words(canonical?.text??'').filter(w=>!STOP.has(w)));
  const query=new Set(words(`${q.label} ${q.help??''} ${canonical?.text??''}`).filter(w=>!STOP.has(w)));
  const ranked=items.map((item,index)=>{
    const tags=new Set(words(item.answers_questions.join(' ')).filter(w=>!STOP.has(w)));
    return {item,index,overlap:item.id===(canonical?.qid??canonical?.id)||[...tags].some(w=>canonTokens.has(w)),score:[...tags].filter(w=>query.has(w)).length};
  }).sort((a,b)=>b.score-a.score||a.index-b.index);
  if(!ranked.some(r=>r.score))return items;
  const retained=new Set([...ranked.slice(0,12),...ranked.filter(r=>r.overlap)].map(r=>r.item));
  return ranked.filter(r=>retained.has(r.item)).map(r=>r.item);
}
