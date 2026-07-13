// ============================================================================
// api.js — the ONE data boundary for the museum companion frontend.
//
// SWAP POINT: right now fetchObjectData() returns local mock fixtures so the
// whole UI can be built and demoed with no backend. When the proxy exists,
// replace ONLY the body of fetchObjectData() with a fetch() to your /api
// endpoint (which holds the API key + system prompt). Keep the signature and
// the return shape identical, and every screen keeps working untouched.
//
// The mock fixtures below are the three Part-4 response shapes verbatim:
//   1. clean       — an `answer` with label_note: ""
//   2. labelNote   — an `answer` with a non-empty label_note
//   3. disambiguate — a `disambiguate` picker response
// ============================================================================

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
 * @param {Blob[]} [input.photos]   captured image blobs (object, and usually label)
 * @param {string} [input.followUp] optional text, e.g. a disambiguation choice
 *                                   or the visitor reading back an obscured line
 * @returns {Promise<Object>} one of the Part-4 response shapes
 *
 * REAL IMPLEMENTATION (later) will look roughly like:
 *
 *   const form = new FormData();
 *   (input.photos || []).forEach((p, i) => form.append('photo' + i, p));
 *   if (input.followUp) form.append('followUp', input.followUp);
 *   const res  = await fetch('/api/object', { method: 'POST', body: form });
 *   const text = await res.text();
 *   return parseModelJson(text); // strip ```json fences + JSON.parse in try/catch
 *
 * Because callers only ever see the resolved object, swapping the body below
 * for that fetch is the entire migration.
 */
async function fetchObjectData(input = {}) {
  // ----- MOCK BODY (delete this whole block when wiring the proxy) -----
  await new Promise((r) => setTimeout(r, 600)); // simulate network latency

  // A disambiguation reply always resolves to a concrete answer, the way the
  // model returns a normal `answer` once the visitor names their choice.
  if (input.followUp) return structuredClone(MOCK_FIXTURES.clean);

  const data = MOCK_FIXTURES[__mockFixtureKey] ?? MOCK_FIXTURES.clean;
  return structuredClone(data);
  // ----- end mock body -----
}
