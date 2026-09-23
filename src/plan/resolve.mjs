// Meaning arrives from understanding + selection; this module only renders selected data.
import {existsSync} from 'node:fs';
import path from 'node:path';
import {slugify} from '../config.mjs';
import {documentFor,resolvePreference} from '../memory/resolve.mjs';
import {appliedBefore,roleFamilyFor,startDate,noticeRule} from '../memory/derive.mjs';
import {countryFromText} from '../schema/normalize.mjs';
import {canonicalOption} from '../canon/normalize.mjs';
import {pickVariant} from '../schema/classes.mjs';
import {GATES} from '../jev/gates.mjs';
import {NONE} from '../jev/client.mjs';
import {downgrade} from '../understand/request.mjs';
export function countryFor(job = {}) {
  return job.country ?? countryFromText([job.location, job.office, job.market].filter(Boolean).join(" ; "));
}
export function factText(row) {
  const raw = row?.value;
  if (typeof raw !== "string") return raw == null ? null : { text: String(raw), qualified: false };
  const value = raw.trim();
  if (!value) return null;
  const head = value.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, "").trim();
  return head && head !== value ? { text: head, qualified: true } : { text: value, qualified: false };
}
export function jobContext(formPlan, mem) {
  const job = formPlan?.job ?? {};
  const role_family = roleFamilyFor(mem, job) ?? null;
  return {
    company: job.company ?? "",
    company_slug: slugify(job.company ?? ""),
    title: job.title ?? "",
    location: job.location ?? "",
    country: countryFor(job),
    remote: job.remote === true,
    role_family,
    job: { ...job, role_family },
  };
}

export function resolveForm(formPlan,{mem,understanding={},selection={},items=[],itemsByQuestion={}}={}) {
  const context=jobContext(formPlan,mem);
  const decisions=formPlan.questions.map(q=>{
    const u=understanding[q.qid],s=selection[q.qid],item=(itemsByQuestion[q.qid]??items).find(i=>i.id===s?.item);
    const d={qid:q.qid,label:q.label,required:!!q.required,section:q.section??null,class:'company_specific',source:'none',action:'ask',why:'question has not been understood',_open:true,_limits:q.limits??null,_help:q.help??'',_onNone:'ask'};
    if(!u) return d;
    Object.assign(d,{understanding:u,canon:u.asks_for,understood_kind:u.answer_kind,canonical_new:u.asks_for==='new_question'?'new':'canonical',qualifiers:u.qualifiers,third_party:u.about==='third_party',conditional_on:u.conditional_on,selected_item:s?.item??null,selection_noul:s?.answers??0,option_noul:null,_open:false});
    d.class=u.attestation?'policy_gate':u.sensitive?'sensitive':u.answer_kind==='narrative'?'essay':u.answer_kind==='company'?'why_us':u.answer_kind==='fact'?'identity':'circumstance';
    q.class=d.class; q.understanding=u;
    d.remember_as={kind:u.attestation?'preference':u.sensitive?'preference':u.answer_kind==='narrative'?'story':u.answer_kind==='fact'?'fact':'answer',...(u.attestation?{id:`p.legal.${slugify(q.label).replaceAll('-','_')}`}:u.sensitive?{id:'p.eeo'} : {}),scope:u.about==='company'?`company:${context.company_slug}`:'global',answers_questions:[q.label],topics:u.qualifiers};
    const gates=['asks','kind','about','parent','fmt'].map(k=>u.scores[`${k}_gate`]===0?'ask':u.scores[`${k}_gate`]===0.5?'check':'fill');
    d.action=downgrade(s?.action??'ask',...gates);d.why=s?.why??'no saved item answers this question';
    if(u.asks_for===NONE||u.answer_kind==='never') d.action='ask';
    if(q.type==='file' && u.answer_kind==='document' && u.scores.document_gate!==0 && !gates.includes('ask')) {
      const kind=u.document_kind??(u.asks_for==='q.core.resume'?'resume':null);
      const documents=(mem.documents??[]).filter(doc=>kind==='resume'?(!doc.kind||doc.kind==='resume'||doc.kind==='cv'):kind&&doc.kind===kind);
      const doc=documentFor({...mem,documents},context);
      Object.assign(d,fileRow(doc,`saved ${kind??'requested'} document`));
      if(d.action==='fill') {
        d.selected_item=doc.id;
        d.selected={item:doc.id,text:`Saved résumé document ${path.basename(doc.path)}`,answers_questions:[q.label],topics:['resume']};
      }
      return d;
    }
    if(!item || d.action==='ask') return d;
    d.selected={item:item.id,text:item.text,answers_questions:item.answers_questions,topics:item.topics,provenance:item.provenance};
    d.grounding_ids=[item.id]; d.grounding_scores={[item.id]:s.answers};
    d.source=item.source;d.why=`${item.id} — ${s.why}`;
    let value=item.row.variants?pickVariant(item.row.variants,q.limits):item.value;
    if(item.row.rule_ref) value=item.computed?.value??null;
    if(u.format==='date' && (item.id==='p.notice_rule'||item.row.rule_ref==='p.notice_rule')) {
      const now=new Date(),computed=startDate(mem,context,now);
      value=computed?.value??null;
      d.derivation={resolved_value:value,reference_date:now.toISOString().slice(0,10),premise:item.text,rule:noticeRule(mem,context),source:computed?.why??null};
    }
    if(value&&typeof value==='object' && !q.options?.length) {
      const fields={'q.core.current_company':'company','q.core.current_title':'title','q.core.education_school':'school','q.core.education_field':'field','q.core.education_degree':'degree'};
      const field=fields[u.asks_for]; value=field?value[field]??(field==='company'?value.employer:null):null;
    }
    if(value==null) {d.action='ask';d.why='selected item needs a value shape it does not state';return d;}
    d.value=typeof value==='string'?value:typeof value==='object'?JSON.stringify(value):String(value);
    d._answerText=u.sensitive?d.value:item.text;
    return d;
  });
  applyDependencies(decisions,formPlan.questions);
  return {decisions,context};
}
export function applyDependencies(decisions,questions=[]) {
  const byId=new Map(decisions.map(d=>[d.qid,d]));
  for(const child of decisions) {
    const u=child.understanding;if(!u?.conditional_on)continue;
    const parent=byId.get(u.conditional_on);
    if(!parent||!['fill','check'].includes(parent.action)||(u.scores.conditional_active??0)<GATES.noulSelect) {
      child.action='skip'; child.why='conditional question is not opened by the selected parent answer';delete child.value;delete child.option;delete child.draft_request;
    }
  }
}
export function eeoCanonical(field,value) { return canonicalOption(`eeo-${field.replaceAll('_','-')}`,value) ?? value; }
function fileRow(doc, why) {
  if (!doc?.path || !existsSync(doc.path)) {
    return { source: "none", action: "ask", why: `${doc?.id ?? "document"} is not on disk` };
  }
  return { source: "document", value: path.basename(doc.path), path: doc.path, action: "fill", why };
}
const INITIAL_RE = /^[\p{L}]{1,2}\.?$/u;
export function nameSplit(parts) {
  if (parts.length === 2 && INITIAL_RE.test(parts[0]) !== INITIAL_RE.test(parts[1])) {
    const initial = INITIAL_RE.test(parts[0]) ? parts[0] : parts[1];
    const name = initial === parts[0] ? parts[1] : parts[0];
    return { first: name, last: initial, initialFirst: true };
  }
  return { first: parts[0], last: parts.slice(1).join(" "), initialFirst: false };
}
const YES='Yes',NO='No';
export function yesNoOf(value) {
  if (value === true) return YES;
  if (value === false) return NO;
  if (value && typeof value === "object" && !Array.isArray(value)) return yesNoOf(value.answer ?? value.value ?? null);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^(n|no|false|i (?:do not|don't|am not|have not|haven't|was not|wasn't|disagree|decline|object))\b/i.test(text)) return NO;
  if (/^(y|yes|true|i (?:do|am|have|was|agree|accept|consent|acknowledge|understand|certify|confirm))\b/i.test(text)) return YES;
  return null;
}
export function workAuthAnswer(kind, auth, country) {
  if (kind === "sponsorship") {
    if (!auth.needs_sponsorship_future) {
      return { kind, value: NO, answerText: `No — will not require employer immigration sponsorship to work in ${country}` };
    }
    return {
      kind,
      value: YES,
      answerText: auth.authorized_now
        ? `Yes — authorized to work in ${country} today, but will require employer immigration sponsorship in the future to keep working there`
        : `Yes — requires employer immigration sponsorship starting now to legally work in ${country}`,
    };
  }
  if (kind === "authorized_without_sponsorship") {
    const yes = auth.authorized_now && !auth.needs_sponsorship_future;
    return {
      kind,
      value: yes ? YES : NO,
      answerText: yes
        ? `Yes — legally authorized to work in ${country} and needs no employer sponsorship`
        : `No — ${auth.authorized_now ? `authorized in ${country} today but will need employer sponsorship` : `not currently authorized to work in ${country} without employer sponsorship`}`,
    };
  }
  return {
    kind,
    value: auth.authorized_now ? YES : NO,
    answerText: auth.authorized_now
      ? `Yes — currently legally authorized to work in ${country}`
      : `No — not currently legally authorized to work in ${country}`,
  };
}
export function relocationAnswer(value, country) {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? YES : NO;
  if (typeof value === "string") return /^(yes|true|willing)/i.test(value) ? YES : /^(no|false)/i.test(value) ? NO : null;
  if (typeof value !== "object") return null;
  const except = (value.anywhere_except ?? value.except ?? []).map((c) => String(c).toUpperCase());
  const only = (value.to ?? value.only ?? []).map((c) => String(c).toUpperCase());
  if (value.willing === false) return NO;
  if (country && except.includes(country)) return NO;
  if (only.length) return country ? (only.includes(country) ? YES : NO) : null;
  if (value.willing === true) return except.length && !country ? null : YES;
  return null;
}
export function relocationFor(mem, { company, role_family, country = null } = {}) {
  const pref = resolvePreference(mem, "p.relocation", { company, role_family });
  if (!pref) return { value: null, why: "no p.relocation on file" };
  const value = relocationAnswer(pref.value, country);
  if (value == null) return { value: null, why: "p.relocation does not cover this location" };
  return {
    value,
    why: `p.relocation (${pref.scope})${country ? ` for ${country}` : ""}`,
    text: `${value} — ${value === YES ? "willing to relocate for this role" : "not relocating to this location"}`,
  };
}

/** `p.in_office` → the days/answer the user stated, verbatim. An empty statement is an ask. */
export function inOfficeFor(mem, { company, role_family } = {}) {
  const pref = resolvePreference(mem, "p.in_office", { company, role_family });
  if (!pref) return { value: null, why: "no in-office preference on file" };
  const raw = pref.value;
  const stated =
    raw && typeof raw === "object" ? (raw.answer ?? (raw.days != null ? raw.days : "")) : (raw ?? "");
  const value = String(stated).trim();
  if (!value) return { value: null, why: "p.in_office states no answer" };
  return { value, why: `p.in_office (${pref.scope})`, text: value };
}
export function appliedBeforeFor(pipeline, company) {
  const tracked = (Array.isArray(pipeline) ? pipeline : (pipeline?.jobs ?? [])).length;
  if (!tracked) return { value: null, why: "no pipeline history to answer from" };
  const seen = appliedBefore(pipeline, company);
  return {
    value: seen.applied ? YES : NO,
    why: seen.applied ? `pipeline: ${seen.count} prior application(s)` : `pipeline has no record for ${company}`,
    text: seen.applied
      ? `Yes — applied before (${seen.last?.title ?? "prior application"})`
      : `No — first application to ${company}`,
  };
}
