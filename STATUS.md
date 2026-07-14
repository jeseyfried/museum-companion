# Where this project stands — 2026-07-13

A working note for picking the project back up. Delete whenever it stops being useful.

## Working and deployed ✅

- **Frontend PWA** (vanilla, no build): camera capture → results card. Renders all
  three v4 response shapes (answer, answer + `label_note`, disambiguate).
  *Back*/*Next* toggle within the set of three (`questions[0..2]`, bounded, ends
  disabled); *New questions* refetches a fresh set; *tell me more* expands. Mock
  fixtures live behind `USE_MOCK` in `api.js`.
- **Proxy** `api/object.js` (Vercel serverless): holds the API key + Part 1 system
  prompt, calls `claude-opus-4-8` (adaptive thinking), strips ```` ```json ````
  fences, `JSON.parse` in try/catch.
- **Deployed** on Vercel from GitHub (`jeseyfried/museum-companion`). **Verified
  working on a real phone over HTTPS** — camera capture → real model card.
- API key: a fresh Anthropic key is set in local `.env` *and* in Vercel's env vars
  (Production/Preview/Development). Old key was revoked.

## Resume in ~5 seconds

```powershell
cd C:\Users\jonat\museum-companion
vercel dev            # full stack (key already in .env) → http://localhost:3000
```

UI-only tweaks with no key/model calls: set `USE_MOCK = true` in `api.js`, then
`python -m http.server 8123`. The DEV bar drives all three cards from fixtures.

If a code change "doesn't show up," it's the service worker cache — hard-reload,
or bump `CACHE` in `sw.js`.

## Capture flow — two-step, three scenes (added 2026-07-14)

The shutter no longer submits immediately. First tap shoots the **object**, then a
review tray offers: **Add label photo** (shoot the label separately → 2 photos),
**Label's in this shot** (1 photo, today's behavior), **No label on this object**
(1 photo, identify from the object), or **Retake**. The label step shows a "← Back"
that returns to the tray. The frontend sends a `scene` field with the photos —
`"combined" | "separate_label" | "no_label"` — persisted as `lastScene` so
refetches/follow-ups anchor the same way. The proxy turns `scene` into the user-turn
text anchor (`anchorText()` in `api/object.js`); for `separate_label` it tells the
model image 1 = object, image 2 = label. The system prompt gained a **no-label
branch** (identify from the object, `label_note: ""`, no obscured-text hedge).
Verified in a static server by driving all four paths (scenes + Back). Camera itself
is untested here — needs a real phone.

## Welcome hero image (added 2026-07-14)

A hero image sits above the title on the welcome screen (`welcome-hero.jpg`, a
pencil-sketch museum scene). Source was a 12.7 MB / 2816×1536 PNG in Downloads;
downscaled to 1000×545 JPEG q85 (~186 KB) via PowerShell System.Drawing. Styled
`.welcome__hero` with `max-width:100%` + `max-height:32vh` (scales to whichever
bound is tighter, preserving aspect) so it never crowds the title — verified at
375×812 and 375×667 that everything fits and the title stays ~53px above center
(essentially unchanged). Precached in `sw.js`; CACHE → v12.

## Reply accumulation — no more "Help me read this" loop (fixed 2026-07-14)

The proxy is stateless, and the frontend used to send only the *latest* reply
(`followUp`). So a second follow-up answer dropped the first, and the model could
re-ask what it had already been told — an endless loop. Now the frontend keeps
`lastReplies` (every reply about the current object, in order), resends the whole
list each round (`replies[]` on the request), and clears it on a fresh capture. The
proxy's `anchorText()` lists all replies and instructs the model not to re-ask
anything already answered. Verified in a static server: successive answers arrive as
`[]` → `[a]` → `[a, b]`. Voice input (🎙️, Web Speech API) also shipped 2026-07-14.

## Welcome screen + photo-library input (added 2026-07-14)

The app no longer opens straight into the camera. A **welcome screen**
(`screen-welcome`, active by default) shows the title, two sentences of purpose,
and two buttons: **Use camera** (starts the live capture flow) and **Add from saved
photos** (opens the OS picker via a hidden `<input type=file accept=image/*>` — no
`capture` attr, so it offers the library). A picked File is a Blob, so it flows
through the exact same review tray as a camera shot; `capture.source`
(`camera`/`library`) tells the tray whether "Add label photo" arms the shutter or
opens the picker again, and whether "Retake" re-shoots or re-picks. Camera now
starts on demand (not on load) and is released via `stopCamera()` when returning to
welcome. "New photo" / re-photograph now return to the welcome hub. Verified in a
static server: welcome layout; library → tray with all three scenes
(separate_label/no_label/combined); camera button. `sw.js` CACHE → v6.

## Image downscaling — fixes saved-photo failures (2026-07-14)

Full-resolution library photos (a phone JPEG is often 3–12 MB) exceeded the Vercel
serverless body limit (~4.5 MB) and the model's per-image cap (~5 MB), so every
saved photo returned "Let me try that again" regardless of clarity. Camera frames
were fine because they're capped at the video resolution. `normalizeImage()` in
`app.js` now downscales every image (long edge ≤ 1568 px, re-encoded JPEG q0.85,
EXIF orientation applied via `createImageBitmap`) at the single choke point in
`submit()`. Verified: a 9.4 MB / 4000×3000 test image → 1568×1176 / 731 KB, and the
full library→submit path hands 731 KB to the boundary. `sw.js` CACHE → v7. Note:
HEIC is still unsupported by the model — only matters if a picked photo is HEIC, not
JPEG.

## "Tell me more" — web-verified, on demand (added 2026-07-14)

The box no longer comes from Part 1 (dropped `tell_me_more` from `api/object.js`).
On first expand, the frontend lazily calls a new endpoint **`api/more.js`** (shows a
spinner, caches the result on the card). That endpoint runs `claude-opus-4-8` with
the **web_search server tool** (`web_search_20260209` — the current variant for
Opus 4.8; built-in dynamic filtering, so no separate code_execution) to produce
~200 words that go *beyond* the label (no duplication, anti-confabulation: shorter if
sources are thin) plus links. **Link anti-hallucination is the core mechanism:**
every URL Claude returns is filtered server-side against the actual
`web_search_tool_result` URLs, so a fabricated link can't reach the UI; a Wikipedia
link is guaranteed via a constructed `Special:Search?...&go=Go` fallback if search
didn't surface one. Handles `pause_turn` by resuming the turn (server-tool loop cap).
Costs an API call (incl. web search) only when a visitor taps. Verified: link-filter
logic (fabricated dropped, real kept, Wikipedia fallback), and the frontend
lazy-load/caching/error-retry — the live web_search call itself needs a real deploy.
Note: requires web search enabled on the Anthropic account. `sw.js` CACHE → v10.

**2026-07-14 fix — box spun forever:** two bugs. (1) With web search on, the model
prepends a preamble text block ("I'll research…") before the JSON, so joining all
text blocks broke `JSON.parse` and every call 502'd — `parseModelJson` now slices
first-`{` to last-`}`. (2) Latency: dynamic filtering (code execution) made the call
~36s; switched web search to `allowed_callers:["direct"]`, max_uses 3 → ~13s. Added
a 75s client-side `AbortController` timeout in `fetchMore` so the box can never spin
forever. Verified end-to-end against the real API (13s, 184 words, 3 verified links
incl. real Wikipedia). `sw.js` CACHE → v11.

## Next up (not code — prompt testing on real objects)

Part 3 of `museum-companion-v4-instructions.md` flags two unproven cases, now joined
by the two new capture scenes:

1. **Fully illegible label** (shoot into glare) → should fall back to the object
   plus a request for you to read/describe it, *not* invent an identification.
2. **Clean, legible label** → should give a confident answer with `label_note: ""`,
   *not* a hedge. Confirm the obscured-text caveat doesn't over-fire.
3. Read a few `questions` arrays back to back and watch for a new verbal tic
   replacing the banned "what do you make of."
4. **No label** scene → identifies from the object honestly ("This looks like…"),
   `label_note: ""`, and does *not* talk about an obscured/unreadable label.
5. **Separate label** scene → correctly reads image 2 as the label for image 1's
   object (test with the label of a *different* object to be sure it's using it).

## Deferred build items (planned earlier, not yet done)

- ~~**Voice input** for the `label_note` reply~~ — DONE 2026-07-14. The 🎙️ button
  now dictates into the text box via the Web Speech API (`wireMic()` in `app.js`),
  feature-detected (hides where unsupported), with a red pulsing "listening" state.
  Verified wiring + mic-permission prompt + blocked-path handling in the pane;
  live transcription needs a real Chrome/Android with mic permission granted.
- **Tap-to-choose** options for the disambiguate card (currently free-text +
  re-photograph).
- **Hardening:** pin `@anthropic-ai/sdk` to a version instead of `latest`; keep
  bumping `sw.js` `CACHE` on each deploy.
- **Cost/latency knob:** Opus + adaptive thinking is the slow/expensive setting —
  `api/object.js` documents how to drop thinking or switch to `claude-sonnet-5`.
