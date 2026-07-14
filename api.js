// ============================================================================
// api.js — the ONE data boundary for the museum companion frontend.
//
// fetchObjectData() now calls the real proxy (/api/object) by default. Flip
// USE_MOCK to true to run entirely offline against the local fixtures below —
// handy for tweaking the UI without burning API calls. The DEV bar only does
// anything in mock mode.
//
// The mock fixtures below are the three Part-4 response shapes verbatim:
//   1. clean       — an `answer` with label_note: ""
//   2. labelNote   — an `answer` with a non-empty label_note
//   3. disambiguate — a `disambiguate` picker response
// ============================================================================

// Set to true to serve the local fixtures instead of hitting /api/object.
const USE_MOCK = false;

const MOCK_FIXTURES = {
  // 1. Clean, legible single-object label → confident answer, no hedge.
  clean: {
    type: "answer",
    identification:
      "A carved wooden cosmetic box from the Kemeni people, used to hold ground pigments.",
    label_note: "",
    questions: [
      "Whose face was painted with what was kept inside this?",
      "How do you carve a lid that fits this tightly without metal tools?",
      "What makes a box for pigment worth this much care to decorate?",
    ],
  },

  // 2. Label present but partly obscured → answer that flags the gap honestly.
  labelNote: {
    type: "answer",
    identification: "This looks like a bronze ceremonial bell, likely early dynastic.",
    label_note:
      "I can read “ritual bell, cast bronze” and a date starting “3rd century” — but the rest of that line is behind glare. It may say “BCE,” though that’s my guess. Could you read me the covered part?",
    questions: [
      "What kind of gathering would fall silent when this rang?",
      "How do you tune a bell you can only cast once?",
      "Who was allowed to strike it, and who wasn’t?",
    ],
  },

  // 3. Crowded scene under one label → ask which object they mean.
  disambiguate: {
    type: "disambiguate",
    seen: "A crowded case with three jade pendants and a small carved seal, all sharing one numbered label.",
    prompt: "Which one caught your eye — one of the pendants, or the little seal at the front?",
  },
};

// --- Dev-only scaffolding -------------------------------------------------
// Which fixture the mock should return. The REAL fetchObjectData will ignore
// this entirely; it exists only so the dev bar can flip between shapes.
let __mockFixtureKey = "clean";
function __setMockFixture(key) {
  __mockFixtureKey = key;
}
// --------------------------------------------------------------------------

/**
 * Fetch a structured identification for the captured photo(s).
 *
 * @param {Object}  input
 * @param {Blob[]} [input.photos]   captured image blobs. For scene
 *                                  "separate_label" the order is [object, label].
 * @param {string} [input.scene]    how to read the photos: "combined" (label in
 *                                  the shot), "separate_label", or "no_label".
 * @param {string[]} [input.replies] every text reply the visitor has given about
 *                                   this object so far, in order (obscured-line
 *                                   read-backs, a disambiguation choice). Sent
 *                                   whole each round so the model keeps them all.
 * @returns {Promise<Object>} one of the Part-4 response shapes
 * @throws  if the proxy returns a non-2xx (the UI shows its retry card)
 */
async function fetchObjectData(input = {}) {
  if (USE_MOCK) return mockObjectData(input);

  // Blobs can't be JSON-serialized — convert each to { media_type, data(base64) }
  // for the proxy, which forwards them to the model as base64 image blocks.
  const photos = await Promise.all((input.photos || []).map(blobToBase64));

  const res = await fetch("/api/object", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photos, scene: input.scene, replies: input.replies || [] }),
  });
  if (!res.ok) throw new Error(`proxy returned ${res.status}`);
  return res.json(); // already the parsed Part-4 object
}

/** Read a Blob into { media_type, data } where data is base64 (no data: prefix). */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result; // "data:image/jpeg;base64,AAAA..."
      resolve({
        media_type: blob.type || "image/jpeg",
        data: String(dataUrl).split(",", 2)[1],
      });
    };
    reader.readAsDataURL(blob);
  });
}

/** Offline stand-in for the proxy, driven by the DEV bar. */
async function mockObjectData(input) {
  await new Promise((r) => setTimeout(r, 600)); // simulate network latency
  // Any reply resolves to a concrete answer, the way the model returns a normal
  // `answer` once the visitor reads back the line or names their choice.
  if (input.replies && input.replies.length) return structuredClone(MOCK_FIXTURES.clean);
  const data = MOCK_FIXTURES[__mockFixtureKey] ?? MOCK_FIXTURES.clean;
  return structuredClone(data);
}

/**
 * Fetch the on-demand "Tell me more" — grounded ~200-word context plus verified
 * links — for an already-identified object. Called when the visitor expands the
 * box, so the web search only runs (and only costs) on a real tap.
 *
 * @param {Object}   input
 * @param {string}   input.identification the one-line ID from the answer card
 * @param {string}  [input.labelNote]     any obscured-label note
 * @param {string[]}[input.replies]       the visitor's read-backs/choices
 * @returns {Promise<{text: string, links: {label: string, url: string}[]}>}
 * @throws  if the endpoint returns a non-2xx (the box shows a retry message)
 */
async function fetchMore(input = {}) {
  if (USE_MOCK) return mockMore(input);
  // Web search + Opus can take ~30s; cap the wait so the box never spins forever.
  // On timeout the fetch rejects (AbortError) and the caller shows its retry text.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const res = await fetch("/api/more", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`more proxy returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Offline stand-in for /api/more. */
async function mockMore() {
  await new Promise((r) => setTimeout(r, 900));
  return {
    text:
      "Objects like this sat at the center of daily ritual, not on a pedestal. The people who made it worked within traditions passed hand to hand across generations, and a piece this carefully finished would have signaled status as much as function. Its journey to this gallery — through trade, collecting, and sometimes contested acquisition — is a story the label rarely has room to tell.",
    links: [
      { label: "Wikipedia: Example context", url: "https://en.wikipedia.org/wiki/Example" },
      { label: "Books on this topic", url: "https://www.google.com/search?tbm=bks&q=example" },
    ],
  };
}
