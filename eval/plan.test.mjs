#!/usr/bin/env node
// Live semantic contracts and deterministic submit invariants; no mock decider.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEnv} from '../src/config.mjs';
import {emptyMemory} from '../src/memory/schema.mjs';
import {loadCanon,planWithJev} from '../src/jev/plan.mjs';
import {resolveForm} from '../src/plan/resolve.mjs';
import {RULES,preflight,submitGate} from '../src/plan/preflight.mjs';
import {canonCandidatesFor,parentCandidates} from '../src/understand/prefilter.mjs';
import {choice,withNone,validateAnswer,NONE} from '../src/jev/client.mjs';
import {systemOne} from '../src/jev/client.mjs';
import {verifyDecisions,verificationCounts} from '../src/verify/filled.mjs';
import {judgmentMetrics} from '../src/bench/metrics.mjs';
import {expectedRows,auditMemory} from '../src/bench/shots.mjs';
import {memoryItems} from '../src/understand/items.mjs';
import {itemCandidates} from '../src/understand/prefilter.mjs';
import {mapOptions} from '../src/understand/options.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const APPLY=path.join(ROOT,'scripts/apply.mjs');
let failures=0;
function check(label,ok) { console.log(`${ok?'ok':'FAIL'} - ${label}`); if(!ok) failures++; }
loadEnv();
for(const fixture of ['greenhouse-togetherai-5179372007.json','ashby-baseten-db6477fc.json']) {
  const proc=spawnSync('node',[APPLY,'--dry-run','--schema',path.join(ROOT,'eval/fixtures',fixture),'--json'],{cwd:ROOT,encoding:'utf8',env:{...process.env,JEV_APPLY_HOME:'/tmp/jev-bench'}});
  const out=JSON.parse(proc.stdout||'{}');
  check(`${fixture}: dry-run uses at most six requests`,proc.status===0&&out.requests>0&&out.requests<=6&&(out.usage?.jev?.requests??out.requests)<=6&&out.rows?.length>0);
  check(`${fixture}: every row carries understanding and selection audit fields`,out.rows?.every(r=>r.understood_kind&&r.asks_for&&Array.isArray(r.qualifiers)&&typeof r.third_party==='boolean'&&'conditional_on' in r&&'selected_item' in r&&'selection_noul' in r&&'option_noul' in r));
  if(!out.rows) console.log(`fixture status: ${out.reason??'missing plan'} ${out.detail??''}`);
}
const mem=emptyMemory();
mem.stories=[{id:'b.story.destination',text:'I am willing to relocate to Cyprus for this role.',title:'Cypriot relocation',source:'user',answers_questions:['Would you relocate to Cyprus?'],topics:['Cypriot relocation']}];
mem.facts=[{id:'f.user.a',value:'Example Person',source:'user',answers_questions:['What is your full legal name?'],topics:['identity']},{id:'f.user.city',value:'Example City',source:'user',answers_questions:['Where do you currently live?'],topics:['residence']}];
const q=(qid,label,type='text',options)=>({qid,label,type,options,required:true,control:type==='single_select'?'native_select':'text',selector:`#${qid}`});
const formPlan={job:{company:'Example Employer',title:'Engineer',location:'Remote'},questions:[q('cyprus','Would you relocate to Cyprus?','single_select',[{label:'Yes',value:'yes'},{label:'No',value:'no'}]),q('third','Have you worked at PwC?','single_select',[{label:'Yes',value:'yes'},{label:'No',value:'no'}]),q('qualifier','Describe your most complex LLM project.'),q('name','By what complete legal name should we identify you?'),q('city','In which city is your present residence?')]};
const base=resolveForm(formPlan,{mem});
const planned=await planWithJev({formPlan,...base,mem,canon:await loadCanon(),slug:'semantic-contract-fixture'});
const byId=Object.fromEntries(planned.decisions.map(d=>[d.qid,d]));
check('unseen Cypriot relocation resolves by story meaning, without a country lookup',byId.cyprus.selected_item==='b.story.destination'&&['fill','check'].includes(byId.cyprus.action)&&byId.cyprus.option==='Yes');
check('third-party employer is understood and asks without party-specific evidence',byId.third.third_party===true&&byId.third.action==='ask');
check('qualifier rejects unrelated saved material',byId.qualifier.action==='ask'&&byId.qualifier.understanding.qualifiers.includes('llm'));
check('unseen name phrasing maps to canonical name',byId.name.canon==='q.core.full_name'&&byId.name.selected_item==='f.user.a');
check('unseen residence phrasing maps to canonical location',byId.city.canon==='q.core.location_current'&&byId.city.selected_item==='f.user.city');
check('semantic stages use at most three requests',planned.requests<=3);
check('candidate limits leave room for explicit exits',canonCandidatesFor(formPlan.questions[0],await loadCanon()).length<=16&&parentCandidates(formPlan.questions.at(-1),formPlan.questions).length<=8);
let refusedInvalid=false;try {validateAnswer('bad',choice('Pick',withNone({a:'A'})),{type:'choice',choice:'a',confidence:1,probabilities:{a:0,[NONE]:1}});}catch{refusedInvalid=true;}
check('choice validation refuses non-argmax answers',refusedInvalid);
{
  const profile=emptyMemory();
  profile.facts=[{id:'f.identity.email',value:'qa@example.invalid',source:'user',answers_questions:['What is your personal email address?'],topics:['identity']},{id:'f.identity.location',value:'Dublin, Ireland',source:'user',answers_questions:['Where do you currently live?'],topics:['location']}];
  profile.preferences=[{id:'p.eeo',value:{gender:'decline',other_demographics:'decline'},source:'user'},{id:'p.notice_rule',value:{kind:'immediate'},source:'user',answers_questions:['When can you start?']},{id:'p.legal.restrictive_agreements',value:'No',source:'user',answers_questions:['Are you subject to a non-compete?']}];
  profile.answers=[{qid:'q.core.location_current',kind:'constant',value:'Remote',source:'user',answers_questions:['Where do you currently live?']}];
  profile.answers.push({qid:'q.core.email',kind:'constant',value:profile.facts[0].value,source:'user',answers_questions:profile.facts[0].answers_questions});
  profile.stories=[{id:'b.leadership',text:'I led a team of backend software engineers.',source:'user',answers_questions:['Describe your leadership experience.']}];
  profile.documents=[{id:'doc.resume',path:path.join(ROOT,'eval/fixtures/preflight-memory.json'),kind:'resume'}];
  const options=[{label:'Yes',value:'yes'},{label:'No',value:'no'}];
  const regression={job:{company:'GitLab',title:'Engineer',location:'Dublin, Ireland'},questions:[
    q('history','Have you previously worked at or consulted for GitLab?','single_select',options),
    q('hardware','Have you been a technical lead for datacenter hardware products through new product introduction (NPI)?','single_select',options),
    q('signin','If you were previously employed by Remote, share the email you used to sign in. If not, please put N/A.'),
    q('consent','I consent to processing my demographic self-identification data.','single_select',options),
    q('gender','What is your gender?','single_select',[{label:'Decline to self identify',value:'decline'},{label:'Woman',value:'woman'},{label:'Man',value:'man'}]),
    q('firstgen','Are you a first-generation professional?','single_select',[...options,{label:'Prefer not to say',value:'decline'}]),
    q('resume','Resume','file'),q('place','Current Location'),q('date','When can you start?','date'),
    q('restrictive','Are you subject to a non-compete?','single_select',options),
    q('email','Email'),
  ]};
  const result=await planWithJev({formPlan:regression,...resolveForm(regression,{mem:profile}),mem:profile,canon:await loadCanon(),pipeline:{jobs:[{company:'GitLab',status:'applied'}]},slug:'framework-regression-fixture'});
  const d=Object.fromEntries(result.decisions.map(row=>[row.qid,row]));
  for(const id of ['history','hardware','signin','consent'])check(`regression: confirmed unsupported ${id} fill remains refused`,!['fill','check','draft'].includes(d[id].action));
  check('regression: EEO subanswers and other-demographics remain usable without inferring a characteristic',['gender','firstgen'].every(id=>['fill','check'].includes(d[id].action)&&d[id].selected_item.startsWith('p.eeo.')&&d[id].option));
  check('regression: document kind resolves an existing saved résumé',d.resume.understood_kind==='document'&&d.resume.source==='document'&&d.resume.action==='fill');
  check('regression: current location uses the stated place, not a stale canonical work mode',['fill','check'].includes(d.place.action)&&d.place.value==='Dublin, Ireland');
  check('regression: factual legal preference survives kind filtering',['fill','check'].includes(d.restrictive.action)&&d.restrictive.option==='No');
  check('regression: a copied canonical value does not split confidence away from its authoritative fact',['fill','check'].includes(d.email.action)&&d.email.source==='fact'&&d.email.value==='qa@example.invalid');
  check('regression: relative start date carries its premise and reference date',d.date.value===d.date.derivation?.reference_date&&d.date.derivation?.rule?.days===0&&d.date.derivation?.premise);
  d.date.readback={ok:true,observed:d.date.value};
  await verifyDecisions({decisions:[d.date],formPlan:regression});
  check('regression: derived immediate date passes semantic verification',d.date.verified?.ok===true);
  const items=memoryItems(profile);
  check('regression: narrative recall includes facts preferences answers and stories',new Set(itemCandidates({items},'narrative').map(item=>item.source)).size===4);
  const inclusive=await mapOptions({rows:[{question:q('inclusive','Which ethnicity do you identify with?','multi_select',[{label:'Asian or Asian American'},{label:'Black or African American'},{label:'I prefer not to answer'}]),answer_text:'Asian',sensitive:true}]});
  check('regression: an inclusive option accepts a stated alternative without inventing a subgroup',inclusive.mapped.inclusive.option==='Asian or Asian American'&&inclusive.mapped.inclusive.action!=='ask');
}
{
  const fixture = (name) => JSON.parse(readFileSync(path.join(ROOT, "eval", "fixtures", name), "utf8"));
  const FORM = fixture("preflight-form.json");
  const MEM = fixture("preflight-memory.json");
  const CLEAN = fixture("preflight-decisions-clean.json");
  for (const d of CLEAN.decisions) {
    if(d.class==='sensitive') d.readback={...d.readback,observed_matches:true};
    else if(['fill','check','draft'].includes(d.action)) {d.verified={noul:1,ok:true};d.readback={...d.readback,ok:true};}
    if(d.qid==='location') d.canon='q.core.location_current';
    if(d.qid==='restrictive_detail') d.understanding={conditional_on:'restrictive',scores:{conditional_active:0}};
  }

  /** The clean record with one row replaced by `patch` (`null` deletes the row). */
  const withRow = (qid, patch) =>
    CLEAN.decisions.map((d) => (d.qid === qid ? (patch === null ? null : { ...d, ...patch }) : { ...d })).filter(Boolean);

  const run = (decisions, { questions = FORM.questions, mem = MEM, live = null, submit = null } = {}) => preflight({ decisions, questions, mem, live, submit });
  /** Did exactly this rule refuse, and did it say so in one actionable line naming the row? */
  const refused = (report, rule, qid) => {
    const hit = report.failures.find((f) => f.rule === rule && (qid === undefined || f.qid === qid));
    return (
      report.ok === false &&
      Boolean(hit) &&
      hit.message.length > 0 &&
      !hit.message.includes("\n") &&
      hit.message.includes(hit.label.slice(0, 12))
    );
  };

  const clean = run(CLEAN.decisions);
  check(
    `guard: preflight — the clean record passes every rule it has an input for (checked ${clean.checked.length}, unchecked ${clean.unchecked.length})`,
    clean.ok === true && clean.checked.length === RULES.length - 1 && clean.unchecked.map((u) => u.rule).join() === "overlay_over_submit",
  );

  check(
    "guard: sensitive_source — a demographic row filled from a saved story is refused",
    refused(run(withRow("gender", { source: "story", why: "b.story.latency" })), "sensitive_source", "gender"),
  );
  check(
    "guard: sensitive_source — p.eeo and the user's own answer are the two sources it accepts",
    run(withRow("gender", { source: "user", why: "you answered — remembered" })).ok === true &&
      run(withRow("gender", { source: "answer", why: "q.eeo.gender (canon)" })).failures.some((f) => f.rule === "sensitive_source"),
  );

  check(
    "guard: policy_gate_source — an attestation ticked from the canonical answer bank is refused",
    refused(run(withRow("privacy_ack", { source: "answer", why: "q.legal.privacy_consent (canon)" })), "policy_gate_source", "privacy_ack"),
  );
  check(
    "guard: policy_gate_source — the p.legal.<slug> stance the user signed passes, a neighbouring preference does not",
    clean.ok === true && run(withRow("privacy_ack", { why: "p.eeo.other_demographics (global)" })).failures.some((f) => f.rule === "policy_gate_source"),
  );
  // `SENSITIVE_RE` claims a pronouns field, but `pronounRow()` answers it from the volunteered
  // `f.identity.pronouns` fact when no `p.eeo` block carries one — a phrase the user wrote on
  // their own CV, and the one sensitive-classed row this rule must not hold a submit over.
  check(
    "guard: sensitive_source — a pronouns row stated as f.identity.pronouns passes; any other fact does not",
    run([...CLEAN.decisions, { qid: "pronouns", label: "Pronouns", class: "sensitive", source: "fact", action: "fill", topic: "eeo", why: "f.identity.pronouns", value: "they/them", readback: {ok:true,observed_matches:true} }]).ok === true &&
      run([...CLEAN.decisions, { qid: "pronouns", label: "Pronouns", class: "sensitive", source: "fact", action: "fill", topic: "eeo", why: "f.identity.full_name", value: "they/them" }]).failures.some(
        (f) => f.rule === "sensitive_source" && f.qid === "pronouns",
      ),
  );

  check(
    "guard: draft_gates — a draft carrying no relevance verdict is refused",
    refused(run(withRow("why_us", { gates: undefined })), "draft_gates", "why_us"),
  );
  check(
    "guard: draft_gates — a narrative draft needs both gates; why_us is exempt from the grounding one only",
    run(withRow("why_us", { gates: { kind: "narrative", draft: 0.9 } })).failures.some((f) => f.rule === "draft_gates") &&
      run(withRow("why_us", { gates: { kind: "narrative", draft: 0.9, grounding: 0.8 } })).ok === true,
  );

  check(
    "guard: fact_from_writer — a fact about the user composed by the writer is refused",
    refused(run(withRow("languages", { source: "writer", why: "drafted from your saved facts and stories" })), "fact_from_writer", "languages"),
  );

  check(
    "guard: dependency_child_filled — a child answered while its parent is still open is refused",
    refused(
      run(
        withRow("restrictive", { action: "ask", source: "none", value: undefined, option: undefined }).map((d) =>
          d.qid === "restrictive_detail" ? { ...d, action: "fill", source: "user", value: "None." } : d,
        ),
      ),
      "dependency_child_filled",
      "restrictive_detail",
    ),
  );
  check(
    "guard: dependency_child_filled — a child needs a passing parent-activation judgment",
    refused(run(withRow("restrictive_detail", { action: "fill", source: "user", value: "None." })), "dependency_child_filled", "restrictive_detail") &&
      run(
        withRow("restrictive_detail", { action: "fill", source: "user", value: "A one-year non-solicit.", readback:{ok:true}, verified:{noul:1,ok:true}, understanding:{conditional_on:"restrictive",scores:{conditional_active:1}} }).map((d) =>
          d.qid === "restrictive" ? { ...d, value: "Yes", option: "Yes" } : d,
        ),
      ).ok === true,
  );

  check(
    "guard: work_mode_as_location — a work mode in the location row is refused, a city is not",
    refused(run(withRow("location", { value: "Remote" })), "work_mode_as_location", "location") && clean.ok === true,
  );

  check(
    "guard: prose_into_date_control — a date control holding prose is refused, an ISO day is not",
    refused(run(withRow("start_date", { value: "Immediately" })), "prose_into_date_control", "start_date") &&
      run(withRow("start_date", { value: "2027-01-04" })).ok === true,
  );

  check(
    "guard: required_empty — a required row the plan leaves open is refused",
    refused(run(withRow("languages", { action: "ask", source: "none", value: undefined, readback: undefined })), "required_empty", "languages"),
  );
  check(
    "guard: B2 required_empty — the live snapshot outranks the plan: a control empty on the page refuses the submit",
    run(CLEAN.decisions, {
      live: { unfilled: [{ row: { label: "Start date" }, decision: { qid: "start_date", label: "Start date" } }], unknown: [] },
    }).failures.some((f) => f.rule === "required_empty" && f.qid === "start_date") &&
      run(CLEAN.decisions, { live: { unfilled: [], unknown: [{ qid: "new_row", label: "If other, please specify" }] } }).failures.some(
        (f) => f.rule === "required_empty" && f.qid === "new_row",
      ),
  );

  check(
    "guard: readback_failed — a write the page never confirmed is refused",
    refused(run(withRow("first_name", { readback: { ok: false, observed: "", attempts: 2 } })), "readback_failed", "first_name"),
  );

  check(
    "guard: name_split_blind — a name split out of the full name is refused while both halves are on file",
    refused(run(withRow("first_name", { why: "first name split from f.identity.full_name" })), "name_split_blind", "first_name"),
  );
  check(
    "guard: name_split_blind — with no first/last fact stated, the same split is the only answer there is",
    run(withRow("first_name", { why: "first name split from f.identity.full_name" }), {
      mem: { ...MEM, facts: MEM.facts.filter((f) => !/first_name|last_name/.test(f.id)) },
    }).ok === true,
  );

  check(
    "guard: preflight — a rule with no input to run on is reported unchecked, never passed silently",
    (() => {
      const bare = preflight({ decisions: CLEAN.decisions });
      const names = bare.unchecked.map((u) => u.rule);
      return (
        bare.ok === true &&
        names.includes("dependency_child_filled") &&
        names.includes("prose_into_date_control") &&
        names.includes("required_empty") &&
        names.includes("name_split_blind") &&
        names.includes("overlay_over_submit") &&
        bare.checked.length + bare.unchecked.length === RULES.length
      );
    })(),
  );

  // The gate as the runner calls it before step 12. A refusal must be a *no-click* marker: the
  // runner returns it instead of pressing Submit, `settle()` renders it as
  // `blocked{reason:"preflight"}`, and `clicked:false` keeps the double-submit guard saying this
  // posting was never attempted — a gate that cost the user their retry would be worse than none.
  check(
    "guard: B1 submit_preflight — a refused submit is a no-click marker carrying every failure",
    (() => {
      const bad = submitGate({ decisions: withRow("gender", { source: "story" }), questions: FORM.questions, mem: MEM });
      const good = submitGate({ decisions: CLEAN.decisions, questions: FORM.questions, mem: MEM });
      return (
        bad.ok === false &&
        bad.refusal.clicked === false &&
        bad.refusal.ok === false &&
        bad.refusal.cause === "preflight" &&
        bad.refusal.preflight.failures.length === bad.report.failures.length &&
        bad.refusal.detail === bad.report.failures[0].message &&
        good.ok === true &&
        good.refusal === null
      );
    })(),
  );

  // The CLI the user actually runs, over the fixture whose one defect is a demographic row filled
  // from a story: one JSON object on stdout, `ok:false`, and the rule named in it.
  check(
    "guard: sensitive_source — scripts/preflight.mjs refuses the tainted record and names the rule",
    (() => {
      const proc = spawnSync(process.execPath, [path.join(ROOT, "scripts", "preflight.mjs"), "--file", path.join(ROOT, "eval", "fixtures", "preflight-decisions-tainted.json")], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const out = JSON.parse(proc.stdout);
      return proc.status === 0 && out.ok === false && out.failures.some(f=>f.rule === "sensitive_source");
    })(),
  );
}

// ─── verify: a wrong DOM read-back is not a correct answer ────────────────────────────────
{
  const wrong = {qid:"wrong",label:"What is your full legal name?",class:"identity",action:"fill",source:"fact",value:"My strongest programming language is Rust.",selected:{item:"f.name",text:"Example Person",answers_questions:["What is your full legal name?"],topics:["identity"]},readback:{ok:true,observed:"My strongest programming language is Rust."}};
  const right = {qid:"right",label:"What is your email address?",class:"identity",action:"fill",source:"fact",value:"qa@example.invalid",selected:{item:"f.email",text:"qa@example.invalid",answers_questions:["What is your email address?"],topics:["contact"]},readback:{ok:true,observed:"qa@example.invalid"}};
  const sensitive = {qid:"sensitive",label:"Gender",class:"sensitive",action:"fill",source:"user",value:"protected-test-token",readback:{ok:true,observed:"",observed_matches:true}};
  const rows = [wrong,right,sensitive];
  let leaked = false;
  let cleared = false;
  const result = await verifyDecisions({
    decisions:rows,formPlan:{questions:rows.map(d=>({qid:d.qid,label:d.label,type:"text",control:"text"}))},
    page:{},slug:"semantic-verification-fixture",
    jev:async (request)=>{leaked=JSON.stringify(request).includes("protected-test-token");return systemOne(request);},
    clear:async ({question})=>{if(question.qid==="wrong")cleared=true;return {ok:true,cleared:true};},
  });
  check("verify: one batched request rejects an unrelated visible value and preserves the supported answer",result.requests===1&&wrong.action==="ask"&&wrong.verified.ok===false&&right.action==="fill"&&right.verified.ok===true);
  check("verify: rejected row is cleared through the safe-clear hook",cleared&&wrong.verify_clear?.ok===true);
  const refused = submitGate({decisions:rows});
  check("verify: deliberate wrong fill is refused by semantic_verify with clicked:false",!refused.ok&&refused.refusal.clicked===false&&refused.report.failures.some(f=>f.rule==="semantic_verify"&&f.qid==="wrong"));
  check("verify: sensitive values never enter the request and are verified by readback equality",!leaked&&verificationCounts(rows).ok===2&&verificationCounts(rows).total===3);
  const unchecked = preflight({decisions:[{...right,verified:undefined}]});
  check("verify: missing verdict is unchecked and cannot pass preflight",!unchecked.ok&&unchecked.unchecked.some(r=>r.rule==="semantic_verify"));
  const unproven = preflight({decisions:[{...sensitive,readback:{ok:true}}]});
  check("verify: sensitive readback without option-label equality cannot pass",!unproven.ok&&unproven.failures.some(r=>r.rule==="sensitive_readback"));
  const keys = expectedRows(rows);
  check("verify: expected rows carry the same semantic verdict",keys[0].verified.ok===false&&keys[1].verified.ok===true);
  const graded = judgmentMetrics([{action:"ask",store_had_it:true},{action:"ask",store_had_it:false}]);
  check("verify: an available empty answer is missed and an absent answer is couldnt",graded.missed===1&&graded.couldnt===1&&graded.miss_rate===1&&graded.blocked_rate===0.5);
  const rejected = judgmentMetrics([{...wrong,store_had_it:true},{action:"ask",class:"policy_gate",store_had_it:true},{action:"ask",control:"unknown",store_had_it:true}]);
  check("verify: couldnt never masks a semantic rejection when memory had the answer",rejected.missed===1&&rejected.couldnt===2);
  const audit = await auditMemory({home:"/tmp/jev-bench",slug:"memory-audit-fixture",mem:{facts:[{id:"f.name",value:"Example Person",source:"user",answers_questions:["What is your full legal name?"],topics:["identity"]}]},
    decisions:[{qid:"name",label:"What is your full legal name?",action:"ask"},{qid:"salary",label:"What annual salary do you want?",action:"ask"}]});
  check("verify: frozen-store selection audit distinguishes an available name from an unstated salary",audit.requests===1&&audit.rows[0].store_had_it===true&&audit.rows[1].store_had_it===false&&audit.metrics.missed===1&&audit.metrics.couldnt===1);
  const unreachable = {...right};
  await verifyDecisions({decisions:[unreachable],formPlan:{questions:[right]},jev:async()=>{throw new Error("unavailable");}});
  const held = preflight({decisions:[unreachable]});
  check("verify: an unreachable model reverts the row to ask and records an unchecked refusing gate",unreachable.action==="ask"&&unreachable.verified.ok===false&&!held.ok&&held.unchecked.some(r=>r.rule==="semantic_verify"));
}

if(failures) {console.log(`\n${failures} assertions failed`);process.exitCode=1;} else console.log("\nall assertions passed");
