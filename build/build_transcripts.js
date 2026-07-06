/* Transcripts generator for thetelosofai.com.
 *
 * Reads the Substack transcript .txt files + hero images from ../../Transcripts/
 * (the shared drop folder) using build/episodes.json as the manifest, and writes:
 *   TheTelosofAI_site/transcripts/index.html          (typographic episode list)
 *   TheTelosofAI_site/transcripts/<slug>/index.html   (one page per episode)
 *   TheTelosofAI_site/transcripts/<slug>/cover.(png|jpg)
 *   TheTelosofAI_site/sitemap.xml                     (rebuilt with all episodes)
 *
 * Netlify does NOT run this — we build locally and commit the static output.
 * Adding an episode = drop the .txt + image, add one manifest entry, re-run.
 *
 *   node build/build_transcripts.js
 */
const fs = require('fs');
const path = require('path');

const BUILD = __dirname;
const ROOT = path.join(BUILD, '..');                 // thetelosofai.com/
const SITE = path.join(ROOT, 'TheTelosofAI_site');
const SRC = path.join(ROOT, '..', 'Transcripts');    // Websites/Transcripts/
const OUT = path.join(SITE, 'transcripts');
const BASE = 'https://thetelosofai.com';

const episodes = JSON.parse(fs.readFileSync(path.join(BUILD, 'episodes.json'), 'utf8'));

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
var KEEP_CAPS = { AC: 1, AI: 1, PT: 1, US: 1, UK: 1, USA: 1, AC_: 1 }; // initialisms that stay upper
function tc(s) {
  return String(s).trim().split(/\s+/).map(function (w) {
    if (!w) return w;
    if (KEEP_CAPS[w.toUpperCase().replace(/[^A-Z]/g, '')]) return w.toUpperCase();
    return w[0].toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function parseTranscript(raw) {
  raw = raw.replace(/^﻿/, '');
  var blocks = raw.split(/\r?\n\s*\r?\n/).map(function (b) {
    return b.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);

  var meta = {}, turns = [], cur = null, m;
  for (var idx = 0; idx < blocks.length; idx++) {
    var b = blocks[idx];
    if (idx === 0) continue; // first block is the title line (manifest owns the title)
    if ((m = b.match(/^hosted by\s+(.+)$/i))) { meta.host = m[1].replace(/[.]+$/, '').trim(); continue; }
    if ((m = b.match(/^guest:?\s+(.+)$/i))) { meta.guest = m[1].replace(/[.]+$/, '').trim(); continue; }
    m = b.match(/^([A-Z][A-Z.\-'’ ]{0,22}?):\s+([\s\S]+)$/);
    if (m) { cur = { speaker: m[1].trim(), paras: [m[2].trim()] }; turns.push(cur); }
    else if (cur) { cur.paras.push(b); }
  }
  return { meta: meta, turns: turns };
}

function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Load chapters from either a SOURCE.md ("N.  Name  |  anchor phrase") or an MF
// CHAPTER MARKERS section ("Name — starting phrase"; "Intro - 0:00" = pinned).
// Get the CHAPTER MARKERS block from an MF, whether sections are delimited by
// ═ bars (parseMF handles those) or by dashed rules (the v2 .md variant).
function mfChapterSection(txt) {
  var s = parseMF(txt)['CHAPTER MARKERS'];
  if (s) return s;
  var lines = txt.split(/\r?\n/), start = -1, i;
  for (i = 0; i < lines.length; i++) if (/^CHAPTER MARKERS\b/i.test(lines[i].trim())) { start = i + 1; break; }
  if (start === -1) return '';
  var out = [];
  for (i = start; i < lines.length; i++) {
    if (/^[-–—═]{6,}\s*$/.test(lines[i].trim())) { if (out.join('').trim()) break; else continue; }
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}
// Pull the start-phrase from an MF chapter line. Prefer a quoted segment; else
// drop a leading timestamp and any [bracketed] annotation. Handles both the
// bare "Name — phrase" form and the v2 "Name — 3:20 \"phrase\"" form.
function chapterPhrase(rest) {
  var q = rest.match(/["“]([^"”]{4,})["”]/);
  if (q) return q[1].trim();
  return rest.replace(/^\s*\d+:\d+\s*/, '').replace(/\[[^\]]*\]/g, '').trim();
}
function loadChapters(file) {
  var chapters = [], txt;
  try { txt = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/^﻿/, ''); }
  catch (e) { return chapters; }
  if (/START-PHRASE ANCHOR|CHAPTERS\s*\(format/i.test(txt) && /\|/.test(txt)) {
    txt.split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*\d+\.\s+(.+?)\s*\|\s*(.+?)\s*$/);
      if (!m) return;
      chapters.push({ name: m[1].trim().replace(/^"(.*)"$/, '$1'), phrase: /^\[/.test(m[2].trim()) ? null : m[2].trim() });
    });
  } else {
    mfChapterSection(txt).split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || /^\(/.test(line) || /^note\b/i.test(line) || /^\[/.test(line)) return;
      if (/^intro\b/i.test(line)) { chapters.push({ name: 'Intro', phrase: null }); return; }
      var idx = line.indexOf(' — '); if (idx === -1) idx = line.indexOf(' – ');
      if (idx === -1) return;
      chapters.push({ name: line.slice(0, idx).trim(), phrase: chapterPhrase(line.slice(idx + 3)) || null });
    });
  }
  return chapters;
}

// Anchor each chapter's start-phrase to the turn it begins at. Follows the SOURCE
// rule: first occurrence after the previous chapter; probes on the first few
// distinctive words so punctuation/em-dash/quote differences don't break matching.
// turnIdx -1 = not confidently found (flagged, not guessed).
function anchorChapters(turns, chapters) {
  var nt = turns.map(function (t) { return norm(t.paras.join(' ')); });
  var out = [], from = 0;
  chapters.forEach(function (ch) {
    if (ch.phrase == null) { out.push({ name: ch.name, turnIdx: 0, pinned: true }); return; }
    var probe = norm(ch.phrase).split(' ').slice(0, 7).join(' ');
    var found = -1, i;
    for (i = from; i < nt.length; i++) if (probe && nt[i].indexOf(probe) !== -1) { found = i; break; }
    if (found === -1) for (i = 0; i < nt.length; i++) if (probe && nt[i].indexOf(probe) !== -1) { found = i; break; }
    out.push({ name: ch.name, turnIdx: found, pinned: false });
    if (found !== -1) from = found;
  });
  return out;
}

function renderTOC(anchored) {
  if (!anchored.length) return '';
  var items = anchored.map(function (a, k) {
    return a.turnIdx >= 0
      ? '<li><a href="#ch-' + k + '">' + esc(a.name) + '</a></li>'
      : '<li class="noanchor">' + esc(a.name) + '</li>';
  }).join('');
  return '    <nav class="chapters-toc"><p class="chapters-label">Chapters</p><ol>' + items + '</ol></nav>\n';
}

function renderTurns(parsed, anchored) {
  var hostU = (parsed.meta.host || 'EMBER').toUpperCase();
  var byTurn = {};
  (anchored || []).forEach(function (a, k) {
    if (a.turnIdx >= 0) (byTurn[a.turnIdx] = byTurn[a.turnIdx] || []).push({ k: k, name: a.name });
  });
  var out = [];
  parsed.turns.forEach(function (t, ti) {
    if (byTurn[ti]) byTurn[ti].forEach(function (c) {
      out.push('      <h2 class="chapter" id="ch-' + c.k + '">' + esc(c.name) + '</h2>');
    });
    var isHost = t.speaker.toUpperCase() === hostU;
    var name = tc(t.speaker);
    var paras = t.paras.map(function (p) { return '        <p class="para">' + esc(p) + '</p>'; }).join('\n');
    out.push('      <div class="turn ' + (isHost ? 'host' : 'guest') + '" data-speaker="' + escAttr(name) + '">\n' +
      '        <p class="spk">' + esc(name) + '</p>\n' + paras + '\n      </div>');
  });
  return out.join('\n');
}

var FOOT =
  '  <footer>\n' +
  '    <p class="foot-links"><a href="' + BASE + '/">The Podcast</a> &middot; <a href="https://7h3rap157.ai/">The Book</a> &middot; <a href="https://forcesofgoodpublishing.com/">The Imprint</a></p>\n' +
  '    <p class="foot-meta">&copy; 2026 Forces of Good Publishing &middot; Tucson, Arizona</p>\n' +
  '  </footer>';

function episodePage(ep, parsed, coverFile, anchored) {
  var url = BASE + '/transcripts/' + ep.slug + '/';
  var overlay = ep.textless === true; // true once a no-text hero image is supplied
  var metaBits = [];
  if (parsed.meta.host) metaBits.push('Hosted by ' + esc(parsed.meta.host));
  if (parsed.meta.guest) metaBits.push('Guest: ' + esc(parsed.meta.guest));
  metaBits.push('Episode ' + ep.n);
  var ld = {
    "@context": "https://schema.org",
    "@type": "PodcastEpisode",
    "url": url,
    "name": ep.title,
    "episodeNumber": ep.n,
    "description": ep.desc,
    "partOfSeries": { "@type": "PodcastSeries", "name": "The Telos of AI", "url": BASE + "/" },
    "publisher": { "@id": "https://forcesofgoodpublishing.com/#org" },
    "image": url + coverFile
  };
  return '<!DOCTYPE html>\n' +
    '<!-- generated by build/build_transcripts.js — edit the source transcript or template, not this file -->\n' +
    '<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(ep.title + (ep.subtitle ? ' — ' + ep.subtitle : '')) + ' — The Telos of AI</title>\n' +
    '<meta name="description" content="' + escAttr(ep.desc) + '">\n' +
    '<link rel="canonical" href="' + url + '">\n' +
    '<link rel="icon" href="../../favicon.png">\n' +
    '<meta property="og:type" content="article">\n' +
    '<meta property="og:title" content="' + escAttr(ep.title + (ep.subtitle ? ' — ' + ep.subtitle : '')) + '">\n' +
    '<meta property="og:description" content="' + escAttr(ep.desc) + '">\n' +
    '<meta property="og:url" content="' + url + '">\n' +
    '<meta property="og:image" content="' + url + coverFile + '">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,400;1,500&family=Spectral:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet">\n' +
    '<link rel="stylesheet" href="../transcript.css">\n' +
    '<script type="application/ld+json">\n' + JSON.stringify(ld, null, 2) + '\n</script>\n' +
    '</head>\n<body>\n' +
    '  <header class="top">\n' +
    '    <a class="mark" href="../../index.html">THE TELOS OF AI</a>\n' +
    '    <a class="up" href="../index.html">All transcripts</a>\n' +
    '  </header>\n' +
    '  <main>\n' +
    '    <div class="hero ' + (overlay ? 'has-overlay' : 'is-baked') + '">\n' +
    '      <div class="hero-fig">\n' +
    '        <img class="cover" src="' + coverFile + '" alt="' + escAttr(ep.title) + '">\n' +
    '        <div class="htext"><p class="ep">Episode ' + ep.n + '</p><h1>' + (ep.heroTitle || esc(ep.title)) + '</h1></div>\n' +
    '        <div class="wm">THE TELOS OF AI</div>\n' +
    '      </div>\n' +
    '    </div>\n' +
    '    <p class="meta">' + metaBits.join(' <span class="dot">&middot;</span> ') + '</p>\n' +
    '    <div class="ttoa-player" data-player>\n' +
    '      <button type="button" class="pp" data-toggle aria-label="Play read-aloud">▶</button>\n' +
    '      <button type="button" class="pp" data-stop aria-label="Stop" hidden>■</button>\n' +
    '      <div class="pl-text">\n' +
    '        <span class="pl-title">Listen — machine-read aloud</span>\n' +
    '        <span class="pl-note" data-note>A plain synthetic voice, on purpose. The real voices are on the <a href="https://www.youtube.com/@thetelosofai">podcast &amp; YouTube</a>.</span>\n' +
    '      </div>\n' +
    '      <div class="pl-controls">\n' +
    '        <span data-voices></span>\n' +
    '        <button type="button" class="pl-chip on" data-names aria-pressed="true">Names: on</button>\n' +
    '      </div>\n' +
    '    </div>\n' +
    renderTOC(anchored) + '    <div class="transcript">\n' + renderTurns(parsed, anchored) + '\n    </div>\n' +
    '    <p class="back"><a href="../index.html">&larr; All transcripts</a></p>\n' +
    '  </main>\n' +
    FOOT + '\n' +
    '  <script src="../player.js"></script>\n' +
    '</body>\n</html>\n';
}

function indexPage(rows) {
  return '<!DOCTYPE html>\n' +
    '<!-- generated by build/build_transcripts.js -->\n' +
    '<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>Transcripts — The Telos of AI</title>\n' +
    '<meta name="description" content="Full episode transcripts for The Telos of AI — read them, or have them read aloud in a plain machine voice.">\n' +
    '<link rel="canonical" href="' + BASE + '/transcripts/">\n' +
    '<link rel="icon" href="../favicon.png">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:title" content="Transcripts — The Telos of AI">\n' +
    '<meta property="og:description" content="Read every episode, or have it read aloud.">\n' +
    '<meta property="og:url" content="' + BASE + '/transcripts/">\n' +
    '<meta property="og:image" content="' + BASE + '/ttoa-logo-square.jpg">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,400;1,500&family=Spectral:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet">\n' +
    '<link rel="stylesheet" href="transcript.css">\n' +
    '</head>\n<body>\n' +
    '  <header class="top">\n' +
    '    <a class="mark" href="../index.html">THE TELOS OF AI</a>\n' +
    '    <a class="up" href="../index.html">Home</a>\n' +
    '  </header>\n' +
    '  <main>\n' +
    '    <div class="index-head">\n' +
    '      <p class="eyebrow">Transcripts</p>\n' +
    '      <h1>Read the show</h1>\n' +
    '      <p class="lede">Every conversation, in full — read it, or press play for a plain machine voice. The good voices are on the podcast.</p>\n' +
    '    </div>\n' +
    '    <nav class="ep-list">\n' + rows + '\n    </nav>\n' +
    '  </main>\n' +
    FOOT + '\n</body>\n</html>\n';
}

function indexRow(ep) {
  return '      <a class="ep-row" href="' + ep.slug + '/">\n' +
    '        <span class="ep-num">' + String(ep.n).padStart(2, '0') + '</span>\n' +
    '        <span class="ep-body"><p class="ep-title">' + esc(ep.title) + '</p><p class="ep-hook">' + esc(ep.subtitle || ep.hook) + '</p></span>\n' +
    '        <span class="ep-go">Read &rarr;</span>\n' +
    '      </a>';
}

function sitemap() {
  var urls = [
    { loc: BASE + '/', freq: 'weekly', pri: '1.0' },
    { loc: BASE + '/llms-full.txt', freq: 'monthly', pri: '0.8' },
    { loc: BASE + '/transcripts/', freq: 'monthly', pri: '0.6' }
  ];
  episodes.forEach(function (ep) {
    urls.push({ loc: BASE + '/transcripts/' + ep.slug + '/', freq: 'yearly', pri: '0.7' });
  });
  var body = urls.map(function (u) {
    return '  <url>\n    <loc>' + u.loc + '</loc>\n    <changefreq>' + u.freq + '</changefreq>\n    <priority>' + u.pri + '</priority>\n  </url>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + '\n</urlset>\n';
}

// Parse a PPC metafile into { SECTIONNAME: content }. Sections are delimited by
// lines of ═ bars: bar / NAME / bar / content. The trailing "(parenthetical)" on
// a header is dropped. Style-guide format; if a future MF drifts, update this.
function parseMF(mfText) {
  var parts = mfText.replace(/^﻿/, '').split(/^═+[ \t]*$/m);
  var sections = {};
  for (var i = 1; i + 1 < parts.length; i += 2) {
    var name = parts[i].trim().replace(/\s*\(.*\)\s*$/, '').toUpperCase();
    if (name) sections[name] = parts[i + 1].trim();
  }
  return sections;
}
// From a COMPANION ESSAY section, return just the raw essay body (strip the
// [Pull-quote]/[Title]/[Essay body]/[Essay ends] chrome the style guide wraps it in).
function essayBody(sec) {
  var body = sec;
  var m = sec.split(/\[Essay body[^\]]*\]/i);
  if (m.length > 1) body = m[1];
  body = body.split(/\[Essay ends/i)[0];
  body = body.replace(/^[ \t]*\[[^\]]*\][ \t]*$/gm, '');
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

// Regenerate the "## Episodes" list in llms.txt from the manifest (subtitles folded in
// for search). Leaves all the bespoke prose around it untouched. Idempotent.
function updateLlms() {
  var p = path.join(SITE, 'llms.txt');
  var txt = fs.readFileSync(p, 'utf8');
  var block = episodes.map(function (ep) {
    return '- **Episode ' + ep.n + ' — ' + ep.title + (ep.subtitle ? ' — ' + ep.subtitle : '') + '.** ' + ep.desc;
  }).join('\n');
  var re = /(## Episodes\r?\n\r?\n)[\s\S]*?(\r?\n\r?\nFull transcripts)/;
  if (re.test(txt)) {
    fs.writeFileSync(p, txt.replace(re, function (m, a, b) { return a + block + b; }));
    console.log('  ✓ llms.txt (episode list)');
  } else {
    console.log('  ! llms.txt — "## Episodes" section not found, skipped');
  }
}

// Append the full transcript for any episode not already present in llms-full.txt.
// Existing episodes (with their hand-written essays) are never touched. Idempotent.
function updateLlmsFull() {
  var p = path.join(SITE, 'llms-full.txt');
  var txt = fs.readFileSync(p, 'utf8');
  var bar = new Array(81).join('=');
  var hr = new Array(50).join('-');
  var added = 0;
  episodes.forEach(function (ep) {
    if (txt.indexOf('EPISODE ' + ep.n + ' —') !== -1) return; // already in the file
    var raw = fs.readFileSync(path.join(SRC, ep.src), 'utf8').replace(/^﻿/, '');
    var body = raw.replace(/^[^\r\n]*\r?\n/, '').replace(/^\s+|\s+$/g, ''); // drop title line
    var essay = '';
    if (ep.mf) {
      try {
        var sec = parseMF(fs.readFileSync(path.join(SRC, ep.mf), 'utf8'))['COMPANION ESSAY'];
        if (sec) essay = essayBody(sec);
      } catch (e) { /* no/unreadable MF — fall back to transcript only */ }
    }
    var head = '\n\n\n' + bar + '\nEPISODE ' + ep.n + ' — ' + ep.title.toUpperCase() + '\n' + bar + '\n\n';
    txt = txt.replace(/\s+$/, '') + head + (essay ? essay + '\n\n' : '') +
      hr + '\nTRANSCRIPT\n' + hr + '\n\n' + body + '\n';
    added++;
  });
  if (added) { fs.writeFileSync(p, txt); console.log('  ✓ llms-full.txt (+' + added + ' episode' + (added > 1 ? 's' : '') + ')'); }
  else console.log('  ✓ llms-full.txt (already current)');
}

// ---- run ----
var rows = [];
episodes.forEach(function (ep) {
  var raw = fs.readFileSync(path.join(SRC, ep.src), 'utf8');
  var parsed = parseTranscript(raw);
  var anchored = anchorChapters(parsed.turns, ep.chapters ? loadChapters(ep.chapters) : []);
  var flagged = anchored.filter(function (a) { return !a.pinned && a.turnIdx < 0; });
  var ext = path.extname(ep.img) || '.png';
  var coverFile = 'cover' + ext.toLowerCase();
  var dir = path.join(OUT, ep.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(SRC, ep.img), path.join(dir, coverFile));
  fs.writeFileSync(path.join(dir, 'index.html'), episodePage(ep, parsed, coverFile, anchored));
  rows.push(indexRow(ep));
  console.log('  ✓ Ep' + ep.n + '  ' + ep.slug + '  (' + parsed.turns.length + ' turns, ' + anchored.length +
    ' chapters' + (flagged.length ? ' — ⚠ UNMATCHED: ' + flagged.map(function (f) { return f.name; }).join(' | ') : ' — all matched') + ')');
});
fs.writeFileSync(path.join(OUT, 'index.html'), indexPage(rows.join('\n')));
fs.writeFileSync(path.join(SITE, 'sitemap.xml'), sitemap());
console.log('  ✓ transcripts/index.html');
console.log('  ✓ sitemap.xml (' + (episodes.length + 3) + ' urls)');
updateLlms();
updateLlmsFull();
console.log('Done — ' + episodes.length + ' episodes.');
