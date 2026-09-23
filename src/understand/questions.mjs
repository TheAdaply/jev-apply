import {choice,noul,withNone,NONE} from '../jev/client.mjs';
import {GATES,gate,runnerUpGap} from '../jev/gates.mjs';
import {canonCandidatesFor,qualifiersIn,parentCandidates} from './prefilter.mjs';
import {ask,fieldState} from './request.mjs';
import {countryFromText} from '../schema/normalize.mjs';
export async function understandForm({formPlan,canon,documents=[],slug,signal}) {
  const state = {job:{title:formPlan.job?.title,company:formPlan.job?.company,location:formPlan.job?.location},questions:Object.fromEntries(formPlan.questions.map(q => [q.qid,{...fieldState(q),explicit_country:countryFromText(`${q.label} ${q.help??''}`)}]))};
  const questions = {}, qualifiers = {};
  for (const q of formPlan.questions) {
    const id=q.qid, at=`questions.${id}`;
    const candidates=Object.fromEntries(canonCandidatesFor(q,canon).map(r=>[r.qid ?? r.id, r.text]));
    questions[`asks_${id}`]=choice(`Which canonical question asks for exactly the same information as ${at}? Use new_question when the field offers multiple alternative answer types rather than requiring one specific type. Never add a requirement absent from the field. A labelled input is a question even when its label is one word.`,withNone({...candidates,new_question:'A valid question not exactly covered, including alternative answer types such as portfolio OR GitHub OR website'},'Not an applicant input or question at all'));
    questions[`kind_${id}`]=choice(`What kind of answer does ${at} request? Names, contact numbers and existing profile URLs are facts, even if optional. Relocation willingness is a preference.`,withNone({fact:'A stated personal datum, contact detail, existing URL or circumstance',preference:'A desired future arrangement, willingness or standing stance',policy:'An acknowledgement or consent the applicant signs',narrative:'Prose about the applicant own work',company:'Something about this employer specifically',document:'A résumé, CV, cover letter or other uploaded file',never:'Something only the applicant may answer in person'}));
    questions[`about_${id}`]=choice(`Whose circumstances does ${at} ask about? A named external employer (e.g. prior employment at an audit firm) is third_party, even though the applicant supplies the answer.`,withNone({candidate:'The applicant themselves',third_party:'Another named organisation or person, not this employer',company:'This employer, the posting or form'}));
    questions[`parent_${id}`]=choice(`Does ${at} explicitly depend on a particular answer to another field? Choose none unless its wording or visibility condition states that dependency. Mere adjacency, topical similarity or a nearby consent does not create a dependency.`,withNone({...Object.fromEntries(parentCandidates(q,formPlan.questions).map(p=>[p.qid,p.label.slice(0,240)])),none:'No explicit condition; this question stands on its own'},'An explicit condition depends on something absent from this form'));
    qualifiers[id]=qualifiersIn(q);
    qualifiers[id].forEach((qual,i)=>questions[`qual_${id}_${i}`]=noul(`Does ${at} narrow itself to ${qual}, so an answer about anything else would not answer it?`,{true:'Qualifier is part of the question',false:'It is not'}));
    questions[`sign_${id}`]=noul(`Is ${at} asking the applicant to sign, consent to, or acknowledge a statement?`,{true:'It is an attestation',false:'It asks about the applicant'});
    questions[`input_${id}`]=noul(`Is ${at} a real field asking the applicant for an answer or document, rather than an instruction, heading or decorative text?`,{true:'An applicant-answerable form field, including an unfamiliar or compound question',false:`${NONE}: not an applicant-answerable field`});
    questions[`sens_${id}`]=noul(`Does ${at} request demographic self-identification? Read the label, section and options together: age, gender, ethnicity, sexuality, disability, veteran status, pronouns, family or immigrant/refugee community membership and first-generation status all count. Consent to process demographic data is instead an attestation.`,{true:'It requests demographic self-identification or community membership',false:`${NONE}: unrelated, only mentions demographics, or requests consent rather than disclosure`});
    questions[`fmt_${id}`]=choice(`What shape of value does ${at} accept? The live type and listed options determine shape: if options are listed, choose option even for a yes/no demographic question. File uploads accept free.`,withNone({date:'Calendar date',number:'A number',url:'Web address',phone:'Telephone number',free:'Free text or document upload',option:'One or more listed options'}));
    questions[`country_${id}`]=choice(`Which country's circumstances does ${at} ask about? Distinguish current residence from the posting location. Use explicit only when the question explicitly names one country.`,withNone({current:'The country where the candidate currently lives',posting:'The country where this job is located',explicit:'The single country explicitly named by this question',irrelevant:'No country-scoped claim is requested'},'The relevant country cannot be determined'));
    if(q.type==='file') questions[`document_${id}`]=choice(`Which document type does ${at} request?`,withNone({resume:'Résumé or curriculum vitae',cover_letter:'Cover letter',...Object.fromEntries(documents.filter(doc=>doc.kind&&!['resume','cv','cover_letter'].includes(doc.kind)).map(doc=>[doc.kind,`The explicitly requested ${doc.kind.replaceAll('_',' ')} document`]))}));
  }
  const {answers,usage}=await ask({stage:'understanding',state,questions,slug,signal});
  const understanding={};
  for(const q of formPlan.questions) {
    const id=q.qid, scores={};
    for(const prefix of ['asks','kind','about','parent','fmt']) {
      const a=answers[`${prefix}_${id}`]; scores[prefix]=a.confidence; scores[`${prefix}_gap`]=runnerUpGap(a.probabilities,a.choice); scores[`${prefix}_gate`]=gate(a)==='ask'?0:gate(a)==='check'?0.5:1;
    }
    scores.input=answers[`input_${id}`].noul;
    for(const prefix of ['sign','sens']) scores[prefix]=answers[`${prefix}_${id}`].noul;
    const confirmed=qualifiers[id].filter((qual,i)=>{scores[`qual_${qual}`]=answers[`qual_${id}_${i}`].noul; return scores[`qual_${qual}`]>=GATES.noulSelect;});
    const parent=answers[`parent_${id}`].choice;
    understanding[id]={asks_for:answers[`asks_${id}`].choice,answer_kind:answers[`kind_${id}`].choice,about:answers[`about_${id}`].choice,conditional_on:parent==='none'?null:parent,qualifiers:confirmed,attestation:scores.sign>=GATES.noulSelect,sensitive:scores.sens>=GATES.noulSelect,format:answers[`fmt_${id}`].choice,scores};
    if(scores.asks_gate===0 && scores.input>=GATES.answersGate) {
      understanding[id].asks_for='new_question';
      scores.canonical_gate=scores.asks_gate;
      scores.asks_gate=scores.input<GATES.answersGate+GATES.checkGap?0.5:1;
    }
    const country=answers[`country_${id}`];
    understanding[id].country_scope=gate(country)==='ask'?NONE:country.choice;
    understanding[id].explicit_country=state.questions[id].explicit_country;
    if(answers[`document_${id}`]) {
      understanding[id].document_kind=answers[`document_${id}`].choice;
      understanding[id].scores.document_gate=gate(answers[`document_${id}`])==='ask'?0:1;
    }
  }
  return {understanding,usage};
}
