# URT passages API (`/api/urt`)

Generated URT exam passages with multiple-choice questions, and explanations for wrong answers.
Implementation: `server/routes/urtPassageRoutes.js`, `server/controllers/urtPassageController.js`,
services in `server/services/urt/`. Design: [PLAN.md](../urt-passage-generator/PLAN.md) §7–§9.

## Authentication and roles

Every route sits behind the platform's `userAuth` (plus `checkAgent` and the HMAC middleware for
mobile and desktop clients). The student is always `req.user.id`, never a body field. Student routes
require the `student` role; `/admin/*` requires an admin or teacher.

## Errors

All errors use one shape (OPEN-4: align with the platform's convention when confirmed):

```json
{ "error": { "code": "URT_INVALID_SUBJECT", "message": "Unknown subject 'history'" } }
```

| Status | Code | When |
|---|---|---|
| 400 | `URT_INVALID_SUBJECT` | `subject` is not one of `GET /subjects` |
| 400 | `URT_INVALID_SUBMISSION` | unknown question, a question answered twice, a label that is not an option, malformed body (`details` lists zod issues) |
| 400 | `URT_INVALID_JSON` | the body is not JSON |
| 400 | `URT_REASON_REQUIRED` | retiring without a reason |
| 403 | `URT_FORBIDDEN` | wrong role, or the serving/job belongs to another student |
| 404 | `URT_NOT_FOUND` | unknown serving, job or passage |
| 409 | `URT_ALREADY_SUBMITTED` | second submission; `error.result` holds the stored result |
| 429 | `URT_RATE_LIMITED` | more than `URT_NEXT_RATE_LIMIT_PER_MIN` (default 10) `next` requests per minute; see `Retry-After` |
| 429 | `URT_BUSY` | another `next` request for the same student is still running |
| 503 | `URT_GENERATION_UNAVAILABLE` | no passage could be generated and none was available to fall back to |
| 500 | `URT_INTERNAL` | unexpected error (logged) |

## Endpoints

### `GET /subjects`
`200 {"subjects": ["biology", "chemistry", "english", "geology", "physics"]}` (the subjects whose
approved rules loaded).

### `POST /passages/next`
Body `{"subject": "physics"}`. Returns the next passage for the student:

- `200` [Serving](#serving): a stored passage was available.
- `202 {"jobId", "status", "retryAfterMs", "pollUrl"}` with a `Retry-After` header: a passage is being
  generated. Poll `pollUrl`. If the student already has a generation in progress, the same job is
  returned again.

### `GET /jobs/:jobId`
- `202 {"jobId", "status": "queued" | "generating" | "validating", "retryAfterMs", "pollUrl"}`: still working.
- `200` [Serving](#serving): done. The serving was recorded by the job itself, so polling late is fine.
- `503 URT_GENERATION_UNAVAILABLE`: generation failed and nothing could be served instead.
- `403` for another student's job, `404` for an unknown id.

### `GET /servings/:servingId`
`200` [Serving](#serving), plus `result` once submitted. Lets the client recover after a reload.

### `POST /servings/:servingId/submission`
Body `{"answers": [{"questionId": 901, "answer": "B"}, {"questionId": 902, "answer": null}]}`. Questions
left out or answered `null` count as unanswered (incorrect). Returns `200` [Result](#result); `409` with
the stored result on a second submission.

### `POST /admin/passages/:id/retire`
Body `{"reason": "factual error reported"}`. `200 {"id", "status": "retired"}`. A retired passage is
never served again; history is kept.

### `GET /admin/stats`
`200 {"pool": {"physics": {"validated", "retired", "fresh"}, …}, "jobs": {"completed": n, …}, "costToday": 1.23}`.

## Shapes

### Serving
Never contains the answer key, the distractor rationale, or whether the passage was reused.

```jsonc
{
  "servingId": 123,
  "passage": {
    "id": 45, "subject": "physics", "title": "Passage I: …",
    "body": "Paragraph 1…\n\nParagraph 2…",          // paragraphs separated by a blank line
    "figures": [
      { "id": "fig1", "kind": "table", "title": "Table 1", "columns": ["Length (m)", "Period (s)"],
        "rows": [[0.25, 1.0], [0.5, 1.42]] },
      { "id": "fig2", "kind": "line_chart", "title": "Figure 1",                 // line_chart | bar_chart | scatter_plot
        "xAxis": { "label": "Time", "unit": "s" }, "yAxis": { "label": "Temperature", "unit": "°C" },
        "series": [{ "name": "Substance A", "points": [[0, 20], [60, 35]] }] }
    ]
  },
  "questions": [
    { "id": 901, "orderIndex": 1, "question": "According to Table 1, …",
      "options": [{ "label": "A", "text": "…" }, { "label": "B", "text": "…" }], "figureRef": "fig1" }
  ],
  "result": { }                                       // only after submission
}
```

Bar charts over named categories carry `xAxis.categories`; their points use x = 0, 1, 2, … as indexes
into it. Text is plain UTF-8 (symbols such as μ, Δ, → appear directly; no LaTeX or Markdown).

### Result
```jsonc
{ "score": 3, "total": 5,
  "results": [{ "questionId": 901, "isCorrect": false, "chosen": "C", "correctAnswer": "B" }],
  "explanations": [{ "questionId": 901, "explanation": "…" }] }   // incorrect and unanswered only
```
`explanations` may be shorter than the list of wrong answers if the feedback model was unavailable.
