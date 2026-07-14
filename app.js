// ============================================================================
// app.js — screens, camera capture, and card rendering for all three shapes.
// The only thing it knows about "the backend" is fetchObjectData() (api.js).
// ============================================================================

const screens = {
  welcome: document.getElementById("screen-welcome"),
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
  fileInput: document.getElementById("file-input"),
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
// Every text reply the visitor has given about THIS object, in order (a read-back
// of an obscured line, a disambiguation choice, …). The proxy is stateless, so we
// resend the whole list each time — otherwise the model forgets earlier answers
// and can re-ask them, trapping the visitor in a loop. Cleared on a fresh object.
let lastReplies = [];

// Two-step capture state. step is "object" until the object shot is taken; if
// the visitor chooses "Add label photo", it flips to "label" so the next tap
// captures the wall label as a separate image. thumbUrl backs the review tray.
// source is where the photos come from — "camera" (live shutter) or "library"
// (picked from the phone's photo library) — so the tray knows how to get the
// label shot and how "Retake" should behave.
let capture = { step: "object", objectPhoto: null, thumbUrl: null, source: "camera" };

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) =>
    el.classList.toggle("is-active", key === name)
  );
}

// ── Camera ────────────────────────────────────────────────────────────────
// Held so we can release the camera when leaving the capture screen (turns off
// the device indicator and lets a later start re-acquire cleanly).
let cameraStream = null;

async function startCamera() {
  if (cameraStream) return; // already live — don't request a second stream
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    els.video.srcObject = cameraStream;
    els.video.hidden = false;
    els.cameraMsg.hidden = true;
  } catch (err) {
    // Expected on desktop without a camera, or over plain http:// on a phone
    // (camera needs a secure context). The dev bar still drives every card.
    cameraStream = null;
    els.video.hidden = true;
    els.cameraMsg.hidden = false;
    els.cameraMsg.textContent =
      "Camera unavailable here — tap the shutter to run with a mock photo, or use the DEV bar to preview each card.";
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  els.video.srcObject = null;
}

// ── Photo library ───────────────────────────────────────────────────────────
// Open the OS photo picker and resolve with the chosen File (a Blob, so it flows
// through the same path as a camera shot), or null if the visitor cancels.
function pickImageFile() {
  return new Promise((resolve) => {
    const input = els.fileInput;
    input.value = ""; // reset so re-picking the same file still fires "change"
    const cleanup = () => {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
    };
    const onChange = () => {
      cleanup();
      resolve(input.files && input.files[0] ? input.files[0] : null);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    input.click();
  });
}

// Pick the object photo from the library, then show the same review tray a
// camera object shot would. Cancelling leaves the visitor where they were.
async function startLibraryObject() {
  const file = await pickImageFile();
  if (!file) return;
  capture.objectPhoto = file;
  showScreen("capture"); // the tray is an opaque overlay; the black viewfinder never shows
  openTray(file);
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

// Downscale an image so its long edge is at most maxEdge, re-encoded as JPEG.
// Full-resolution library photos (several MB) otherwise exceed the serverless
// body limit and the model's per-image size cap — the cause of "Let me try that
// again" on clear saved photos. createImageBitmap applies EXIF orientation so
// portrait library shots aren't rotated. Falls back to the original blob if
// anything goes wrong, so a working path never regresses.
async function normalizeImage(blob, maxEdge = 1568) {
  if (!blob || typeof createImageBitmap !== "function") return blob;
  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (_) {
      bitmap = await createImageBitmap(blob); // older engines: no options arg
    }
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    const out = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85)
    );
    return out || blob;
  } catch (_) {
    return blob; // send the original rather than nothing
  }
}

// ── Request flow ────────────────────────────────────────────────────────────
async function identify(input = {}) {
  showScreen("loading");
  try {
    // Always carry the accumulated replies so the model keeps every earlier answer.
    const data = await fetchObjectData({ ...input, replies: lastReplies });
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
// then restore the capture screen so the next visit starts clean. Every image is
// downscaled first so full-resolution library photos don't exceed the request /
// per-image size limits (camera frames are already small — this just unifies).
async function submit(photos, scene) {
  lastScene = scene;
  lastReplies = []; // fresh object → no prior replies to carry
  resetCaptureUI();
  showScreen("loading"); // cover the resize + request in one loading state
  lastPhotos = await Promise.all(photos.map((p) => normalizeImage(p)));
  identify({ photos: lastPhotos, scene });
}

// ── Review tray (between the object shot and submitting) ────────────────────
function openTray(blob) {
  if (capture.thumbUrl) URL.revokeObjectURL(capture.thumbUrl);
  capture.thumbUrl = URL.createObjectURL(blob);
  els.trayThumb.src = capture.thumbUrl;
  els.tray.hidden = false;
}

async function onAddLabel() {
  els.tray.hidden = true;
  if (capture.source === "library") {
    // Label lives in another saved photo — pick it, then submit both.
    const file = await pickImageFile();
    if (file) submit([capture.objectPhoto, file], "separate_label");
    else openTray(capture.objectPhoto); // cancelled → back to the tray
    return;
  }
  // Camera: arm the shutter for the label shot as a second capture.
  capture.step = "label";
  els.captureHint.textContent = "Now point at the label, then tap to shoot.";
  els.captureCancel.hidden = false;
}

// "Retake" from the tray: re-pick from the library, or drop back to the live
// viewfinder for the camera (which is still running).
function onRetake() {
  els.tray.hidden = true;
  if (capture.source === "library") {
    startLibraryObject();
  } else {
    resetCaptureState();
  }
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

// Full reset: drop the held object photo and free its thumbnail URL too. Keeps
// the current source (camera/library) so retake stays in the same mode.
function resetCaptureState() {
  if (capture.thumbUrl) URL.revokeObjectURL(capture.thumbUrl);
  capture = { step: "object", objectPhoto: null, thumbUrl: null, source: capture.source };
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

  const prevQ = document.createElement("button");
  prevQ.className = "btn btn--soft";
  prevQ.id = "prev-question";
  prevQ.textContent = "‹ Back";
  prevQ.addEventListener("click", onPrevQuestion);

  const nextQ = document.createElement("button");
  nextQ.className = "btn btn--soft";
  nextQ.id = "next-question";
  nextQ.textContent = "Next ›";
  nextQ.addEventListener("click", onNextQuestion);

  // A fresh set of three, replacing the current one (kept separate from the
  // Back/Next toggle so it's a deliberate, distinct action).
  const newSet = document.createElement("button");
  newSet.className = "btn btn--ghost";
  newSet.id = "new-set";
  newSet.textContent = "New questions";
  newSet.addEventListener("click", onNewSet);

  actions.append(prevQ, nextQ, newSet);
  qwrap.appendChild(actions);

  card.appendChild(qwrap);

  // tell me more — collapsed by default; content is fetched on first expand
  card.appendChild(buildTellMeMore(data));

  paintQuestion();
}

function paintQuestion() {
  const { data, questionIndex } = current;
  const q = document.getElementById("question");
  const meta = document.getElementById("qmeta");
  q.textContent = data.questions[questionIndex];
  meta.textContent = `Question ${questionIndex + 1} of ${data.questions.length}`;
  // Bound the toggle: no going before the first or past the last of this set.
  const prev = document.getElementById("prev-question");
  const next = document.getElementById("next-question");
  if (prev) prev.disabled = questionIndex === 0;
  if (next) next.disabled = questionIndex >= data.questions.length - 1;
}

// Toggle within the set already in hand — no request either way.
function onPrevQuestion() {
  if (current.questionIndex > 0) {
    current.questionIndex -= 1;
    paintQuestion();
  }
}

function onNextQuestion() {
  if (current.questionIndex < current.data.questions.length - 1) {
    current.questionIndex += 1;
    paintQuestion();
  }
}

// New questions: fetch a fresh set of three about the same object, replacing the
// current set (renderAnswer resets the index to 0).
function onNewSet() {
  identify({ photos: lastPhotos, scene: lastScene });
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
    if (!val) return;
    lastReplies.push(val); // add to the running set so no earlier answer is lost
    identify({ photos: lastPhotos, scene: lastScene });
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

// "Tell me more" is generated on demand: the first time the visitor expands it,
// we call the web-search-backed /api/more for ~200 words of grounded context
// plus verified links, cache the result on the card, and just show/hide it after.
function buildTellMeMore(data) {
  const wrap = document.createElement("div");
  wrap.className = "more";

  const toggle = document.createElement("button");
  toggle.className = "more__toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = `<span class="more__chevron">▸</span> Tell me more`;

  const body = document.createElement("div");
  body.className = "more__body";
  body.hidden = true;

  let loaded = null; // cache the fetched { text, links } so re-expanding is free

  async function load() {
    body.innerHTML = `<p class="more__status"><span class="dot-spin" aria-hidden="true"></span> Looking things up…</p>`;
    try {
      const res = await fetchMore({
        identification: data.identification,
        labelNote: data.label_note || "",
        replies: lastReplies,
      });
      loaded = res;
      renderMore(body, res);
    } catch (_) {
      // Leave loaded null so the next expand retries.
      body.innerHTML = `<p class="more__status">Couldn’t load more just now — try again in a moment.</p>`;
    }
  }

  toggle.addEventListener("click", () => {
    const opening = body.hidden;
    body.hidden = !opening;
    toggle.setAttribute("aria-expanded", String(opening));
    toggle.querySelector(".more__chevron").textContent = opening ? "▾" : "▸";
    if (opening && !loaded) load();
  });

  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

function renderMore(body, res) {
  body.innerHTML = "";

  const p = document.createElement("p");
  p.className = "more__text";
  p.textContent = res.text || "";
  body.appendChild(p);

  if (Array.isArray(res.links) && res.links.length) {
    const ul = document.createElement("ul");
    ul.className = "more__links";
    res.links.forEach((l) => {
      if (!l || !l.url) return;
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "more__link";
      a.href = l.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = l.label || l.url;
      li.appendChild(a);
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
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
    lastReplies.push(input.value.trim() || "the one they pointed at");
    identify({ photos: lastPhotos, scene: lastScene });
  });
  reply.querySelector("#pick-rephoto").addEventListener("click", resetToWelcome);
  card.appendChild(reply);
}

function renderError() {
  els.card.className = "card";
  els.card.innerHTML = `
    <h1 class="card__id">Let me try that again</h1>
    <p class="more__body" style="margin-top:.6rem">That reading didn’t come through cleanly. Take the photo once more.</p>`;
}

// ── Welcome screen (the entry hub — choose camera or saved photos) ──────────
function onUseCamera() {
  capture.source = "camera";
  resetCaptureState();
  showScreen("capture");
  startCamera();
}

function onUseLibrary() {
  capture.source = "library";
  resetCaptureState();
  startLibraryObject(); // shows the capture screen only once a photo is chosen
}

// "New photo" / re-photograph: clear everything and return to the welcome hub
// so the visitor can pick camera or library again. Releases the camera.
function resetToWelcome() {
  current = { data: null, questionIndex: 0 };
  lastPhotos = [];
  lastScene = "combined";
  lastReplies = [];
  resetCaptureState();
  stopCamera();
  showScreen("welcome");
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
document.getElementById("welcome-camera").addEventListener("click", onUseCamera);
document.getElementById("welcome-library").addEventListener("click", onUseLibrary);
els.shutter.addEventListener("click", onShutter);
els.reset.addEventListener("click", resetToWelcome);
els.captureCancel.addEventListener("click", onCaptureCancel);
document.getElementById("tray-add-label").addEventListener("click", onAddLabel);
document.getElementById("tray-label-in-shot").addEventListener("click", onLabelInShot);
document.getElementById("tray-no-label").addEventListener("click", onNoLabel);
document.getElementById("tray-retake").addEventListener("click", onRetake);
wireDevBar();
// Camera no longer starts on load — it starts only when the visitor taps
// "Use camera" from the welcome screen (which is active by default).

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("sw.js").catch(() => {})
  );
}
