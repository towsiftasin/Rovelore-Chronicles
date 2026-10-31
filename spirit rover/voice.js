/* ===== STORY VOICE =====
   Reads each dialogue box aloud when it appears.
   - Adds a VOICE button (turns the voice on or off, remembered between scenes)
   - Maya sounds like a child (high and quick), Lena sounds calm and grown-up
   - With AUTOPLAY on, the story waits until the line has been spoken,
     then pauses briefly before moving on
   Load this file AFTER the page's main script.                          */
(function () {
  if (typeof showDialogue !== "function" || typeof scheduleAuto !== "function") return;

  // ---- Settings you can change ----
  var VOICE_KEY = "storyVoice";
  var PAUSE_AFTER_VOICE = 900;                       // ms to wait after a line is spoken (autoplay)
  var VOICES = {
    maya: { pitch: 1.9, rate: 1.12 },   // childish: pitch goes 0 to 2 (2 = highest), rate 1 = normal
    lena: { pitch: 0.85, rate: 0.93 }   // calm and lower
  };
  var FEMALE_NAMES = /female|zira|samantha|karen|victoria|susan|hazel|aria|jenny|libby|moira|tessa|fiona|serena|google uk english female|google us english/i;

  var synth = window.speechSynthesis;
  var supported = !!(synth && window.SpeechSynthesisUtterance);
  var voiceOn = true;
  try { voiceOn = localStorage.getItem(VOICE_KEY) !== "off"; } catch (e) {}

  var bubbleBox = document.getElementById("speech");
  var token = 0;          // changes whenever a new line starts, so old speech events are ignored
  var lineDone = true;    // has the current line finished being spoken?
  var lastOk = false;     // did the last line speak properly? (if not, autoplay uses reading time)
  var speakTimer = null;

  // ---- VOICE button (same look as the other buttons) ----
  var style = document.createElement("style");
  style.textContent =
    "@media (max-width: 700px) { .voice-btn .voice-label { display: none; } }";
  document.head.appendChild(style);

  var voiceBtn = document.createElement("button");
  voiceBtn.type = "button";
  voiceBtn.id = "voiceBtn";
  voiceBtn.className = "auto-btn voice-btn";
  var rightBtns = document.querySelector(".right-btns");
  if (supported && rightBtns) rightBtns.insertBefore(voiceBtn, rightBtns.firstChild);

  function renderButton() {
    voiceBtn.classList.toggle("on", voiceOn);
    voiceBtn.setAttribute("aria-pressed", voiceOn ? "true" : "false");
    voiceBtn.innerHTML = (voiceOn ? "&#128266;" : "&#128263;") +
      ' <span class="voice-label">' + (voiceOn ? "VOICE" : "MUTED") + "</span>";
  }
  renderButton();

  // ---- Choose a voice for each speaker ----
  function pickVoice(role) {
    var list = (synth.getVoices() || []).filter(function (v) { return /^en/i.test(v.lang); });
    if (!list.length) return null;
    var female = list.filter(function (v) { return FEMALE_NAMES.test(v.name); });
    var pool = female.length ? female : list;
    if (role === "maya") return pool[0];
    return pool[1] || pool[0];
  }

  function speakLine(i) {
    if (!supported || !voiceOn) { lineDone = true; return; }
    var d = dialogues[i];
    var my = ++token;
    var u = new SpeechSynthesisUtterance(d.text);
    var cfg = VOICES[d.position] || VOICES.maya;
    var v = pickVoice(d.position);
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "en-US"; }
    u.pitch = cfg.pitch;
    u.rate = cfg.rate;

    u.onend = function () {
      if (my !== token) return;
      lineDone = true; lastOk = true;
      if (autoplay) scheduleAuto();
    };
    u.onerror = function () {
      if (my !== token) return;
      lineDone = true; lastOk = false;      // blocked or failed: autoplay falls back to reading time
      if (autoplay) scheduleAuto();
    };

    lineDone = false;
    synth.speak(u);

    // Safety net: if the browser never reports the end, don't leave autoplay stuck
    setTimeout(function () {
      if (my === token && !lineDone) {
        lineDone = true; lastOk = false;
        if (autoplay) scheduleAuto();
      }
    }, readingTime(i) * 2 + 3000);
  }

  // ---- Speak each line when its box appears ----
  var originalShow = showDialogue;
  window.showDialogue = function (i) {
    var delay = bubbleBox.classList.contains("show") ? 420 : 60;   // wait for the old box to fade out
    token++;
    if (supported) synth.cancel();
    lineDone = !(supported && voiceOn);
    lastOk = false;
    originalShow(i);
    clearTimeout(speakTimer);
    if (supported && voiceOn) {
      speakTimer = setTimeout(function () { speakLine(i); }, delay);
    }
  };

  // ---- AUTOPLAY waits for the voice ----
  window.scheduleAuto = function () {
    clearTimeout(autoTimer);
    if (!autoplay) return;
    if (supported && voiceOn && !lineDone) return;   // the voice will call this again when it finishes
    var wait = (supported && voiceOn && lastOk) ? PAUSE_AFTER_VOICE : readingTime(currentDialogue);
    autoTimer = setTimeout(nextDialogue, wait);
  };

  // ---- VOICE button ----
  voiceBtn.addEventListener("click", function () {
    voiceOn = !voiceOn;
    try { localStorage.setItem(VOICE_KEY, voiceOn ? "on" : "off"); } catch (e) {}
    renderButton();
    token++;
    clearTimeout(speakTimer);
    synth.cancel();
    clearTimeout(autoTimer);
    if (voiceOn) {
      lineDone = false;
      speakTimer = setTimeout(function () { speakLine(currentDialogue); }, 100);
    } else {
      lineDone = true; lastOk = false;
      if (autoplay) scheduleAuto();
    }
  });

  // Some browsers load voices late; ask for them early
  if (supported && synth.getVoices) synth.getVoices();

  // Stop talking when leaving the page
  window.addEventListener("pagehide", function () { if (supported) synth.cancel(); });
})();