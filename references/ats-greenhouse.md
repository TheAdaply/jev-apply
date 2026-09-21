# Greenhouse (hosted boards)

What `src/schema/greenhouse.mjs` and `src/browser/adapters/greenhouse.mjs` actually implement, for
`job-boards.greenhouse.io/<token>/jobs/<id>` and `boards.greenhouse.io` postings.

## Detection

```
GREENHOUSE_RE = /^https?:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i
```
Embedded boards (`iframe#grnhse_iframe` on a company's own site) are **not** matched — v1 is the
hosted form only; those URLs come back `blocked{reason:"unsupported_ats"}`.

## Schema endpoint

```
GET boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true&pay_transparency=true
```
Response blocks (all optional): `questions` (the application form itself), `location_questions`
(Pelias autocomplete + hidden lat/long), `compliance[].questions` (EEOC), `demographic_questions`
(the U.S. standard demographic survey). `--record-schema` saves the raw JSON to
`eval/fixtures/greenhouse-<token>-<shortId>.json`.

## DOM selectors (verified live, 2026-09-22)

| Field | Selector |
|---|---|
| text / tel | `#first_name`, `#phone` (type=tel), `#question_<id>` |
| react-select | `input#<name>[role=combobox]` inside `.select__control`/`.select-shell`; options render into `#react-portal-mount-point` |
| résumé file | `input#resume[type=file]` (visually hidden; the `<label>` is the click target) |
| location | `#candidate-location` — the API field is called `location`, the DOM id is not; it's a Pelias autocomplete, i.e. a react-select with no fixed option list |
| EEO / demographic | `#gender`, `#veteran_status`, `#<demographic question id>` — the API's `race` question is a two-step pair: `#hispanic_ethnicity` renders first, `#race` only appears once that is answered |

A demographic question's DOM id can be a bare number (`"4012865007"`), and `#4012865007` is a
`SyntaxError` in `querySelector`, not a miss — the adapter falls back to `[id="…"]` whenever the id
fails `/^[A-Za-z_][\w-]*$/`.

## The react-select listbox-id finding

react-select renders its option list either inline or into a shared portal
(`#react-portal-mount-point`), and which one happens is not something the schema response predicts.
The listbox element's `id` is stable either way — `react-select-<inputId>-listbox` — so the adapter
queries both:

```js
const optionSelector = inputId
  ? `[id="react-select-${inputId}-listbox"] [role="option"], #react-portal-mount-point [role="option"]`
  : '#react-portal-mount-point [role="option"]';
```

Two more things the live form requires:
- **Never Escape or `fill("")`** to clear the search box — both trigger react-select's own
  `backspaceRemovesValue` and clear the already-committed value. Use `input.blur()` instead.
- **Never option 0.** Typing a search term filters the menu by *substring*, so "No" leaves both
  "No, I do not…" and "Yes, I will…" visible (the latter contains "now"). The adapter always matches
  the rendered option's label text (`pickOption`) and only commits the exact match; an unmatched
  value leaves the control untouched and reports `no_matching_option`.
- **Commit check**: after a click, wait for `.select__single-value` to hold the wanted text *and*
  for react-select's `input[class*="requiredInput"]` marker (rendered while a required select is
  still empty) to be gone or non-empty.

## Résumé chip readback

Greenhouse's résumé field is `div.file-upload` (a heading plus `.file-upload__wrapper`); once a
file is attached, Greenhouse removes the `<input type=file>` and renders `.file-upload__filename`
in its place — that chip is the read-back target. Because the **cover letter field has an identical
structure**, the adapter locates the specific `.file-upload` block that contains the target
selector (`document.querySelectorAll(".file-upload")`, indexed) before reading its chip, rather
than matching the first filename chip on the page. Greenhouse also briefly re-mounts the block once
the upload finishes, so the read-back settles for ~400 ms and re-confirms before returning `ok`.

## Question classification specifics

`src/schema/classes.mjs`'s regex lists are shared across both ATSs; two Greenhouse-specific label
patterns live in `greenhouse.mjs` itself: `URL_LABEL_RE` (LinkedIn/GitHub/portfolio/website/Twitter/
Google Scholar) and `PHONE_LABEL_RE` (phone/mobile/contact number) — used to pick `control:"tel"`
vs `control:"text"` for otherwise-generic text fields, and compliance labels such as
`"VeteranStatus"` are humanized (`VeteranStatus` → `Veteran Status`) before classification.
