// Three meaning judgments: understand, select, map. No label-to-answer rules.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {paths} from '../config.mjs';
import {getFact} from '../memory/resolve.mjs';
import {fullTimeYears,latestEducation,latestEmployment,locationFact,noticeRule,salaryFor,workAuth} from '../memory/derive.mjs';
import {appliedBeforeFor,factText,inOfficeFor,relocationFor,resolveForm,applyDependencies} from '../plan/resolve.mjs';
import {understandForm} from '../understand/questions.mjs';
import {selectAnswers} from '../understand/select.mjs';
import {mapOptions} from '../understand/options.mjs';
import {memoryItems,coalesceItems} from '../understand/items.mjs';
import {downgrade} from '../understand/request.mjs';
import {appendTrace} from '../browser/trace.mjs';
import {countryFromText} from '../schema/normalize.mjs';
import {itemText} from '../memory/enrich.mjs';
export {normalizeOption} from '../canon/normalize.mjs';
export const CRITERION_CHARS=320;
const clip=(text,n=CRITERION_CHARS)=>String(text??'').slice(0,n);
export async function loadCanon(dir = paths.canon) {
  const raw = await readFile(path.join(dir, "questions.yaml"), "utf8").catch(() => null);
  if (raw == null) return null;
  const parsed = parseYaml(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : [];
  const questions = list.filter((row) => row && typeof row === "object" && (row.qid ?? row.id));
  return questions.length ? { questions, dir } : null;
}
export function canonCandidates(canon,_context) { return canon?.questions??[]; }
export function canonCriterion(row) {
  const forms = (row?.surface_forms ?? [])
    .map((f) => (typeof f === "string" ? f : (f?.label ?? f?.text)))
    .filter(Boolean)
    .slice(0, 3);
  const text = row?.text ?? row?.qid ?? row?.id;
  return clip(forms.length ? `${text} (also: ${forms.map((f) => `"${f}"`).join(", ")})` : text);
}

export async function planWithJev({formPlan,decisions,mem,context,slug,canon=null,baselines=null,pipeline=null,signal}) {
  // User answers are already authoritative; resumed option rows need only the mapping stage.
  const needsUnderstanding=decisions.some(d=>d._open || !d.understanding && d.source!=='user');
  const stages=[],spent=[];
  let out=decisions.map(d=>({...d}));
  if(needsUnderstanding) {
    const a=await understandForm({formPlan,canon,documents:mem.documents??[],slug,signal});spent.push(a.usage);stages.push('understanding');
    const items=memoryItems(mem,context),itemsByQuestion={};
    const countryFact=getFact(mem,'f.identity.country');
    const currentCountry=countryFromText(countryFact?.value??locationFact(mem)?.value??'');
    for(const q of formPlan.questions) {
      const u=a.understanding[q.qid];
      const country=u.country_scope==='current'?currentCountry:u.country_scope==='explicit'?u.explicit_country:u.country_scope==='posting'?context.country:null;
      u.question_country={country,source:u.country_scope==='current'?(countryFact?.id??locationFact(mem)?.id??null):u.country_scope};
      itemsByQuestion[q.qid]=coalesceItems(items.map(original=>{
        const item={...original,row:{...original.row}};
        const ref=CANON_RULES.get(item.id)??item.row.rule_ref??(['p.relocation','p.in_office','p.notice_rule'].includes(item.id)?item.id:null);
        if(ref) {
          item.row.rule_ref=ref;
          const scoped=/work_auth|authoriz/.test(ref)?{...context,country}:context;
          item.computed=ruleAnswer(ref,{mem,context:scoped,baselines,pipeline});
          item.value=item.computed?.value??null;
          item.text=item.computed?.text??(item.value==null?'No supported value available':itemText({value:item.value}));
          item.provenance={...item.provenance,derivation:ref,evidence:item.computed?.why??null};
        }
        return item;
      }).filter(item=>item.value!=null));
    }
    const b=await selectAnswers({formPlan,understanding:a.understanding,mem:{items},itemsByQuestion,canon,context,slug,signal});spent.push(b.usage);stages.push('selection');
    out=resolveForm(formPlan,{mem,understanding:a.understanding,selection:b.selection,items,itemsByQuestion}).decisions;
  }
  const byId=new Map(formPlan.questions.map(q=>[q.qid,q]));
  const rows=out.filter(d=>['fill','check'].includes(d.action)&&d.value!=null&&!d.option&&(byId.get(d.qid)?.options??[]).length).map(d=>({question:byId.get(d.qid),answer_text:d._answerText??d.value,question_country:d.understanding?.question_country,provenance:d.selected?.provenance,sensitive:d.class==='sensitive'}));
  if(rows.length) {
    const c=await mapOptions({rows,slug,signal});spent.push(c.usage);stages.push('options');
    for(const d of out) {const p=c.mapped[d.qid];if(!p)continue;d.option_noul=p.faithful;d.action=downgrade(d.action,p.action);if(p.option)d.option=p.option;if(p.action==='ask')d.why='no option faithfully states the selected answer';}
  }
  applyDependencies(out,formPlan.questions);
  const requests=spent.reduce((n,u)=>n+u.requests,0);
  await appendTrace(slug,{op:'understanding_budget',requests,over_budget:requests>6,stages});
  return {decisions:out,requests,over_budget:requests>6,ms:spent.reduce((n,u)=>n+u.ms,0),usage:{input_tokens:spent.reduce((n,u)=>n+u.input_tokens,0),output_tokens:spent.reduce((n,u)=>n+u.output_tokens,0)},stages};
}
export const CANON_RULES = new Map([
  ["q.auth.authorized_in_country", "work_auth.authorized_now"],
  ["q.auth.sponsorship_now", "work_auth.sponsorship_now"],
  ["q.auth.sponsorship_future", "work_auth.sponsorship_future"],
  ["q.auth.require_visa_sponsorship_work_selected", "work_auth.sponsorship_future"],
  ["q.core.start_date", "p.notice_rule"],
  ["q.core.notice_period", "p.notice_rule"],
  ["q.comp.expected_salary", "p.salary"],
  ["q.core.relocation", "p.relocation"],
  ["q.core.in_office", "p.in_office"],
  ["q.legal.previously_applied", "applied_before"],
  ["q.core.location_current", "identity.location"],
  ["q.core.address_working", "identity.address"],
  ["q.core.years_experience", "experience.years_total"],
  ["q.core.years_experience_total", "experience.years_total"],
  // Who the user works for, what they are called there and where they studied are read from the
  // employment/education facts at fill time for the same reason the two rows above are: a store
  // written from a CV holds one dated row per role, the newest one changes without anybody
  // editing memory, and a constant copied out of it goes stale the day a job ends
  // (docs/research/16-eval-judge-ten.md E1).
  ["q.core.current_company", "employment.employer"],
  ["q.core.current_title", "employment.title"],
  ["q.core.education_school", "education.school"],
  ["q.core.education_field", "education.field"],
]);
export function ruleAnswer(ruleRef, { mem, context = {}, baselines = null, pipeline = null, label = "" }) {
  const ref = String(ruleRef ?? "");
  if (/work_auth|authoriz/.test(ref)) {
    const auth = context.country ? workAuth(mem, context.country) : null;
    if (!auth) return null;
    const sponsor = /sponsor/.test(ref);
    const yes = sponsor ? auth.needs_sponsorship_future : auth.authorized_now;
    return {
      value: yes ? "Yes" : "No",
      exact: auth.exact,
      why: auth.exact
        ? `${auth.fact} for ${auth.country}`
        : `from your default rule (no ${auth.country}-specific fact) — ${auth.fact}`,
      text: `${yes ? "Yes" : "No"} — ${sponsor ? "sponsorship" : "authorization"} for ${auth.country}`,
    };
  }
  if (/notice|start/.test(ref)) {
    const rule = noticeRule(mem, { company: context.company, role_family: context.role_family });
    if (!rule) return null;
    const value = rule.text ?? (rule.days === 0 ? "Immediately" : rule.days != null ? `${rule.days} days` : null);
    return value ? { value: String(value), why: `p.notice_rule (${rule.kind})` } : null;
  }
  if (/salary|compensation|pay/.test(ref)) {
    const salary = salaryFor(mem, context.job, baselines);
    return salary.action === "fill" ? { value: salary.formatted ?? String(salary.amount), why: salary.why } : null;
  }
  const scope = { company: context.company, role_family: context.role_family };
  if (/reloc/.test(ref)) return answered(relocationFor(mem, { ...scope, country: context.country }));
  if (/in[_ -]?office/.test(ref)) return answered(inOfficeFor(mem, scope));
  if (/applied/.test(ref)) return answered(appliedBeforeFor(pipeline, context.company));
  // Where the user lives, in their own words. `identity.address` prefers the street address a
  // form asking for one wants, and falls back to the location they stated — the same facts, and
  // the same `check`-when-qualified rule, `src/plan/resolve.mjs identityRow()` applies to a field
  // labelled "Current Location". Tested after `/reloc/`, which also contains "location".
  if (/identity\.address|address_working/.test(ref)) {
    return statedPlace(mem, ["f.identity.address", "f.identity.location", "f.identity.city"]);
  }
  if (/identity\.location|location_current/.test(ref)) {
    return statedPlace(mem, ["f.identity.location", "f.identity.city"]);
  }
  // Total professional experience, counted at fill time from the `since:` dates on the facts that
  // say they are full-time (PLAN §2.1: numbers are code's job, never the model's). Floored, never
  // rounded up: a form answer must not overstate the user's experience by half a year.
  if (/experience\.years_total|years_experience/.test(ref)) {
    const years = fullTimeYears(mem);
    if (!(years > 0)) return null;
    const whole = String(Math.floor(years));
    return { value: whole, why: `${years} yr full-time on file`, text: `${whole} years of full-time professional experience` };
  }
  // The newest dated role / degree the facts state. `employment.*` draws the same line the
  // deterministic pass does: a role whose own dates have closed answers a label that asks for the
  // most recent one and never a label that asks only for a current one, and a value read out of
  // a CV sentence comes back `exact: false`, which commits it as a `check`.
  if (/^employment\./.test(ref)) {
    const part = /title/.test(ref) ? "title" : "employer";
    const latest = latestEmployment(mem);
    const value = latest?.[part] ?? null;
    if (!value) return null;
    const when = latest.current ? `current role since ${latest.since}` : `most recent role, since ${latest.since}`;
    return { value, exact: latest.current && !latest.prose, why: `${latest.id} (${when})` };
  }
  if (/^education\./.test(ref)) {
    const latest = latestEducation(mem);
    const value = latest?.[/field/.test(ref) ? "field" : "school"] ?? null;
    return value ? { value, exact: !latest.prose, why: `${latest.id} (most recent, since ${latest.since})` } : null;
  }
  return null;
}
function statedPlace(mem, ids) {
  const place = locationFact(mem);
  for (const id of ids) {
    const row = getFact(mem, id);
    const parsed = row ? factText(row) : null;
    if (!parsed?.text) continue;
    // A street address is the answer to "address" whatever it looks like; the two locality ids
    // only answer when `locationFact` says they name somewhere.
    if (id !== "f.identity.address" && place?.id !== id) continue;
    return {
      value: parsed.text,
      text: parsed.text,
      exact: !parsed.qualified,
      why: parsed.qualified ? `${id} (value is qualified — verify)` : id,
    };
  }
  return null;
}

/** A shared derivation's `{value, why, text}` → a rule answer, or null when it had to ask. */
const answered = ({ value, why, text }) => (value == null ? null : { value, why, text });
