# Museum Companion — frontend (PWA)

Camera-capture PWA that renders the three v4 response shapes (see
`museum-companion-v4-instructions.md`, Part 4). **Frontend only, mock data —
no backend yet.**

## Run it

Any static server works — there is no build step.

```powershell
# from this folder
python -m http.server 8123
# then open http://localhost:8123
```

or `npx serve`, or `vercel dev` (closest to production).

Use the **DEV · mock** bar at the top to flip between the three fixtures:

- **Clean** — `answer` with `label_note: ""` (no callout, confident ID)
- **Label note** — `answer` with a non-empty `label_note` (the "help me read this" strip)
- **Disambiguate** — the picker card

Verified behavior: the card renders for all three shapes; **New question**
walks `questions[0] → [1] → [2]` from the array in hand with the identification
held stable, and only a tap *past* the third question triggers a refetch.

## The one swap point

`fetchObjectData()` in [`api.js`](api.js) is the entire data boundary. It
currently returns local fixtures. When you build the proxy, replace **only the
body of that one function** with a `fetch()` to your `/api` endpoint (which
holds the API key + system prompt) — signature and return shape stay identical,
and every screen keeps working untouched. The fence-stripping + `try/catch`
JSON parse from Part 4 lives inside that function too.

## Camera + HTTPS (expect this when testing on your phone)

`getUserMedia` needs a **secure context**:

- **Desktop `http://localhost`** → treated as secure, camera works.
- **Phone over plain `http://<your-LAN-ip>`** → browsers block the camera. This
  is the PWA-friction surprise, not a bug in this code.

For real on-device capture testing, serve over HTTPS: `vercel dev` /
a Vercel preview deploy both do this for you, or use an HTTPS tunnel. Until
then the app degrades gracefully — the capture screen shows a "camera
unavailable" fallback and the DEV bar still drives every card.
