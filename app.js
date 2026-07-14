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
  captureHint: document.getElementById("capture-hint"),
  captureCancel: document.getElementById("capture-cancel"),
  tray: document.getElementById("capture-tray"),
  trayThumb: document.getElementById("capture-thumb"),
};

// Per-identification UI state. questionIndex is which of the three questions
// is currently on screen; it survives "new question" taps but resets on a
// fresh capture or refetch.
let current = { data: null, questionIndex: 0 };

// The photo(s) from the last capture, kept so follow-ups (disambiguation
// choice, obscured-line correction) and "new question" refetches re-send the
// same object to the model rather than losing it. Cleared on a new capture.
let lastPhotos = [];
// Which scene the last capture described, sent alongside lastPhotos on refetch
// so the proxy anchors the same way: "combined" (label in the shot),
// "separate_label" (object + label shot separately), or "no_label".
let lastScene = "combined";

// Two-step capture state. step is "object" until the object shot is taken; if
// the visitor chooses "Add label photo", it flips to "label" so the next tap
// captures the wall label as a separate image. thumbUrl backs the review tray.
let capture = { step: "object", objectPhoto: null, thumbUrl: null };

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

  if (capture.step === "object") {
    if (!blob) {
      // No live camera (desktop, or plain http:// on a phone). Preserve the
      // old one-shot path so the dev bar and mock keep working.
      submit([], "combined");
      return;
    }
    capture.objectPhoto = blob;
    openTray(blob);
    return;
  }

  // step === "label": this second shot is the wall label, photographed apart
  // from the object. If the camera gave us nothing, fall back to object-only.
  const photos = blob ? [capture.objectPhoto, blob] : [capture.objectPhoto];
  submit(photos, blob ? "separate_label" : "no_label");
}

// Hand the captured photo(s) to the model with the scene that describes them,
// then restore the capture screen so the next visit starts clean.
function submit(photos, scene) {
  lastPhotos = photos;
  lastScene = scene;
  resetCaptureUI();
  identify({ photos, scene });
}

// ── Review tray (between the object shot and submitting) ────────────────────
function openTray(blob) {
  if (capture.thumbUrl) URL.revokeObjectURL(capture.thumbUrl);
  capture.thumbUrl = URL.createObjectURL(blob);
  els.trayThumb.src = capture.thumbUrl;
  els.tray.hidden = false;
}

function onAddLabel() {
  els.tray.hidden = true;
  capture.step = "label";
  els.captureHint.textContent = "Now point at the label, then tap to shoot.";
  els.captureCancel.hidden = false;
}

function onLabelInShot() {
  els.tray.hidden = true;
  submit([capture.objectPhoto], "combined");
}

function onNoLabel() {
  els.tray.hidden = true;
  submit([capture.objectPhoto], "no_label");
}

// Back out of the separate-label step to the review tray for the object shot.
function onCaptureCancel() {
  capture.step = "object";
  els.captureHint.textContent = "Point at the object.";
  els.captureCancel.hidden = true;
  if (capture.objectPhoto) openTray(capture.objectPhoto);
}

// Restore the capture screen to its "object" default without touching the
// photos we just submitted (those live in lastPhotos for refetches).
function resetCaptureUI() {
  els.tray.hidden = true;
  els.captureCancel.hidden = true;
  els.captureHint.textContent = "Point at the object.";
  capture.step = "object";
}

// Full reset: drop the held object photo and free its thumbnail URL too.
function resetCaptureState() {
  if (capture.thumbUrl) URL.revokeObjectURL(capture.thumbUrl);
  capture = { step: "object", objectPhoto: null, thumbUrl: null };
  resetCaptureUI();
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
    identify({ photos: lastPhotos, scene: lastScene });
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
  // read a line aloud more easily than type it). The mic dictates into the same
  // text box via the Web Speech API; sending re-identifies with the visitor's
  // correction as followUp.
  const reply = document.createElement("div");
  reply.className = "note__reply";
  reply.innerHTML = `
    <input class="note__input" type="text" placeholder="Read the covered line…" aria-label="What the label says" />
    <button class="note__mic" title="Tap to speak" aria-label="Voice input">🎙️</button>
    <button class="note__send" aria-label="Send">↑</button>`;
  const input = reply.querySelector(".note__input");
  const send = () => {
    const val = input.value.trim();
    if (val) identify({ followUp: val, photos: lastPhotos, scene: lastScene });
  };
  reply.querySelector(".note__send").addEventListener("click", send);
  input.addEventListener("keydown", (e) => e.key === "Enter" && send());
  wireMic(reply.querySelector(".note__mic"), input);
  note.appendChild(reply);

  return note;
}

// Web Speech API, present in Chrome (incl. Android) as webkitSpeechRecognition.
// Absent on some browsers (e.g. certain iOS versions) — we feature-detect and
// hide the mic there so it's never a dead button.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Wire the 🎙️ button to dictate into `input`. Tapping starts recognition (which
// triggers the OS mic-permission prompt the first time) and streams the
// transcript into the text box; tapping again — or a pause — stops it.
function wireMic(micBtn, input) {
  if (!SpeechRecognition) {
    micBtn.hidden = true; // no dictation here → don't show a button that does nothing
    return;
  }

  let recognition = null;
  let listening = false;

  micBtn.addEventListener("click", () => {
    if (listening) {
      recognition.stop();
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = true; // show words as they're recognized
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      listening = true;
      micBtn.classList.add("is-listening");
    };
    recognition.onresult = (e) => {
      // Join the pieces (interim + final) into the live transcript.
      input.value = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join("")
        .trim();
    };
    recognition.onerror = (e) => {
      // Most common: "not-allowed" (permission denied/blocked) and "no-speech".
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        input.placeholder = "Mic blocked — allow it, or just type instead.";
      }
    };
    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove("is-listening");
      input.focus(); // let the visitor tidy the text and hit send
    };

    try {
      recognition.start();
    } catch (_) {
      // start() throws if called while already running — reset and move on.
      listening = false;
      micBtn.classList.remove("is-listening");
    }
  });
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
      scene: lastScene,
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
  lastScene = "combined";
  resetCaptureState();
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
els.captureCancel.addEventListener("click", onCaptureCancel);
document.getElementById("tray-add-label").addEventListener("click", onAddLabel);
document.getElementById("tray-label-in-shot").addEventListener("click", onLabelInShot);
document.getElementById("tray-no-label").addEventListener("click", onNoLabel);
document.getElementById("tray-retake").addEventListener("click", resetToCapture);
wireDevBar();
startCamera();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("sw.js").catch(() => {})
  );
}
