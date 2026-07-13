# Where this project stands — 2026-07-13

A working note for picking the project back up. Delete whenever it stops being useful.

## Working and deployed ✅

- **Frontend PWA** (vanilla, no build): camera capture → results card. Renders all
  three v4 response shapes (answer, answer + `label_note`, disambiguate).
  *New question* cycles `questions[0→1→2]` before any refetch; *tell me more*
  expands. Mock fixtures live behind `USE_MOCK` in `api.js`.
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

## Next up (not code — prompt testing on real objects)

Part 3 of `museum-companion-v4-instructions.md` flags two unproven cases:

1. **Fully illegible label** (shoot into glare) → should fall back to the object
   plus a request for you to read/describe it, *not* invent an identification.
2. **Clean, legible label** → should give a confident answer with `label_note: ""`,
   *not* a hedge. Confirm the obscured-text caveat doesn't over-fire.
3. Read a few `questions` arrays back to back and watch for a new verbal tic
   replacing the banned "what do you make of."

## Deferred build items (planned earlier, not yet done)

- **Voice input** for the `label_note` "read me the covered line" reply (currently
  a text field + mic stub).
- **Tap-to-choose** options for the disambiguate card (currently free-text +
  re-photograph).
- **Hardening:** pin `@anthropic-ai/sdk` to a version instead of `latest`; keep
  bumping `sw.js` `CACHE` on each deploy.
- **Cost/latency knob:** Opus + adaptive thinking is the slow/expensive setting —
  `api/object.js` documents how to drop thinking or switch to `claude-sonnet-5`.
