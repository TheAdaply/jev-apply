import { appendTrace } from '../browser/trace.mjs';
import { estimateTokens, estimateQuestionTokens, MAX_REQUEST_TOKENS, systemOne } from '../jev/client.mjs';
export const emptyUsage = () => ({requests:0, ms:0, input_tokens:0, output_tokens:0});
// The character estimator undercounts token-heavy ids and option catalogues. Keep headroom
// below its 56k ceiling, and never resend unrelated rows with every question batch.
const STAGE_TOKENS=Math.floor(MAX_REQUEST_TOKENS*0.8);
const size=(state,questions)=>estimateTokens(state)+64+Object.entries(questions).reduce((n,[id,q])=>n+estimateQuestionTokens(id,q),0);
function references(state,questions) {
  const wanted={questions:new Set(),rows:new Set(),pairs:new Set(),items:new Set()};
  for(const question of Object.values(questions)) {
    const instructions=question.instructions??'';
    for(const table of ['questions','rows','pairs']) for(const key of Object.keys(state[table]??{})) {
      if(instructions.includes(`${table}[${JSON.stringify(key)}]`)||instructions.includes(`${table}.${key}`))wanted[table].add(key);
    }
    for(const key of Object.keys(question.criteria??{})) {
      if(state.items?.[key])wanted.items.add(key);
      if(state.questions?.[key])wanted.questions.add(key);
    }
  }
  return wanted;
}
function project(state,wanted,compact=false) {
  const out={...state};
  for(const [table,keys] of Object.entries(wanted)) if(state[table])out[table]=Object.fromEntries([...keys].filter(key=>state[table][key]).map(key=>[key,state[table][key]]));
  if(!compact)return out;
  const itemView=item=>item&&String(item.text??'').length>240?{...item,text:String(item.summary??item.text).slice(0,240)}:item;
  if(out.items)out.items=Object.fromEntries(Object.entries(out.items).map(([id,item])=>[id,itemView(item)]));
  if(out.rows)out.rows=Object.fromEntries(Object.entries(out.rows).map(([id,row])=>[id,{...row,...(row.items?{items:Object.fromEntries(Object.entries(row.items).map(([key,item])=>[key,itemView(item)]))}:{})}]));
  return out;
}
export function stageRequests(state,questions,traceState=state) {
  const batches=[];
  let current={};
  const pack=(batch)=>{
    const wanted=references(state,batch);
    let projected=project(state,wanted),traced=project(traceState,wanted);
    if(size(projected,batch)>STAGE_TOKENS) {
      projected=project(state,wanted,true);traced=project(traceState,wanted,true);
    }
    if(size(projected,batch)>STAGE_TOKENS)throw new Error('understanding_budget: one question exceeds the request cap even with candidate summaries');
    return {state:projected,traceState:traced,questions:batch};
  };
  for(const [id,q] of Object.entries(questions)) {
    const next={...current,[id]:q},wanted=references(state,next);
    if(Object.keys(current).length&&size(project(state,wanted),next)>STAGE_TOKENS) {
      batches.push(pack(current));current={};
    }
    current[id]=q;
  }
  if(Object.keys(current).length)batches.push(pack(current));
  return batches;
}
export async function ask({stage,state,questions,traceState=state,slug,signal}) {
  if(!Object.keys(questions).length)return {answers:{},usage:emptyUsage()};
  const started=Date.now();
  const send=async(batch)=>{
    await appendTrace(slug,{op:'jev_request',stage,state:batch.traceState,questions:batch.questions,estimated_tokens:size(batch.state,batch.questions),over_budget:false});
    try {
      const result=await systemOne({state:batch.state,questions:batch.questions,signal});
      await appendTrace(slug,{op:'jev_response',stage,model:result.model,answers:result.answers,requests:result.requests,usage:result.usage,ms:result.ms});
      return {answers:result.answers,usage:{...result.usage,requests:result.requests,ms:result.ms}};
    } catch(error) {
      await appendTrace(slug,{op:'jev_error',stage,error:error.name});
      if(!String(error.message).includes('max_tokens_exceeded'))throw error;
      const entries=Object.entries(batch.questions);
      if(entries.length===1) {
        const wanted=references(batch.state,batch.questions);
        const compact=project(batch.state,wanted,true);
        if(estimateTokens(compact)>=estimateTokens(batch.state))throw error;
        const result=await send({...batch,state:compact,traceState:project(batch.traceState,wanted,true)});
        result.usage.requests+=1;return result;
      }
      // A server rejection is evidence the estimate was optimistic. Halve both questions and
      // their referenced state, never retry the same oversized payload or remove candidate ids.
      const middle=Math.ceil(entries.length/2);
      const halves=[Object.fromEntries(entries.slice(0,middle)),Object.fromEntries(entries.slice(middle))];
      const results=await Promise.all(halves.flatMap(part=>stageRequests(batch.state,part,batch.traceState)).map(send));
      const joined=combine(results);joined.usage.requests+=1;return joined;
    }
  };
  const result=combine(await Promise.all(stageRequests(state,questions,traceState).map(send)));
  result.usage.ms=Date.now()-started;
  return result;
}
function combine(results) {
  const answers={},usage=emptyUsage();
  for(const result of results) {
    Object.assign(answers,result.answers);
    for(const key of Object.keys(usage))usage[key]+=result.usage[key]??0;
  }
  return {answers,usage};
}
export const fieldState = q => ({label:q.label,help:q.help ?? '',type:q.type,required:!!q.required,section:q.section ?? '',options:(q.options ?? []).map(o => o.label ?? o)});
export const downgrade = (...actions) => actions.includes('ask') ? 'ask' : actions.includes('check') ? 'check' : 'fill';
