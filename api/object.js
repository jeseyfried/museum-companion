// ============================================================================
// api/object.js — the museum companion proxy (Vercel serverless function).
//
// This holds the API key and the system prompt — NEVER put either in frontend
// code (see the v4 instructions, Part 2). It receives the captured photo(s)
// plus an optional follow-up, forwards them to a vision-capable Claude model
// with the Part 1 system prompt, strips any ```json fences, JSON.parses in a
// try/catch, and returns the parsed object to the frontend.
//
// The frontend's fetchObjectData() in /api.js POSTs here; its return shape is
// identical to the mock fixtures, so nothing else in the UI changes.
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";

// Give the function room for a vision call with adaptive thinking.
export const maxDuration = 60;

// Part 1 of the v4 instructions, verbatim. This is the contract the UI renders
// against — edit it here (and re-test) rather than in the frontend.
const SYSTEM_PROMPT = `You are a museum companion that helps a visitor look more closely at an object in front of them. You receive one or more photos: the object, and sometimes its wall label. The visitor's message tells you the scene — whether the label is in the same photo, was photographed separately (when it is, the first image is the object and the second is its label), or is absent. Your job is not to lecture but to spark curiosity.

**You must respond with only a single valid JSON object and nothing else** — no preamble, no markdown fences, no text before or after. The object always has a "type" field. Choose the type by checking the scene in this order:

**1. If the photo shows multiple distinct objects, or a label with several numbered entries, and it isn't clear which one the visitor means**, respond:

{
  "type": "disambiguate",
  "seen": "<one brief sentence naming what's in view>",
  "prompt": "<short question asking which one caught their eye>"
}

**2. If there is no wall label** — the visitor's message says the object has no label, or no label is visible in any photo — identify the object from its appearance alone. Respond with the answer shape below, with label_note set to an empty string "". Frame the identification as inference ("This looks like…", "This appears to be…"), since you are reading the object rather than a label. Do NOT mention obscured, blurred, or unreadable label text — there is no label to read. If you genuinely cannot tell what it is, say what you can observe and offer your best honest guess.

**3. If a label is present but you cannot read all of it** (blur, glare, a blocked or cut-off portion) — even if you can guess the missing words from context — do not silently fill the gaps. Respond:

{
  "type": "answer",
  "identification": "<what it seems to be, one sentence; if inferring, say 'This looks like…'>",
  "label_note": "<what you can read, plus: some of the label is obscured; offer your best guess of the covered part clearly marked as a guess, and ask the visitor to check>",
  "questions": ["<q1>", "<q2>", "<q3>"],
  "tell_me_more": "<one or two sentences, shown only if the visitor asks>"
}

**4. Otherwise** (the label is present and fully legible), respond with the same answer shape, with label_note set to an empty string "".

Field rules:

- identification: one sentence. If the label is legible, use it. If you're inferring from the object, say so plainly. Never present a guess as a fact.
- questions: exactly three, each opening a **different door** into the object — for example one about the person or story on the label, one about how it was used or made, one about the people who made or handled it or the world it came from. Order them best-first: question one is the most human, surprising, or story-rich hook available; two and three are alternative angles for a visitor the first didn't grab. Each must be short (one clause, rarely over fifteen words), work whether or not the identification is correct, and have no single right answer. Never open with "what do you make of," "what does it mean that," or similar essayistic framings — ask the way a curious friend would out loud.
- tell_me_more: one or two sentences of context. No trivia, no dates-and-dimensions recitation, no art-historical jargon unless the visitor invites it.
- Lead the visitor toward the most human, surprising, or story-rich thing available. A vivid anecdote on the label almost always beats a formal observation about the object.
- Only state label text you can actually read. Never present inferred text as if you read it.`;

/**
 * Strip markdown fences and parse. Models occasionally wrap JSON in ```json
 * fences or add stray whitespace despite instructions (v4 instructions, Part 4).
 * Throws on malformed input so the caller can return a friendly fallback.
 */
function parseModelJson(text) {
  let s = text.trim();
  // Remove a leading ```json / ``` fence and a trailing ``` if present.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const data = JSON.parse(s);
  if (!data || typeof data.type !== "string") {
    throw new Error("parsed JSON missing a 'type' field");
  }
  return data;
}

/**
 * How to read the attached photo(s), from the frontend's two-step capture: the
 * label may be in the same shot ("combined"), photographed separately
 * ("separate_label"), or absent ("no_label").
 */
function sceneLine(scene, photoCount) {
  if (scene === "separate_label") {
    return "The visitor photographed the object and its wall label separately. The first image is the object; the second image is its wall label.";
  }
  if (scene === "no_label") {
    return "This object has no wall label. Identify it from the object itself; do not describe any label as obscured or unreadable.";
  }
  return photoCount > 1
    ? "Here is the object and its wall label."
    : "Here is the object; its wall label, if any, is in this same photo.";
}

/**
 * The full text anchor for the user turn. Because this proxy is stateless, the
 * frontend resends EVERY reply the visitor has given about this object (obscured
 * lines read back, a disambiguation choice). We hand the model all of them at
 * once and tell it not to re-ask what it already has — otherwise it loses an
 * earlier answer between rounds and loops back to the same question.
 */
function anchorText(replies, scene, photoCount) {
  const base = sceneLine(scene, photoCount);
  if (!replies.length) return base;
  const joined = replies.map((r, i) => `(${i + 1}) ${r}`).join(" ");
  return `${base} The visitor has since told you the following, in order: ${joined}. Treat all of it as known. Do not ask again for anything they have already answered; if you now have enough to identify the object, give the answer.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Config problem, not a model problem — make it obvious in logs.
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not set on the server" });
  }

  // Vercel parses a JSON body automatically for Node functions.
  const { photos = [], replies = [], scene = "combined" } = req.body || {};
  const replyList = Array.isArray(replies) ? replies : [];
  if (!Array.isArray(photos) || (photos.length === 0 && replyList.length === 0)) {
    return res.status(400).json({ error: "Send at least one photo (or a reply)" });
  }

  // Build the user turn: the captured image(s), then a short text anchor.
  // Each photo is { media_type, data } where data is base64 (no data: prefix).
  const content = photos.map((p) => ({
    type: "image",
    source: { type: "base64", media_type: p.media_type || "image/jpeg", data: p.data },
  }));
  content.push({ type: "text", text: anchorText(replyList, scene, photos.length) });

  try {
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      // Adaptive thinking improves the curatorial judgment the prompt asks for,
      // and keeps the reasoning in thinking blocks so the response stays clean
      // JSON. Drop to { type: "disabled" } (or lower effort) if latency matters
      // more than question quality; switch model to claude-sonnet-5 for lower cost.
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    // Adaptive thinking prepends thinking blocks — take only the text blocks.
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    const data = parseModelJson(text);
    return res.status(200).json(data);
  } catch (err) {
    // Covers both API errors and malformed/unparseable model output. The
    // frontend catches a non-200 and shows its "Let me try that again" card.
    console.error("object proxy error:", err?.message || err);
    return res.status(502).json({ error: "Let me try that again" });
  }
}
