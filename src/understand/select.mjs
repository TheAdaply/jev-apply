import {choice,noul,withNone,NONE} from '../jev/client.mjs';
import {GATES,gate} from '../jev/gates.mjs';
import {itemCandidates,rankItemCandidates} from './prefilter.mjs';
import {memoryItems} from './items.mjs';
import {ask,downgrade,fieldState} from './request.mjs';
const sensitive=item=>item?.id==='p.eeo'||item?.id?.startsWith('p.eeo.');
const view=item=>({id:item.id,summary:item.topics?.[0]==='demographics'?`Saved response for ${item.topics[1].replaceAll('_',' ')}`:item.row.title??item.answers_questions.join(' ').slice(0,240),answers_questions:item.answers_questions,text:String(item.text??'').slice(0,600),provenance:item.provenance});
function redacted(state) {
  const copy=structuredClone(state);
  for(const item of Object.values(copy.items??{})) if(sensitive(item)) item.text='<redacted:sensitive>';
  for(const row of Object.values(copy.rows??{})) {
    for(const item of Object.values(row.items??{})) if(sensitive(item)) item.text='<redacted:sensitive>';
    if(sensitive(row.parent_item))row.parent_item.text='<redacted:sensitive>';
  }
  for(const row of Object.values(copy.pairs??{})) if(sensitive(row.item)) row.item.text='<redacted:sensitive>';
  return copy;
}
function pairQuestions(state,questions,key,question,item,u) {
  state.pairs[key]={question,item:view(item)};
  const at=`pairs[${JSON.stringify(key)}]`;
  questions[`does_${key}`]=noul(`Does ${at}.item state the information ${at}.question asks for, about the candidate? Interpret its text within its answers_questions scope. An explicitly saved choice not to disclose is an answer to a demographic question.`,{true:'The item provides the requested answer, including a stated choice not to disclose',false:`${NONE}: missing evidence, wrong subject or party, or an unsupported qualifier`});
  if(u.about==='third_party') questions[`party_${key}`]=noul(`Does ${at}.item.answers_questions explicitly name the particular third party asked about by ${at}.question?`,{true:'The exact party is explicitly named',false:`${NONE}: absent, generic, or a different party`});
}
export async function selectAnswers({formPlan,understanding,mem,slug,signal,context={},canon=null,itemsByQuestion={}}) {
  const pool=mem.items??memoryItems(mem,context),state={job:{title:formPlan.job?.title,company:formPlan.job?.company},rows:{},items:{},pairs:{}},questions={},candidates={},keys={};
  for(const q of formPlan.questions) {
    const u=understanding[q.qid];
    if(!u || u.asks_for===NONE || ['never','document'].includes(u.answer_kind)) continue;
    const source=itemsByQuestion[q.qid]??pool;
    const eligible=u.attestation?source.filter(item=>item.source==='preference'&&item.id.startsWith('p.legal.')):u.sensitive?source.filter(item=>item.source==='preference'&&sensitive(item)):source;
    const canonical=canon?.questions?.find(row=>(row.qid??row.id)===u.asks_for);
    const rows=u.sensitive||u.attestation?eligible:rankItemCandidates(itemCandidates({items:eligible},u.answer_kind,canonical),q,canonical);
    candidates[q.qid]=rows;
    if(!rows.length || rows.length>254) {if(rows.length>254)u.scores.selection_truncated=1;continue;}
    const question={...fieldState(q),understood:u};
    const at=`rows[${JSON.stringify(q.qid)}].question`;
    state.rows[q.qid]={question,items:{}};
    for(const item of rows) {
      if(item.row.rule_ref) state.rows[q.qid].items[item.id]=view(item);
      else state.items[item.id]=view(item);
    }
    questions[`pick_${q.qid}`]=choice(`Which saved response answers ${at}? Read candidate text from items and this row's items. Match required qualifications and parties. Slash-separated alternatives accept any ONE offered type, not all of them. When several items fully answer, choose the most direct one rather than none. A saved nondisclosure response answers a demographic question offering nondisclosure.`,withNone(Object.fromEntries(rows.map(item=>[item.id,item.answers_questions.join(' ').slice(0,320)]))));
    if(rows.length<=3) rows.forEach((item,i)=>{const key=`${q.qid}_${i}`;keys[`${q.qid}\n${item.id}`]=key;pairQuestions(state,questions,key,question,item,u);});
  }
  const first=await ask({stage:'selection',state,traceState:redacted(state),questions,slug,signal});
  const next={rows:{},pairs:{}},checks={},chosen={};
  for(const q of formPlan.questions) {
    const u=understanding[q.qid],pick=first.answers[`pick_${q.qid}`];
    const item=candidates[q.qid]?.find(r=>r.id===pick?.choice);
    if(!item)continue;
    chosen[q.qid]=item;
    if(!keys[`${q.qid}\n${item.id}`]) {const key=q.qid;keys[`${q.qid}\n${item.id}`]=key;pairQuestions(next,checks,key,state.rows[q.qid].question,item,u);}
  }
  for(const q of formPlan.questions) {
    const u=understanding[q.qid];
    if(!u?.conditional_on)continue;
    const parent=chosen[u.conditional_on];
    next.rows[q.qid]={question:fieldState(q),parent_question:state.rows[u.conditional_on]?.question??null,parent_item:parent?view(parent):null};
    checks[`active_${q.qid}`]=noul(`Does rows[${JSON.stringify(q.qid)}].parent_item explicitly satisfy the condition stated in that row's question, for that exact parent_question? An absent parent or different predicate does not open the child.`,{true:'The stated parent answer opens this child',false:`${NONE}: parent unknown or does not establish the condition`});
  }
  const second=await ask({stage:'responsiveness',state:next,traceState:redacted(next),questions:checks,slug,signal});
  const answers={...first.answers,...second.answers},selection={};
  for(const q of formPlan.questions) {
    const id=q.qid,u=understanding[id],pick=first.answers[`pick_${id}`],item=chosen[id],key=keys[`${id}\n${item?.id}`],responsive=answers[`does_${key}`]?.noul??0;
    let action=!item||responsive<GATES.answersGate?'ask':responsive<GATES.answersGate+GATES.checkGap?'check':'fill';
    if(pick) action=downgrade(action,gate(pick));
    let why=item?'saved item answers the question':'no saved item answers this question';
    if(u?.about==='third_party'&&(answers[`party_${key}`]?.noul??0)<GATES.answersGate) {action='ask';why='no saved item explicitly answers about this third party';}
    if(u?.attestation&&!(item?.source==='preference'&&item.id.startsWith('p.legal.'))) {action='ask';why='requires an explicit p.legal stance';}
    if(u?.sensitive&&!(item?.source==='preference'&&sensitive(item))) {action='ask';why='requires p.eeo or the user';}
    if(u?.conditional_on)u.scores.conditional_active=answers[`active_${id}`]?.noul??0;
    selection[id]={item:item?.id??null,answers:responsive,action,why};
  }
  const usage={...first.usage};for(const key of Object.keys(usage))usage[key]+=second.usage[key]??0;
  return {selection,usage,items:pool};
}
