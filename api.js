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
    tell_me_more:
      "Boxes like this were often wedding gifts carved by the groom's family. The snugger the lid, the more skill it quietly advertised.",
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
    tell_me_more:
      "Bells cast in tuned sets were adjusted by shaving the inside walls after casting — a one-way job, since you can’t add bronze back.",
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
 * @param {string} [input.followUp] optional text, e.g. a disambiguation choice
 *                                   or the visitor reading back an obscured line
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
    body: JSON.stringify({ photos, scene: input.scene, followUp: input.followUp }),
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
  // A disambiguation reply always resolves to a concrete answer, the way the
  // model returns a normal `answer` once the visitor names their choice.
  if (input.followUp) return structuredClone(MOCK_FIXTURES.clean);
  const data = MOCK_FIXTURES[__mockFixtureKey] ?? MOCK_FIXTURES.clean;
  return structuredClone(data);
}
