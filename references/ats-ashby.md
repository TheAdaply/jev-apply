# Ashby (hosted applications)

What `src/schema/ashby.mjs` and `src/browser/adapters/ashby.mjs` actually implement, for
`jobs.ashbyhq.com/<org>/<uuid>/application` postings.

## Detection

```
ASHBY_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
```

## Schema endpoint

```
POST jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting
```
with the exact GraphQL document captured from DevTools, checked into
`eval/fixtures/ashby-query.graphql`. Two things about that document are load-bearing, not
stylistic:
- Introspection is disabled on this endpoint — the document cannot be regenerated from a schema
  fetch, only recaptured from a real request.
- `applicationForm.sections[].fieldEntries[].field` is a `JSON!` scalar. A typed sub-selection
  (`field { id label }`) fails with `GRAPHQL_VALIDATION_FAILED`; the document must request `field`
  bare and destructure it in code.

The endpoint 429s above ~6 concurrent requests, so `fetchAshby()` is gated through an internal
`withSlot()` queue capped at `MAX_CONCURRENT = 3` — every caller (schema fetch and `canon-scan.mjs`)
shares that limit; nothing in this module ever exceeds it.

## DOM selectors (verified live against baseten/db6477fc, anyscale/1cf38233, fireworks/fc3845e6 — 2026-09-22)

Every field sits inside `div.ashby-application-form-field-entry[data-field-path="<field.path>"]`
with `<label for="<path>">`, and every FormPlan `selector` is scoped by that `data-field-path`
attribute (Ashby field-path UUIDs start with a digit, so `#<path>` is invalid CSS — use
`[id="<path>"]`, same escaping rule as Greenhouse's demographic ids).

| Field type | Selector |
|---|---|
| String / Email / Phone / Url / Number | `input.ashby-application-form-input-text`, `id === name === path` |
| Date / Location (autocomplete) | `input.ashby-application-form-input-{date,autocomplete}` — neither carries its own `id`/`name`, so these two are addressed through the container scope, not the input |
| LongText | `textarea.ashby-application-form-input-textarea` |
| File (résumé) | `input[type=file]` (no distinguishing class) plus a dropzone button |
| Boolean | two `button.ashby-application-form-input-yesno-option` (`data-option=yes\|no`, `aria-pressed`) sitting over a **hidden checkbox** — not a radio group |
| ValueSelect (single choice) | n × `input[type=radio].ashby-application-form-input-radio-group-option-radio`, every one carrying `value="on"` — the adapter must pick by the rendered label text, never by `value` |
| MultiValueSelect | n × `input[type=checkbox]`, same by-label rule |

EEO/consent fields (`_systemfield_eeoc_*`) are rendered from a separate `surveyForms` query this
document does not request: they exist on the live page but never appear in the `FormPlan` and are
never marked `required` — the planner cannot see them at all, so there is nothing to skip.

## Résumé chip readback

`input#_systemfield_resume` stays in the DOM after upload (unlike Greenhouse, which removes it) and
Ashby renders a chip a beat later inside the field's own entry container:
`scope.locator('[class*="ashby-application-form-input-file-item-name"], [class*="file-item-name"]')`,
`scope` being the `data-field-path` container located via `scopeFor()`. The read-back falls back to
`input.files[0].name` and finally to a substring check on the container's full text if neither chip
class renders, before declaring the upload not observed.

## Boolean and radio commit semantics

- Boolean: click the `button[data-option=yes|no]` whose `data-option` matches the wanted value, then
  confirm via `aria-pressed="true"` on that button (`pressedOption()`), not via the hidden checkbox's
  `checked` state, which Ashby only sets for "yes".
- Radios: every option's `value` attribute is the literal string `"on"` — matching by `value` would
  make every option indistinguishable. The adapter reads each option's `label[for$="-radio-N"]`
  text (`labelsOf()`), picks by label, and never clicks index 0 on an unmatched answer.
