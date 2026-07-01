/* Read-aloud player for transcript pages.
   Uses the browser's built-in speech synthesis (Web Speech API) — a plain,
   obviously-synthetic voice. Pulls text straight from the .turn blocks in the
   DOM. Utterances are spoken ONE AT A TIME (each starts only when the previous
   ends), so the highlight tracks the audio and there is no queue desync. No
   auto-scroll — the highlight shows position without hijacking the page.

   Controls: play / pause / stop, a voice switch (whatever en voices the browser
   offers), and an attributions on/off switch (whether the voice says each
   speaker's name). Graceful no-op if the browser has no speech synthesis. */
(function () {
  var root = document.querySelector('[data-player]');
  if (!root) return;
  var toggle = root.querySelector('[data-toggle]');
  var stopBtn = root.querySelector('[data-stop]');
  var note = root.querySelector('[data-note]');
  var voiceWrap = root.querySelector('[data-voices]');
  var namesBtn = root.querySelector('[data-names]');
  var synth = window.speechSynthesis;

  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
    if (toggle) toggle.disabled = true;
    if (note) note.textContent = 'This browser has no built-in voice — read the transcript below.';
    return;
  }

  var turns = Array.prototype.slice.call(document.querySelectorAll('.turn'));
  var settings = { voice: 0, names: true };
  var voices = [];
  var queue = [], i = 0, playing = false, paused = false;

  /* ---- voices ---- */
  function loadVoices() {
    var all = synth.getVoices();
    if (!all.length) return false;
    var en = all.filter(function (v) { return /^en/i.test(v.lang); });
    if (!en.length) en = all;
    var female = en.filter(function (v) { return /(zira|female|aria|jenny|susan|samantha|hazel|eva|michelle|linda|heera|catherine)/i.test(v.name); })[0];
    var male = en.filter(function (v) { return /(david|male|mark|guy|george|james|ryan|daniel|alex|fred|tom)/i.test(v.name); })[0];
    var a = male || en[0];
    var b = female || en.filter(function (v) { return v !== a; })[0] || null;
    voices = b ? [a, b] : [a];
    return true;
  }
  function shortName(v) { return v.name.replace(/^(Microsoft|Google)\s+/i, '').split(/[ (]/)[0]; }
  function renderVoices() {
    if (!voiceWrap) return;
    voiceWrap.innerHTML = '';
    if (voices.length < 2) return; // only one voice — no switch to show
    var lab = document.createElement('span'); lab.className = 'pl-lab'; lab.textContent = 'Voice'; lab.style.marginRight = '2px';
    voiceWrap.appendChild(lab);
    var seg = document.createElement('span'); seg.className = 'pl-seg';
    voices.forEach(function (v, idx) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = shortName(v);
      if (idx === settings.voice) b.className = 'on';
      b.addEventListener('click', function () {
        settings.voice = idx;
        Array.prototype.forEach.call(seg.children, function (c, ci) { c.className = ci === idx ? 'on' : ''; });
      });
      seg.appendChild(b);
    });
    voiceWrap.appendChild(seg);
  }
  if (!loadVoices()) synth.addEventListener('voiceschanged', function () { if (loadVoices()) renderVoices(); });
  else renderVoices();

  /* ---- attributions switch ---- */
  if (namesBtn) {
    namesBtn.addEventListener('click', function () {
      settings.names = !settings.names;
      namesBtn.classList.toggle('on', settings.names);
      namesBtn.setAttribute('aria-pressed', String(settings.names));
      namesBtn.textContent = 'Names: ' + (settings.names ? 'on' : 'off');
    });
  }

  /* ---- build the spoken queue from the DOM ---- */
  function splitSentences(t) {
    var parts = t.match(/[^.!?—]+[.!?—]*\s*/g) || [t];
    var out = [], buf = '';
    parts.forEach(function (s) {
      if ((buf + s).length > 200 && buf) { out.push(buf.trim()); buf = s; }
      else { buf += s; }
    });
    if (buf.trim()) out.push(buf.trim());
    return out;
  }
  function buildQueue() {
    queue = [];
    turns.forEach(function (turn, ti) {
      var speaker = turn.getAttribute('data-speaker') || '';
      var paras = Array.prototype.slice.call(turn.querySelectorAll('.para'));
      var firstChunk = true;
      paras.forEach(function (p) {
        var text = (p.textContent || '').trim();
        if (!text) return;
        splitSentences(text).forEach(function (chunk) {
          var lead = (firstChunk && settings.names && speaker) ? speaker + '. ' : '';
          queue.push({ text: lead + chunk, turn: ti });
          firstChunk = false;
        });
      });
    });
  }

  /* ---- highlight (no scrolling) ---- */
  function highlight(ti) { turns.forEach(function (t, idx) { t.classList.toggle('speaking', idx === ti); }); }
  function clearHighlight() { turns.forEach(function (t) { t.classList.remove('speaking'); }); }

  function setIcon(state) {
    toggle.textContent = state === 'pause' ? '⏸' : '▶';
    toggle.setAttribute('aria-label', state === 'pause' ? 'Pause read-aloud' : 'Play read-aloud');
  }

  function speakNext() {
    if (i >= queue.length) { finish(); return; }
    var item = queue[i];
    var u = new SpeechSynthesisUtterance(item.text);
    if (voices[settings.voice]) u.voice = voices[settings.voice];
    u.rate = 1; u.pitch = 1; u.volume = 1;
    u.onstart = function () { highlight(item.turn); };
    u.onend = function () { if (playing && !paused) { i++; speakNext(); } };
    u.onerror = function () { if (playing && !paused) { i++; speakNext(); } };
    synth.speak(u);
  }

  function start() {
    synth.cancel();
    buildQueue();
    i = 0; playing = true; paused = false;
    setIcon('pause'); stopBtn.hidden = false;
    speakNext();
  }
  function pause() { paused = true; synth.pause(); setIcon('play'); }
  function resume() { paused = false; synth.resume(); setIcon('pause'); }
  function finish() {
    playing = false; paused = false; i = 0;
    synth.cancel(); clearHighlight();
    setIcon('play'); stopBtn.hidden = true;
  }

  toggle.addEventListener('click', function () {
    if (!playing) start();
    else if (paused) resume();
    else pause();
  });
  stopBtn.addEventListener('click', finish);
  window.addEventListener('beforeunload', function () { synth.cancel(); });
})();
