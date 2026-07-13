# Museum Companion (PWA)

Camera-capture PWA that identifies a museum object and offers three
"different-door" questions behind a *new question* button, per the v4 system
prompt (see `museum-companion-v4-instructions.md`). Frontend is a no-build
vanilla PWA; the backend is one Vercel serverless function that holds the API
key and the system prompt.

## Architecture

```
camera capture ─▶ fetchObjectData()  ──POST /api/object──▶  Claude (vision)
   (app.js)          (api.js)                (api/object.js)
       ▲                                          holds ANTHROPIC_API_KEY
       └────────── renders answer / disambiguate card ◀──── parsed JSON
```

- **`api.js`** — the one data boundary. `fetchObjectData()` POSTs the captured
  photo(s) (as base64) to `/api/object` and returns the parsed response. Flip
  `const USE_MOCK = true` at the top to run the UI entirely offline against the
  local fixtures (the three Part-4 shapes) — handy for styling without spending
  API calls. The **DEV · mock** bar only appears in mock mode.
- **`api/object.js`** — the proxy. Holds the key + the Part 1 system prompt,
  calls `claude-opus-4-8` with the image(s), strips any ```` ```json ```` fences,
  `JSON.parse`s in a `try/catch`, and returns the object. A malformed response
  or API error becomes a 502, which the UI shows as its "Let me try that again"
  card.

## Run it locally

Requires the API key. Use the Vercel CLI so the serverless function runs too:

```powershell
npm install
# put your key in .env (copy from .env.example) — .env is gitignored
vercel dev
```

`vercel dev` serves the static frontend **and** `/api/object`, over HTTPS, which
is also what lets the camera work when you open it on your phone.

**UI-only work (no key needed):** set `USE_MOCK = true` in `api.js` and serve
statically (`python -m http.server 8123`). The DEV bar then drives all three
card states from fixtures.

## Deploy

Pushing to the GitHub repo auto-deploys on Vercel. **Set the key** in Vercel →
Project → Settings → Environment Variables: `ANTHROPIC_API_KEY`. It lives only
there and in your local `.env` — never in the repo or the frontend.

## Model & cost knobs (`api/object.js`)

- **Model** `claude-opus-4-8` with **adaptive thinking** — chosen because
  question quality is this app's whole point (thinking also keeps the response
  clean JSON). It's the slower/costlier option. To trade quality for speed/cost:
  drop `thinking` to `{ type: "disabled" }`, lower `output_config.effort`, or
  switch the model to `claude-sonnet-5`.
- **`maxDuration = 60`** gives the vision + thinking call room; Vercel's default
  would otherwise time out a slow request.

## Gotchas

- **Service worker caches aggressively.** `sw.js` is cache-first for the offline
  shell, so after you change a file the browser may keep serving the old one.
  Bump `CACHE` in `sw.js` (e.g. `-v2`) on each deploy to force an update — the
  worker deletes old caches on activate. During local dev, a hard reload or
  clearing site data does the same.
- **Camera needs HTTPS.** `getUserMedia` works on `http://localhost` but is
  blocked over plain `http://<LAN-ip>`. Use `vercel dev` or a Vercel preview URL
  (both HTTPS) to test capture on a phone. The capture screen degrades to a
  "camera unavailable" fallback otherwise.

## Verified behavior

Card renders for all three shapes; **New question** walks
`questions[0] → [1] → [2]` from the array in hand with the identification held
stable, and only a tap *past* the third triggers a refetch. Disambiguation and
obscured-line replies re-send the original photo(s) with the visitor's text.
