// ============================================================================
// api/more.js — the "Tell me more" endpoint (Vercel serverless function).
//
// Called lazily when the visitor expands the Tell-me-more box. It runs Claude
// with the web_search SERVER tool to gather reliable context and REAL links
// about an already-identified object, then — crucially — verifies every URL the
// model returns against the URLs the web search actually produced, so a
// fabricated/hallucinated link can never reach the UI. A Wikipedia link is
// guaranteed via a constructed search URL if the search didn't surface one.
//
// Response shape (consumed by fetchMore() in /api.js):
//   { text: "<~200 words>", links: [ { label, url }, … ] }
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";

// Web search + generation can take a while — give it room.
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a museum companion adding depth after a visitor has identified an object and read its wall label. Use web search to ground yourself in reliable sources, then write a short "tell me more."

Content rules:
- Do NOT repeat what a wall label already states (name, date, culture, materials, dimensions) — assume the visitor has just read it. Instead connect that label to the bigger picture: the story behind the object, the people who made or used it, the world it came from, why it mattered, how it connects to things the visitor might already know.
- Ground every claim in your web-search results. If reliable sources are thin, write LESS — a few true sentences beat padding. Never invent facts, names, dates, places, or events. Better short and accurate than long and uncertain.
- Aim for about 200 words when the sources support it; fewer if they don't.
- Warm, curious tone, like a knowledgeable friend — not a textbook, not a jargon dump.

Links:
- Provide links you ACTUALLY found in your web search. Never write a URL you did not see in a search result.
- Prefer a Wikipedia article about the object's context; you may also include the museum's own page for the object and/or a Google Books listing for a relevant book.
- Also set "wikipedia_topic" to the single best Wikipedia article title for this context (a reliable fallback).

Respond with ONLY one valid JSON object — no markdown fences, no text before or after:
{
  "text": "<the context, about 200 words or fewer>",
  "wikipedia_topic": "<best Wikipedia topic/title, or empty string>",
  "links": [ { "label": "<short label, e.g. 'Wikipedia: Benin Bronzes'>", "url": "<a real URL from your search results>" } ]
}`;

/**
 * Extract and parse the JSON object from the model's text. With web search on,
 * the model often prepends a preamble text block ("I'll research …") before the
 * JSON, so we can't just parse the concatenated text — we slice from the first
 * "{" to the last "}". Also strips any ```json fences. Throws on malformed input.
 */
function parseModelJson(text) {
  let s = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

/** Compare URLs by origin + path so trivial differences don't defeat matching. */
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(u).trim().toLowerCase();
  }
}

// A Wikipedia link built from a topic (not a guessed article URL). The go=Go
// behaviour lands directly on the article when the title matches, else on search
// results — either way it always resolves, so it can't be a dead link.
function wikiSearchUrl(topic) {
  return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(topic)}&go=Go`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server" });
  }

  const { identification = "", labelNote = "", replies = [] } = req.body || {};
  if (!identification) {
    return res.status(400).json({ error: "Send the identification" });
  }

  const replyList = Array.isArray(replies) ? replies : [];
  let userText = `The visitor is looking at an object identified as: ${identification}.`;
  if (labelNote) userText += ` Part of the wall label was obscured; note: ${labelNote}.`;
  if (replyList.length) {
    userText += ` The visitor added: ${replyList.map((r, i) => `(${i + 1}) ${r}`).join(" ")}.`;
  }
  userText += ` Write the "tell me more" with grounded context and real links.`;

  try {
    const anthropic = new Anthropic({ apiKey });

    // The server runs the web-search loop for us. If it hits its per-turn
    // iteration cap it returns stop_reason "pause_turn" with partial content;
    // re-send the assistant turn to resume. Accumulate every block across
    // continuations so both the final JSON and the verified URL set are complete.
    const messages = [{ role: "user", content: userText }];
    const allBlocks = [];
    let stopReason = null;
    for (let i = 0; i < 3; i++) {
      const message = await anthropic.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        // web_search_20260209 on Opus 4.8. allowed_callers:["direct"] skips the
        // dynamic-filtering code-execution layer — noticeably faster for a small
        // request like this, which matters under the serverless time limit.
        // Result blocks are web_search_tool_result → .content is [{url,title,…}].
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 3, allowed_callers: ["direct"] },
        ],
        system: SYSTEM_PROMPT,
        messages,
      });
      allBlocks.push(...message.content);
      stopReason = message.stop_reason;
      if (stopReason !== "pause_turn") break;
      // Resume: append the paused assistant turn and call again (no extra user text).
      messages.push({ role: "assistant", content: message.content });
    }

    // Final text blocks hold the JSON (search results arrive as separate blocks).
    const text = allBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const data = parseModelJson(text);

    // The real URLs the web search actually returned — our verification set.
    const verified = new Set();
    for (const b of allBlocks) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r && r.url) verified.add(normalizeUrl(r.url));
      }
    }

    // Keep only model links whose URL truly appeared in the search results —
    // this is what makes "verified" real and drops any fabricated URL.
    let links = Array.isArray(data.links)
      ? data.links
          .filter((l) => l && l.url && verified.has(normalizeUrl(l.url)))
          .map((l) => ({ label: String(l.label || l.url).slice(0, 80), url: l.url }))
      : [];

    // Guarantee a Wikipedia link. If none was verified, construct a search link
    // from the topic (always resolves — not a guessed article URL).
    if (!links.some((l) => /wikipedia\.org/i.test(l.url))) {
      const topic =
        (data.wikipedia_topic && String(data.wikipedia_topic).trim()) || identification;
      if (topic) links.unshift({ label: `Wikipedia: ${topic}`.slice(0, 80), url: wikiSearchUrl(topic) });
    }
    links = links.slice(0, 3);

    return res.status(200).json({ text: String(data.text || ""), links });
  } catch (err) {
    console.error("more proxy error:", err?.message || err);
    return res.status(502).json({ error: "Couldn’t load more right now" });
  }
}
