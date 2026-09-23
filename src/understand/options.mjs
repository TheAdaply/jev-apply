import {choice,noul,withNone,NONE} from '../jev/client.mjs';
import {GATES,gate} from '../jev/gates.mjs';
import {normalizeOption} from '../canon/normalize.mjs';
import {ask,fieldState,downgrade} from './request.mjs';
const trace=state=>({rows:Object.fromEntries(Object.entries(state.rows).map(([id,row])=>[id,{...row,answer_text:row.sensitive?'<redacted:sensitive>':row.answer_text}]))});
function fidelity(state,questions,id,label,index) {
  const key=`${id}_${index}`;
  state.rows[key]={...state.rows[id],option:{id:`o${index}`,label}};
  questions[`faith_${key}`]=noul(`Does rows[${JSON.stringify(key)}].option faithfully state that row's answer_text for its question and question_country? Judge equivalent meaning, not wording. Decline to self identify, prefer not to say, and choose not to disclose all express nondisclosure, not a personal characteristic. Yes/No inherits the question's subject but cannot add an unstated visa category.`,{true:'The explicit option expresses the same supported answer or nondisclosure choice',false:`${NONE}: changes or invents the answer`});
  return key;
}
export async function mapOptions({rows,slug,signal}) {
  const state={rows:{}},questions={},lists={},mapped={},keys={};
  for(const row of rows) {
    const q=row.question??row.q??row,id=q.qid;
    const labels=(q.options??[]).map(o=>o.label??o);lists[id]=labels.slice(0,254);
    const answer=row.answer_text??row._answerText??row.value;
    state.rows[id]={question:{...fieldState(q),options:lists[id]},answer_text:answer,question_country:row.question_country??null,provenance:row.provenance??null,sensitive:row.sensitive||q.class==='sensitive'};
    const exact=labels.filter(label=>normalizeOption(label)===normalizeOption(answer));
    if(exact.length===1) {mapped[id]={option:exact[0],faithful:1,action:'fill'};continue;}
    if(q.type==='multi_select') {
      lists[id].forEach((label,i)=>{const key=`${id}_${i}`;state.rows[key]={...state.rows[id],option:{id:`o${i}`,label}};questions[`optm_${key}`]=noul(`Does rows[${JSON.stringify(key)}].answer_text support selecting its explicit option for its question and question_country? An option joining alternatives with OR accepts either stated alternative, not both; it need not repeat the answer verbatim. Never infer a narrower subgroup. Equivalent nondisclosure wording is also supported.`,{true:'The saved answer supports this option, including one of its explicit alternatives',false:`${NONE}: unsupported or contradicts the saved answer`});});
    } else {
      questions[`opt_${id}`]=choice(`Which option for rows[${JSON.stringify(id)}].question expresses the same meaning as that row's answer_text in its question_country? Translate equivalent wording: decline to self identify, prefer not to say, and choose not to disclose mean the same nondisclosure choice. Do not infer an unstated personal detail.`,withNone(Object.fromEntries(lists[id].map((label,i)=>[`o${i}`,label])),'No option expresses this answer'));
      if(lists[id].length<=12)lists[id].forEach((label,i)=>{keys[`${id}\n${i}`]=fidelity(state,questions,id,label,i);});
    }
  }
  const first=await ask({stage:'options',state,traceState:trace(state),questions,slug,signal});
  const next={rows:{}},checks={};
  for(const row of rows) {
    const q=row.question??row.q??row,id=q.qid,a=first.answers[`opt_${id}`];
    if(!a||a.choice===NONE)continue;
    const i=Number(a.choice.slice(1));
    if(!keys[`${id}\n${i}`]) {next.rows[id]=state.rows[id];keys[`${id}\n${i}`]=fidelity(next,checks,id,lists[id][i],i);}
  }
  const second=await ask({stage:'option_fidelity',state:next,traceState:trace(next),questions:checks,slug,signal});
  const answers={...first.answers,...second.answers};
  for(const row of rows) {
    const q=row.question??row.q??row,id=q.qid,labels=lists[id];
    if(mapped[id])continue;
    let option=null,faithful=0,action='ask';
    if(q.type==='multi_select') {
      const scores=labels.map((_,i)=>answers[`optm_${id}_${i}`]?.noul??0);
      const picked=labels.filter((_,i)=>scores[i]>=GATES.noulSelect);
      faithful=scores.length?Math.min(...scores.map(p=>Math.max(p,1-p))):0;
      if(picked.length) {option=picked.join(' | ');action=scores.some(p=>Math.abs(p-GATES.noulSelect)<GATES.checkGap)?'check':'fill';}
    } else {
      const a=answers[`opt_${id}`],i=Number(a.choice.slice(1));faithful=answers[`faith_${keys[`${id}\n${i}`]}`]?.noul??0;
      if(a.choice!==NONE)option=labels[i]??null;
      action=downgrade(gate(a),!option||faithful<GATES.faithfulGate?'ask':faithful<GATES.faithfulGate+GATES.checkGap?'check':'fill');
    }
    if((q.options??[]).length>254)action=downgrade(action,'check');
    mapped[id]={option,faithful,action};
  }
  const usage={...first.usage};for(const key of Object.keys(usage))usage[key]+=second.usage[key]??0;
  return {mapped,usage};
}
