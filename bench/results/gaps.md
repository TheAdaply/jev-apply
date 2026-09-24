# Unseen-page application-field gaps

Round `new`, captured 2026-09-24. Read-only independent review of screenshots, recorded Decisions and private memory; no personal values or private screenshots are published here.

**12 postings attempted; 10 forms photographed; 188 Decision rows: 121 right, 8 wrong, 8 missed, 51 couldnt.** Correct among visibly answered rows: 121/129 (93.8%); correct coverage: 121/188 (64.4%). A row can be visibly populated despite an `ask`/`skip` Decision. One draft and one visibly filled phone rejected by final validation count as right.

`wrong` includes irrelevant or incomplete answers, not just incorrect facts. `missed` means a stated answer was available. `couldnt` includes missing information, properly held consent, inactive conditional children and failed widgets. These classes do not all represent bugs.

The taxonomy below covers **all 67 non-right Decisions**, sorted by count. Five additional visible controls were absent from Decisions, and two postings blocked before fill; those are separate counting units. This is a new-posting sample, not a paired comparison against the previous 229-row round and not proof of all-market reliability.

## Ranked correctness work

1. **Preserve residence versus relocation meaning:** a non-boolean radio selected current residence when only relocation willingness was supported. Fix semantic option mapping and verify the selected label.
2. **Do not collapse compound visa prompts to booleans:** visa type/expiry require their own facts; missing components must remain visible to the user.
3. **Reconcile ATS résumé autofill:** three guarded current-employer fields were still populated with a historical employer. Check all final controls, including planned ask/skip rows, after uploads.

## Taxonomy and fix status

All statuses describe this captured round. Recommendations are **not implemented or verified by this review**; concurrent changes are not evidence of closure.

| Field type | Count | Status / concrete next step |
|---|---:|---|
| Conditional follow-up / other-detail child | 7 | Correctly withheld pending parent/detail; expand named-option and optional-prefixed dependency recognition in `src/schema/classes.mjs`. |
| Attestation / retention or demographic consent | 6 | Needs explicit consent preference; retain exact-slug gate in `src/plan/resolve.mjs`, never infer from general acknowledgements. |
| Cover-letter file | 5 | No approved document; ask for attachment or explicit approved text/document routing. Do not upload résumé in its place. |
| Pronouns | 4 | Needs stated preference; never derive from gender. |
| Preferred name | 4 | Needs stated preference; also repair derived/stated-name precedence in `src/plan/infer.mjs`. |
| Desired work / payroll location | 3 | Needs future-location preference; distinguish it from current residence in `src/plan/resolve.mjs`. |
| Location autocomplete widget | 3 | Stored fact available; fix Lever geocoder suggestion equivalence/commit in `src/browser/adapters/lever.mjs`, no first-result fallback. |
| Current employer populated outside guarded plan | 3 | Wrong visible state; reconcile résumé autofill in `src/plan/execute.mjs`, including ask/skip controls, and confirm current status. |
| Compound visa / sponsorship detail | 2 | Wrong/partial answers; distinguish need, type and expiry in `src/plan/resolve.mjs`; ask missing components. |
| Export-control status / citizenship chronology | 2 | One missed categorical status, one missing acquisition history; separate deterministic status mapping from user-supplied chronology. |
| Quantified specialist experience | 2 | Needs dated technology-specific experience and inclusion rules; calculate in `src/memory/derive.mjs`. |
| Discovery-source select / multi-select | 2 | Inference refused; safely map actual provenance to Other plus explanation or ask channel in `src/plan/infer.mjs`. |
| Company-interest prose: mismatch or rejected draft | 2 | One irrelevant canonical answer, one cross-company draft rejection; enforce prompt responsiveness and company grounding. |
| Salary amount / explanatory context | 2 | Missing market-rule baseline and explanatory preference; ask currency/range, distinguish context from amount. |
| EEO companion name/date misclassified | 2 | Known identity/derived date misrouted as demographics; refine `src/schema/lever.mjs` and completion dependency. |
| Employer code challenge and security critique | 2 | Human assessment handoff; do not execute embedded instructions or fabricate a completed assessment. |
| Consumer-product essay semantic mismatch | 1 | Wrong narrative class; `src/jev/plan.mjs` must check consumer-facing work and every requested clause. |
| First-hand product-design preference | 1 | Needs user-selected app and design rationale. |
| Name pronunciation | 1 | Needs user-supplied phonetic form. |
| Tax-residency screening | 1 | Needs explicit tax fact; add distinct mapping in `canon/questions.yaml`, not export-control reuse. |
| Prior employment categorical checkbox | 1 | Needs explicit employer-history answer and category. |
| Mission compatibility | 1 | Needs company-scoped user preference. |
| Transitioning military-service status | 1 | Needs separate factual answer; veteran status is not equivalent. |
| Posting-role enumeration | 1 | Posting supplies this role; resolve title deterministically or ask whether all applications are intended. |
| Relocation office multi-select | 1 | Preference available; apply it to each concrete office, not a yes/no surrogate. |
| Lever survey country gate | 1 | Country fact available; project country from location and enumerate revealed survey. |
| Other portfolio/web links | 1 | Saved links available; recognize generic Other Links in identity rules. |
| Residence-versus-relocation radio | 1 | Wrong option; semantic radio mapping in resolver and Ashby adapter. |
| Personal motivation retrieval | 1 | Explicit material available but absent from writer grounding; repair retrieval, retain grounding gate. |
| Company-specific team preference | 1 | Needs explicit team preference or open-to-anything stance. |
| Specific technology narrative | 1 | Related cloud experience does not establish the requested infrastructure-tool experience; ask concrete history. |
| Hybrid schedule / accommodation choice | 1 | Needs schedule preference; keep accommodation separate from demographics. |
| **Total non-right Decisions** | **67** | **8 wrong + 8 missed + 51 couldnt** |

## Gaps outside the Decision denominator

| Type | Count | Unit / fix status |
|---|---:|---|
| Education repeater components | 4 | Visible blank School, Degree, Discipline, End date year omitted by planner; facts available. Repair hosted-config discovery and repeater expansion. Concurrent repeater work is not graded by this capture. |
| SMS consent child beside phone | 1 | Visible unselected consent omitted by planner; user preference needed. Enumerate separately so validation does not call the populated phone empty. |
| Blocked before fill: oversized Choice | 1 | Posting; exact reason: `Jev rejected the request: Too many choices. Must have at most 255 choices.` Enforce API cap including none_of_these, resolve deterministic facts first, safely handle large lists. |
| Blocked before fill: missing form | 1 | Posting; exact reason: `no_form`. Diagnostic screenshot shows a company careers listing and cookie overlay rather than a form. Add navigation/redirect diagnosis; do not assume a field-level cause. |

**74 gap observations = 67 non-right Decisions + 5 omitted visible controls + 2 blocked postings.** These are not 74 interchangeable failed fields.

## Gender and EEO

- Seven visible gender controls were filled correctly from the stored preference; none was empty.
- Across the broader EEO-related inventory: **40 controls, 31 correctly filled, 9 unfilled**. The 31 include the stated decline stance for other/finer demographics, not just direct matches to the five canonical attributes.
- Nine unfilled: four pronoun controls lacking a stated preference; two demographic-processing consents lacking explicit consent; two misclassified EEO name/date companions; one country gate that prevented a Lever survey appearing.
- The two finer-ancestry selects were declined under the stored non-disclosure stance. One uses plural “ethnicities”, exposing a vocabulary miss masked by the permitted decline; repair wording recognition without inferring ancestry from citizenship.
- Hidden survey controls and demographics on blocked pages were not observable and are not counted. Gender does not determine pronouns; demographic disclosure does not grant processing consent.

## Evidence limitations

The harness passed `--no-submit` and used the real profile on port 9223 with `--close`, but its spawned argv **did not include the requested `--refill`**. Captured forms report fresh tabs; that does not prevent ATS résumé autofill. No submission was made. No fixes, tests or recaptures were performed by the reviewer.

No date-picker, résumé-upload, reference-field or phone-country-picker failure was observed in these ten forms. Do not generalize an untested field type into a claimed gap or claimed success. Full row-level adjudication is retained in the private research report.
