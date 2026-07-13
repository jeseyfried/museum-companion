// ============================================================================
// app.js — screens, camera capture, and card rendering for all three shapes.
// The only thing it knows about "the backend" is fetchObjectData() (api.js).
// ============================================================================

const screens = {
  capture: document.getElementById("screen-capture"),
  loading: document.getElementById("screen-loading"),
  results: document.getElementById("screen-results"),
};

const els = {
  video: document.getElementById("video"),
  frame: document.getElementById("frame"),
  cameraMsg: document.getElementById("camera-msg"),
  shutter: document.getElementById("shutter"),
  card: document.getElementById("card"),
  reset: document.getElementById("reset"),
};

// Per-identification UI state. questionIndex is which of the three questions
// is currently on screen; it survives "new question" taps but resets on a
// fresh capture or refetch.
let current = { data: null, questionIndex: 0 };

// The photo(s) from the last capture, kept so follow-ups (disambiguation
// choice, obscured-line correction) and "new question" refetches re-send the
// same object to the model rather than losing it. Cleared on a new capture.
let lastPhotos = [];

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) =>
    el.classList.toggle("is-active", key === name)
  );
}

// ── Camera ────────────────────────────────────────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    els.video.srcObject = stream;
  } catch (err) {
    // Expected on desktop without a camera, or over plain http:// on a phone
    // (camera needs a secure context). The dev bar still drives every card.
    els.video.hidden = true;
    els.cameraMsg.hidden = false;
    els.cameraMsg.textContent =
      "Camera unavailable here — tap the shutter to run with a mock photo, or use the DEV bar to preview each card.";
  }
}

function captureFrame() {
  const { video, frame } = els;
  if (!video.videoWidth) return null; // no live camera → mock has no blob
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
  frame.getContext("2d").drawImage(video, 0, 0);
  return new Promise((resolve) =>
    frame.toBlob((blob) => resolve(blob), "image/jpeg", 0.85)
  );
}

// ── Request flow ────────────────────────────────────────────────────────────
async function identify(input = {}) {
  showScreen("loading");
  try {
    const data = await fetchObjectData(input);
    if (!data || !data.type) throw new Error("malformed response");
    current = { data, questionIndex: 0 };
    renderCard(data);
    showScreen("results");
  } catch (err) {
    renderError();
    showScreen("results");
  }
}

async function onShutter() {
  const blob = await captureFrame();
  lastPhotos = blob ? [blob] : [];
  identify({ photos: lastPhotos });
}

// ── Rendering ───────────────────────────────────────────────────────────────
function renderCard(data) {
  if (data.type === "disambiguate") return renderDisambiguate(data);
  return renderAnswer(data);
}

function renderAnswer(data) {
  current.questionIndex = 0;
  const card = els.card;
  card.className = "card card--answer";
  card.innerHTML = "";

  // Heading
  const h = document.createElement("h1");
  h.className = "card__id";
  h.textContent = data.identification;
  card.appendChild(h);

  // label_note — only when non-empty
  if (data.label_note && data.label_note.trim() !== "") {
    card.appendChild(buildNote(data.label_note));
  }

  // Question block (single visible question) + actions
  const qwrap = document.createElement("div");
  qwrap.className = "qwrap";

  const q = document.createElement("p");
  q.className = "question";
  q.id = "question";
  qwrap.appendChild(q);

  const meta = document.createElement("p");
  meta.className = "qmeta";
  meta.id = "qmeta";
  qwrap.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";
  const newQ = document.createElement("button");
  newQ.className = "btn btn--soft";
  newQ.id = "new-question";
  newQ.textContent = "New question";
  newQ.addEventListener("click", onNewQuestion);
  actions.appendChild(newQ);
  qwrap.appendChild(actions);

  card.appendChild(qwrap);

  // tell me more — collapsed by default
  if (data.tell_me_more) card.appendChild(buildTellMeMore(data.tell_me_more));

  paintQuestion();
}

function paintQuestion() {
  const { data, questionIndex } = current;
  const q = document.getElementById("question");
  const meta = document.getElementById("qmeta");
  q.textContent = data.questions[questionIndex];
  meta.textContent = `Question ${questionIndex + 1} of ${data.questions.length}`;
}

// New question: reveal questions[1], then [2], one per tap, from the array in
// hand — no request. Only a tap PAST the last one triggers a fresh fetch.
function onNewQuestion() {
  const { data, questionIndex } = current;
  if (questionIndex < data.questions.length - 1) {
    current.questionIndex += 1;
    paintQuestion();
  } else {
    // Exhausted the three we hold → now (and only now) ask for more, about
    // the same object.
    identify({ photos: lastPhotos });
  }
}

function buildNote(text) {
  const note = document.createElement("div");
  note.className = "note";

  const label = document.createElement("div");
  label.className = "note__label";
  label.textContent = "Help me read this";
  note.appendChild(label);

  const p = document.createElement("p");
  p.className = "note__text";
  p.textContent = text;
  note.appendChild(p);

  // Reply affordance. label_note wants VOICE input (someone at a display can
  // read a line aloud more easily than type it) — the mic is a stub for now;
  // sending re-identifies with the visitor's correction as followUp.
  const reply = document.createElement("div");
  reply.className = "note__reply";
  reply.innerHTML = `
    <input class="note__input" type="text" placeholder="Read the covered line…" aria-label="What the label says" />
    <button class="note__mic" title="Voice input (coming soon)" aria-label="Voice input">🎙️</button>
    <button class="note__send" aria-label="Send">↑</button>`;
  const input = reply.querySelector(".note__input");
  const send = () => {
    const val = input.value.trim();
    if (val) identify({ followUp: val, photos: lastPhotos });
  };
  reply.querySelector(".note__send").addEventListener("click", send);
  input.addEventListener("keydown", (e) => e.key === "Enter" && send());
  note.appendChild(reply);

  return note;
}

function buildTellMeMore(text) {
  const wrap = document.createElement("div");
  wrap.className = "more";

  const toggle = document.createElement("button");
  toggle.className = "more__toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = `<span class="more__chevron">▸</span> Tell me more`;

  const body = document.createElement("p");
  body.className = "more__body";
  body.hidden = true;
  body.textContent = text;

  toggle.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.querySelector(".more__chevron").textContent = open ? "▾" : "▸";
  });

  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

function renderDisambiguate(data) {
  const card = els.card;
  card.className = "card card--pick";
  card.innerHTML = "";

  const seen = document.createElement("p");
  seen.className = "card__seen";
  seen.textContent = "Here’s what I see";
  card.appendChild(seen);

  const seenText = document.createElement("p");
  seenText.className = "card__prompt";
  seenText.style.fontSize = "1.05rem";
  seenText.style.color = "var(--ink-soft)";
  seenText.style.marginBottom = "0.9rem";
  seenText.textContent = data.seen;
  card.appendChild(seenText);

  const prompt = document.createElement("p");
  prompt.className = "card__prompt";
  prompt.textContent = data.prompt;
  card.appendChild(prompt);

  // The disambiguation reply wants TAP-TO-CHOOSE. The response shape carries
  // only free text, so until the model emits discrete options we offer a text
  // reply plus a re-photograph path; either resolves to a normal answer.
  const reply = document.createElement("div");
  reply.className = "pick-reply";
  reply.innerHTML = `
    <input class="note__input" type="text" placeholder="Tell me which one…" aria-label="Which object" />
    <div class="actions">
      <button class="btn btn--primary" id="pick-send">That’s the one</button>
      <button class="btn btn--soft" id="pick-rephoto">Re-photograph just it</button>
    </div>`;
  const input = reply.querySelector(".note__input");
  reply.querySelector("#pick-send").addEventListener("click", () => {
    identify({
      followUp: input.value.trim() || "the one they pointed at",
      photos: lastPhotos,
    });
  });
  reply.querySelector("#pick-rephoto").addEventListener("click", resetToCapture);
  card.appendChild(reply);
}

function renderError() {
  els.card.className = "card";
  els.card.innerHTML = `
    <h1 class="card__id">Let me try that again</h1>
    <p class="more__body" style="margin-top:.6rem">That reading didn’t come through cleanly. Take the photo once more.</p>`;
}

function resetToCapture() {
  current = { data: null, questionIndex: 0 };
  lastPhotos = [];
  showScreen("capture");
}

// ── Dev bar ─────────────────────────────────────────────────────────────────
function wireDevBar() {
  const bar = document.getElementById("devbar");
  // The fixture switcher only affects mock mode — hide it against the real proxy.
  if (typeof USE_MOCK !== "undefined" && !USE_MOCK) {
    bar.style.display = "none";
    return;
  }
  bar.querySelectorAll(".devbar__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      bar
        .querySelectorAll(".devbar__btn")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      __setMockFixture(btn.dataset.fixture);
      identify({ photos: [] }); // jump straight to that card
    });
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
els.shutter.addEventListener("click", onShutter);
els.reset.addEventListener("click", resetToCapture);
wireDevBar();
startCamera();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("sw.js").catch(() => {})
  );
}
