# URT dev frontend (branch `dev-frontend` only)

A local page for trying the `/api/urt` flow end to end: pick a subject, read the passage with its
tables and charts, answer, submit, and see the score with explanations. It uses the real router and
services from `server/`, on an in-memory database. Not part of the product and not merged to `main`.

```bash
cd server && npm install            # the URT module's dependencies
cd ../dev_frontend && npm install && npm start
# open http://localhost:4310 and sign in with any student id (tick "admin" for the stats panel)
```

- **Offline (default):** no model calls and no cost. The pool is seeded with the generated samples in
  `data/urt_samples/` (if present); when they run out, generation produces clearly marked placeholder
  passages, and explanations are written from each question's stored distractor notes.
- **Live:** `npm run live` uses the real models through the gateway configured in `.env`
  (`URT_OPENAI_BASE_URL` / `URT_OPENAI_API_KEY`, or the `URT_CA_OPENAI_*` values). This costs money.

There is no real authentication: the page sends `x-dev-user: <id>:<role>`. Everything lives in memory
and is lost when the server stops. Set `PORT` to use another port.
