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

  /* ---- voices ----
     Voice availability varies wildly by device. Desktop Windows has David/Zira;
     a phone may expose only ONE english voice. So: de-dupe, only show the switch
     when there are 2 genuinely DISTINCT voices, and label them so they never
     collide (gender when detectable, else a cleaned name, else "Voice 1/2"). */
  function genderOf(v) {
    var n = v.name.toLowerCase();
    if (/(zira|female|samantha|susan|aria|jenny|karen|moira|tessa|fiona|nicky|catherine|serena|kate|hazel|heera|linda|eva|michelle|allison|ava|joanna|salli|kimberly)/.test(n)) return 'Female';
    if (/(david|male|mark|guy|george|james|ryan|daniel|alex|fred|tom|aaron|arthur|oliver|gordon|matthew|joey|brian)/.test(n)) return 'Male';
    return null;
  }
  function cleanName(v) {
    return (v.name
      .replace(/^(Microsoft|Google|Apple)\s+/i, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s+English.*$/i, '')
      .trim()) || v.name;
  }
  function loadVoices() {
    var all = synth.getVoices();
    if (!all.length) return false;
    var en = all.filter(function (v) { return /^en/i.test(v.lang); });
    var pool = en.length ? en : all;
    // de-dupe so the same voice can never appear twice
    var seen = {}, uniq = [];
    pool.forEach(function (v) { var k = v.voiceURI || v.name; if (!seen[k]) { seen[k] = 1; uniq.push(v); } });
    // Prefer a plain male-ish default first, then a female; otherwise the first two distinct voices.
    var males = uniq.filter(function (v) { return genderOf(v) === 'Male'; });
    var females = uniq.filter(function (v) { return genderOf(v) === 'Female'; });
    var pick = (males.length && females.length) ? [males[0], females[0]] : uniq.slice(0, 2);
    voices = [];
    pick.forEach(function (v) { if (v && voices.indexOf(v) < 0) voices.push(v); });
    if (settings.voice >= voices.length) settings.voice = 0;
    return true;
  }
  function voiceLabels() {
    var labels = voices.map(function (v) { return genderOf(v) || cleanName(v); });
    if (voices.length === 2 && labels[0] === labels[1]) labels = ['Voice 1', 'Voice 2'];
    return labels;
  }
  function renderVoices() {
    if (!voiceWrap) return;
    voiceWrap.innerHTML = '';
    if (voices.length < 2) return; // 0 or 1 distinct voice — no real choice, so no switch
    var lab = document.createElement('span'); lab.className = 'pl-lab'; lab.textContent = 'Voice'; lab.style.marginRight = '2px';
    voiceWrap.appendChild(lab);
    var seg = document.createElement('span'); seg.className = 'pl-seg';
    var labels = voiceLabels();
    voices.forEach(function (v, idx) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = labels[idx];
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
