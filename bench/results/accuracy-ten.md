# jev-apply — ten-posting accuracy report

Source: the machine-readable JSON block at the end of
[`docs/research/16-eval-judge-ten.md`](../../docs/research/16-eval-judge-ten.md) (per-posting
`rows_total`/`correct`/`wrong`/`missing`/`questionable`/`filled`/`asks`/`ms_total`/`usd_total`),
joined against [`private/eval-shots/ten/index.md`](../../private/eval-shots/ten/index.md) for
company/family/ATS. 10 postings, 136 Decision rows, real profile, `--no-submit`. No personal value
appears below — only slugs, companies, counts, milliseconds, and dollars.

`fill accuracy` is `(filled - wrong) / filled` — the fraction of rows the runner actually wrote to
that were not wrong (a `questionable` fill still counts, since the runner did write something
defensible; a `missing` row is not in the filled set at all by definition).

## Per posting

| # | company | family | ATS | fields | correct | wrong | missing | accuracy % | fill accuracy % | asks | time s | cost $ |
|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | together-ai | ml_engineer | greenhouse | 10 | 10 | 0 | 0 | 100.0 | 100.0 | 0 | 9.9 | $0.000000 |
| 2 | tenstorrent | ml_engineer | greenhouse | 15 | 14 | 0 | 1 | 93.3 | 100.0 | 2 | 15.9 | $0.000246 |
| 3 | graphcore | research_engineer | greenhouse | 17 | 15 | 0 | 0 | 88.2 | 100.0 | 4 | 14.3 | $0.000273 |
| 4 | scale-ai | research_scientist | greenhouse | 20 | 18 | 0 | 2 | 90.0 | 100.0 | 3 | 19.5 | $0.000241 |
| 5 | modal | research_engineer | ashby | 4 | 4 | 0 | 0 | 100.0 | 100.0 | 1 | 4.4 | $0.000242 |
| 6 | d-matrix | inference | ashby | 10 | 9 | 0 | 1 | 90.0 | 100.0 | 0 | 8.7 | $0.000248 |
| 7 | decagon | research_engineer | ashby | 10 | 9 | 0 | 1 | 90.0 | 100.0 | 3 | 7.5 | $0.000474 |
| 8 | cerebras | research_scientist | ashby | 11 | 10 | 0 | 1 | 90.9 | 100.0 | 1 | 11.1 | $0.000496 |
| 9 | mistral | applied_scientist | ashby | 19 | 16 | 2 | 0 | 84.2 | 86.7 | 2 | 20.6 | $0.006118 |
| 10 | snowflake | research_scientist | ashby | 20 | 17 | 1 | 2 | 85.0 | 92.9 | 5 | 15.1 | $0.001175 |
| | **totals (10)** | | | **136** | **122** | **3** | **8** | **89.7** | **97.1** | **21** | **126.9** | **$0.009513** |
| | **medians** | | | 13.0 | 12.0 | 0.0 | 1.0 | 90.0 | 100.0 | 2.0 | 12.7 | $0.000260 |

![Per-posting verdicts, time, and cost](accuracy-ten.png)

## Reading the numbers

Accuracy runs 84.2–100% per posting, median 90.0%, with the two ATS families tracking closely
(greenhouse median 91.65%, ashby median 90.0%) — this is not a per-vendor gap. Fill accuracy is a
different story: 8 of 10 postings hit 100.0%, because the runner's dominant failure mode is
under-writing (a required field left empty) rather than writing something false — `missing` (8
rows) outweighs `wrong` (3 rows) by more than 2.5×. The two postings below 95% fill accuracy
(mistral 86.7%, snowflake 92.9%) both carry `wrong` rows, and mistral alone accounts for 2 of the 3
wrong rows in the whole corpus. Cost and time both concentrate on the same posting: mistral is the
only run that reached the writer (one drafted paragraph), and that one call is 64.3% of the round's
total spend and the slowest wall-clock run. Every other posting's cost is Jev selection only —
sub-$0.0005 and under 20 seconds.

## Three systematic causes

- **Canonical fact IDs the resolver looks up don't exist on the real profile.** The resolver reads
  fixed ids like `f.employment.current`/`f.employment.current_title`, but the real memory store uses
  descriptive ids (one per employer/school) instead — so a required job-title, employer, or school
  field comes back empty even though the fact is on file, across three separate postings.
- **A draft was accepted from grounding that never mentions the question's subject.** A required
  free-text fact question was classified as prose, handed to the writer with an unrelated story as
  its only grounding, and the writer produced a self-defeating disclaimer instead of the invariant-
  required `ask` — the single costliest and worst-graded row in the round.
- **Canonical question matching drops the topic qualifier in the label.** A question that names a
  specific technology collapsed onto a topic-free saved answer instead of a topic-matching one,
  even though memory held several answers that actually matched the qualifier — a responsive answer
  existed and a non-responsive one was used instead.
