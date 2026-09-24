# Twelve never-seen job pages

![Per-posting verdicts, time and cost, baseline against final](fresh-pages.png)

## Method

Twelve real, currently-open job postings the runner had never touched — six hosted Greenhouse boards
and six Ashby boards, twelve different companies across nine role families. Each was filled end to end
by `scripts/apply.mjs` against a real user profile and a real Chrome session, exactly as a user would
run it. **No application was submitted:** the screenshot harness passes `--no-submit` to every child
run, so no Submit control was ever clicked, on any posting, in either round.

Every posting was then photographed — the whole form plus one viewport-width capture per scroll step,
100 images in the final round. An independent judge with no access to the run that produced the fills
graded **every Decision row from those screenshots**, against the user's own saved memory, using one
fixed vocabulary:

- **right** — the row is filled, and the value is correct for that question and that candidate.
- **wrong** — the row is filled, and the value is incorrect.
- **missed** — the row is empty, and the saved store answered it.
- **couldn't** — the row is empty because nothing was on file, or a policy gate correctly refused to
  sign something on the user's behalf, or the control could not take the answer.

The point of grading from photographs rather than from the runner's own log is that the two can
disagree, and when they do the form is what a recruiter sees. The same twelve postings were captured
twice — a **baseline** round, and a **final** round after the defects the baseline exposed were fixed.
Both columns below are the same 229 rows on the same twelve pages.

## Results

| # | company | family | ATS | rows | right | wrong | missed | couldn't | asks | s | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | twilio | ml_engineer | greenhouse | 16 | 11 | 0 | 0 | 5 | 4 | 30.1 | 0.000281 |
| 2 | gitlab | backend | greenhouse | 19 | 14 | 0 | 0 | 5 | 3 | 34.4 | 0.000675 |
| 3 | gusto | ml_engineer | greenhouse | 23 | 16 | 0 | 3 | 4 | 5 | 40.0 | 0.000981 |
| 4 | remote-com | product_manager | greenhouse | 24 | 15 | 0 | 2 | 7 | 8 | 42.4 | 0.000527 |
| 5 | vercel | infra_sre | greenhouse | 24 | 21 | 0 | 0 | 3 | 2 | 46.7 | 0.000718 |
| 6 | discord | security | greenhouse | 26 | 22 | 0 | 0 | 4 | 2 | 53.7 | 0.007138 |
| 7 | notion | security | ashby | 10 | 7 | 0 | 0 | 3 | 3 | 13.1 | 0 |
| 8 | harvey | backend | ashby | 15 | 10 | 0 | 0 | 5 | 4 | 17.3 | 0.000955 |
| 9 | plaid | data_engineer | ashby | 17 | 10 | 0 | 1 | 6 | 6 | 28.7 | 0.009891 |
| 10 | lambda | gpu_performance | ashby | 17 | 13 | 0 | 0 | 4 | 4 | 21.5 | 0.001134 |
| 11 | luma-ai | research_scientist | ashby | 18 | 17 | 0 | 0 | 1 | 0 | 23.7 | 0.000467 |
| 12 | openai | research_engineer | ashby | 20 | 12 | 0 | 1 | 7 | 7 | 22.9 | 0.001151 |
| | **totals** | | | **229** | **168** | **0** | **7** | **54** | **48** | **374.5** | **0.0239** |

**Zero wrong values across 229 rows on twelve live employer forms.** Every one of the 168 values the
runner put on a page is correct — 100 % of filled rows. Across all rows, including the ones nothing on
file could answer, 73.4 % are right.

Per posting: median **29.4 seconds**, median **$0.000837**, **4 questions** back to the user, and
**2 Jev requests** (27 across the whole run). The two expensive postings — discord and plaid, at
$0.0071 and $0.0099 — are the two that put a writer call on the critical path.

## Baseline → final

| | baseline | final |
|---|---|---|
| rows | 229 | 229 |
| right | 159 (69.4 %) | **168 (73.4 %)** |
| **wrong** | **6** | **0** |
| missed | 2 | 7 |
| couldn't | 62 | 54 |
| correct, of rows actually filled | 96.4 % | **100 %** |
| questions back to the user | 50 | 48 |
| Jev requests | 27 | 27 |
| wall clock, all twelve | 367.9 s | 374.5 s |
| spend, all twelve | $0.0286 | **$0.0239** |
| postings safe to submit unattended | 0 | 1 |

The six wrong rows the baseline produced were not cosmetic. Two were work-authorization answers that
came out the exact opposite of the truth, because the question scoped itself to where the *candidate*
lives and the runner answered for where the *employer* is. Two were demographic rows declined even
though the form offered an option stating the value the user had saved. One wrote a personal detail
into a row whose condition the user's own history never opened. One answered a data-processing consent
out of a standing "I decline to state my demographics", which is not a signature.

All six are closed, and closing them cost nothing: the final round asks *fewer* questions, makes the
same number of model requests, and spends 16 % less.

The `missed` column moved the other way, from 2 to 7. Five of those seven are rows where the form
prints its own answer for the candidate's case — a postal-code field that says what non-US applicants
should enter, a state-notice row whose second option is "I am not a resident", a location list whose
catch-all is the only truthful pick — and the runner refused them rather than guess. They are the next
thing to fix; none of them puts a wrong value on a page, which is the tradeoff this round was built to
make.

One caveat on that column, stated so the comparison is honest: the final round grades `missed` on a
stricter rule than the baseline report used. Six rows that were unanswered in **both** rounds move from
`couldn't` to `missed` under it. Applied to both sides, the baseline reads 8 missed / 56 couldn't, and
the final's `missed` is one *lower* than the baseline's, not five higher.

Raw per-posting numbers, including both rounds and the deltas, are in
[`fresh-pages.json`](fresh-pages.json).
