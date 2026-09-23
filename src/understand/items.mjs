import {resolvePreference} from '../memory/resolve.mjs';
import {parseScope,scopeRank} from '../memory/schema.mjs';
import {slugify} from '../config.mjs';
import {itemText,questionTags} from '../memory/enrich.mjs';
import {pickVariant} from '../schema/classes.mjs';
const EEO_QUESTIONS={
  gender:['What is your gender or gender identity?'],race:['What is your race or ethnicity?'],
  hispanic_latino:['Are you Hispanic or Latino?'],veteran_status:['What is your military or veteran status?'],
  disability_status:['What is your disability status?'],pronouns:['What pronouns do you use?'],
  other_demographics:['What is your age?','Do you identify as transgender?','What is your sexual orientation?','Are you part of the LGBTQ+ community?','Which demographic communities do you identify with?','Are you a first-generation professional?'],
};
const demographicText=value=>value==='decline'?'Decline to self identify':itemText({value}).replaceAll('_',' ');
export function memoryItems(mem,context={}) {
  const items=[];
  const matches=row=>{const s=parseScope(row.scope??'global');return s && (s.kind==='global'||s.kind==='company'&&slugify(s.key)===slugify(context.company??'')||s.kind==='role_family'&&slugify(s.key)===slugify(context.role_family??''));};
  for(const section of ['facts','preferences','answers','stories']) {
    const rows=(mem[section]??[]).filter(r=>r.use!=='never'&&r.kind!=='never'&&matches(r)).sort((a,b)=>scopeRank(b.scope??'global')-scopeRank(a.scope??'global'));
    const seen=new Set();
    for(const original of rows) {
      const id=original.id??original.qid;
      if(seen.has(id)) continue; seen.add(id);
      const row=section==='preferences'?{...original,...resolvePreference(mem,id,context)}:original;
      const kinds=section==='facts'?['fact','narrative']:section==='preferences'?['fact','preference','policy','narrative']:section==='stories'?['narrative','preference','company']:row.kind==='company'?['company','narrative']:row.kind==='policy'?['policy','preference','narrative']:['fact','narrative','preference'];
      const value=row.variants?pickVariant(row.variants):row.value??row.text;
      const item={id,source:section==='stories'?'story':section.slice(0,-1),row,kinds,value,text:itemText({...row,value}),answers_questions:questionTags(row),topics:row.topics??[],scope:row.scope??'global',provenance:{id,source:row.source??section}};
      if(id==='p.eeo' && value && typeof value==='object') {
        for(const [field,stated] of Object.entries(value)) {
          if(stated==null || stated==='ask' || resolvePreference(mem,`p.eeo.${field}`,context)) continue;
          const answer=stated?.answer??stated?.value??stated;
          const rendered=demographicText(answer);
          items.push({...item,id:`p.eeo.${field}`,value:rendered,text:`My stated response for ${field==='other_demographics'?'every other demographic question listed here':field.replaceAll('_',' ')}: ${rendered}`,answers_questions:EEO_QUESTIONS[field]??[`What is your ${field.replaceAll('_',' ')}?`],topics:['demographics',field],provenance:{...item.provenance,field}});
        }
      } else {
        if(id.startsWith('p.eeo.')) {
          if(value==='ask')continue;
          item.answers_questions=EEO_QUESTIONS[id.slice(6)]??item.answers_questions;
          item.value=demographicText(value);
          item.text=`My stated response for ${id.slice(6)==='other_demographics'?'every other demographic question listed here':id.slice(6).replaceAll('_',' ')}: ${item.value}`;
        }
        items.push(item);
      }
    }
  }
  return coalesceItems(items);
}
export function coalesceItems(items) {
  const unique=new Map();
  for(const item of items) {
    // Exact copies share one criterion; otherwise the same supported answer splits Choice mass.
    const url=URL.canParse(item.text)&&['https:','http:'].includes(new URL(item.text).protocol);
    const key=JSON.stringify([item.text,url?null:item.answers_questions,item.scope]);
    const prior=unique.get(key);
    if(prior?.source==='fact' && item.source==='answer' && (!item.row.rule_ref || item.computed)) {
      prior.provenance={...prior.provenance,copies:[...(prior.provenance.copies??[]),item.id]};
      prior.answers_questions=[...new Set([...prior.answers_questions,...item.answers_questions])];
    } else unique.set(prior?`${key}\n${item.id}`:key,item);
  }
  return [...unique.values()];
}
