# Museum Companion — resume note (current as of 2026-07-16)

A PWA where a museum visitor photographs (or picks) an object and gets an
identification, three "different-door" questions, and optional deeper context.
Vanilla, no build step. Deployed on Vercel from GitHub (`jeseyfried/museum-companion`).
This note is the fast way back in — skim it, then open the files it points to.

## The app in one pass (user flow)

1. **Welcome screen** (`screen-welcome`, active on load): hero image
   (`welcome-hero.jpg`) + title + two sentences + two buttons — **Use camera** and
   **Add from saved photos** (OS photo picker via a hidden file input).
2. **Capture** (two-step): first shot is the **object**, then a review tray offers
   **Add label photo** (shoot/pick the label separately → 2 photos), **Label's in
   this shot** (1 photo), **No label on this object** (1 photo), or **Retake**.
   `capture.source` (`camera`/`library`) decides whether "Add label" arms the shutter
   or reopens the picker. Every image is downscaled (`normalizeImage`, long edge
   ≤1568px, EXIF-corrected) in `submit()` before upload.
3. **Results card**: the identification; an optional **"Help me read this"** reply
   box (text + 🎙️ voice dictation via Web Speech) when the label was obscured;
   **three questions** with **‹ Back / Next ›** (bounded, ends disabled) and a
   separate **New questions** (refetches a fresh three); and **Tell me more**
   (lazy-loads deeper context + verified links on first tap).

The three questions follow a **fixed by-position typology** (in `api/object.js`):
**Q1** = the best-first hook (the original spec, unchanged); **Q2** = a whimsical /
imaginative what-if; **Q3** = "look closer," always investigatory about one
actually-visible object detail (guardrailed against inventing details).

## Architecture / where things live

- **Frontend**: `index.html`, `app.js` (screens, capture, camera lifecycle,
  card rendering), `api.js` (the ONE data boundary — `fetchObjectData` and
  `fetchMore`; `USE_MOCK` + fixtures for offline UI work), `styles.css`, `sw.js`
  (offline shell / precache), `welcome-hero.jpg`, `icon.svg`, `manifest.webmanifest`.
- **`api/object.js`** (serverless): the identify proxy. Holds the API key + Part-1
  system prompt, calls `claude-opus-4-8` (adaptive thinking). Request body:
  `{ photos[], scene, replies[] }`.
  - `scene` ∈ `combined | separate_label | no_label` → `anchorText()` builds the
    user-turn text. System prompt branches: disambiguate → no-label → obscured-label
    → legible-label.
  - `replies[]` accumulates every text reply for the current object and is resent
    whole each round (fixes the old "Help me read this" loop where the model forgot
    earlier answers).
- **`api/more.js`** (serverless): the "Tell me more" proxy. Runs `claude-opus-4-8`
  with the **web_search** server tool (`web_search_20260209`, `allowed_callers:
  ["direct"]`, `max_uses: 3` — ~13s). Produces ~200 words *beyond* the label
  (no duplication, anti-confabulation) plus links. **Anti-hallucination is the point**:
  every URL the model returns is filtered against the actual `web_search_tool_result`
  URLs, so a fabricated link can't reach the UI; a Wikipedia link is guaranteed via a
  constructed `Special:Search?...&go=Go` fallback. `parseModelJson` slices first-`{`
  to last-`}` (the model prepends a preamble text block before the JSON). Handles
  `pause_turn`. Request body: `{ identification, labelNote, replies[] }`.

## How to run / test locally

```powershell
cd C:\Users\jonat\museum-companion
vercel dev            # full stack (key already in .env) → http://localhost:3000
```
- **UI-only** (no API cost): set `USE_MOCK = true` in `api.js`, then
  `python -m http.server 8123`. The DEV bar drives the card shapes from fixtures.
- **Probing `/api/more` (or any live model call)**: write a small script and run
  `node --env-file=.env <script>.mjs` from the project dir — the SDK is in
  `node_modules`. (That's how the web-search latency/parse bugs were diagnosed.)
- **Verifying UI**: the in-app browser pane's *screenshot* tool times out in this
  environment — verify via DOM measurement / injected scripts instead (worked well).

## Deploy (agreed workflow: automatic)

`git push` to `main` → the **GitHub→Vercel webhook auto-deploys production**
(connected in Vercel Settings → Git). Per Jonathan's standing instruction, once a
change is made and verified: `git add -A` → `git commit` (with Co-Authored-By
trailer) → `git push`, without stopping to ask. `vercel --prod` from the project dir
(logged in as `jeseyfried`) is the manual fallback.

- **Bump `CACHE` in `sw.js` on every deploy that touches a precached asset** — the
  service worker is cache-first, so otherwise the phone serves stale files. Currently
  **v12**. `ASSETS` includes `welcome-hero.jpg`.
- On the phone, reopening the installed PWA **twice** swaps in the new worker (installs
  on the first launch, activates on the next).
- Env: `ANTHROPIC_API_KEY` is in local `.env` *and* Vercel env vars. **Web search is
  enabled on the account and there's credit** (required for Tell me more).

## Next up — prompt testing on real objects (not code)

The code is feature-complete for now; the remaining work is exercising the prompts on
real museum objects on the phone:

1. **Fully illegible label** (glare) → falls back to the object + asks you to read it,
   does *not* invent an ID.
2. **Clean, legible label** → confident answer, `label_note: ""`, no over-firing hedge.
3. **No-label scene** → identifies from the object honestly ("This looks like…"), no
   obscured-label talk.
4. **Separate-label scene** → actually reads image 2 as image 1's label (test with a
   *different* object's label to be sure).
5. Read several `questions` arrays back-to-back — confirm the Q1/Q2/Q3 typology holds
   (hook → whimsical → look-closer), Q3 names a real visible detail rather than
   inventing one, and no new verbal tic replaces the banned "what do you make of."
6. Confirm on a real Chrome/Android: **voice dictation** fills the reply box, and
   **Tell me more** loads (~10–15s) with a good write-up + working links.

## Deferred build items

- **Tap-to-choose** options for the disambiguate card (currently free-text +
  re-photograph).
- **Pin `@anthropic-ai/sdk`** to a version instead of `latest`.
- **Cost/latency knob:** Opus + adaptive thinking is the slow/expensive setting;
  `api/object.js` documents dropping thinking or switching to `claude-sonnet-5`.
- HEIC library photos aren't supported by the model (JPEG/PNG/WebP are); only matters
  if a picked photo happens to be HEIC.

The full change history lives in git log if you need the blow-by-blow.
