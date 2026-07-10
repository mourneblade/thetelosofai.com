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

// Split a byline ("Ember and Joe") into names. Episodes have more than one host,
// so the host is a LIST — a single string can never match a speaker.
function splitNames(s) {
  return String(s).replace(/[.]+$/, '').split(/\s*(?:,|&|\band\b)\s*/i)
    .map(function (x) { return x.trim(); }).filter(Boolean);
}

// Every non-empty block of the source must land somewhere. A block that appears
// before the first "SPEAKER:" line (Ep3/Ep4 open on an unattributed narrator
// paragraph) used to fall through both arms of the if and vanish from the page.
// It is now opened as a NARRATOR turn, matching how Ep5+ label the same content.
// `dropped` stays as a tripwire: if a future regex change orphans a block, the
// preflight fails loudly instead of quietly deleting the author's words.
function parseTranscript(raw) {
  raw = raw.replace(/^﻿/, '');
  var blocks = raw.split(/\r?\n\s*\r?\n/).map(function (b) {
    return b.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);

  var meta = { hosts: [] }, turns = [], cur = null, m, consumed = 0;
  for (var idx = 0; idx < blocks.length; idx++) {
    var b = blocks[idx];
    if (idx === 0) { consumed++; continue; } // title line (manifest owns the title)
    // Tolerate "Hosted by X" and "Hosted by:  X" — the colon silently killed the byline.
    if ((m = b.match(/^hosted by\b\s*:?\s*(.+)$/i))) {
      meta.hostLine = m[1].replace(/[.]+$/, '').trim();
      meta.hosts = splitNames(m[1]);
      consumed++; continue;
    }
    if ((m = b.match(/^guests?\b\s*:?\s*(.+)$/i))) { meta.guest = m[1].replace(/[.]+$/, '').trim(); consumed++; continue; }
    m = b.match(/^([A-Z][A-Z.\-'’ ]{0,22}?):\s+([\s\S]+)$/);
    if (m) { cur = { speaker: m[1].trim(), paras: [m[2].trim()] }; turns.push(cur); }
    else if (cur) { cur.paras.push(b); }
    else { cur = { speaker: 'NARRATOR', paras: [b] }; turns.push(cur); } // pre-speaker prose
    consumed++;
  }
  var paras = turns.reduce(function (n, t) { return n + t.paras.length; }, 0);
  return { meta: meta, turns: turns, blocks: blocks.length, dropped: blocks.length - consumed, paras: paras };
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
  var chapters = [], p = path.join(SRC, file);
  // Was: catch -> return []. A typo'd filename produced zero chapters and the
  // report cheerfully said "all matched". Absent is now an error, not an empty list.
  if (!fs.existsSync(p)) throw new Error('chapters source not found: ' + file);
  var txt = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
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

// Anchor each chapter's start-phrase to the PARAGRAPH it begins at. Follows the
// SOURCE rule: first occurrence after the previous chapter; probes on the first few
// distinctive words so punctuation/em-dash/quote differences don't break matching.
// Anchors are frequently mid-turn (a chapter often starts partway into a long
// answer), so we resolve to {turnIdx, paraIdx} and let renderTurns split the turn —
// otherwise the subhead floats up to the top of the turn, paragraphs too early.
// turnIdx -1 = not confidently found (flagged, not guessed).
function seekPhrase(np, t0, p0, probe) {
  for (var t = t0; t < np.length; t++) {
    for (var p = (t === t0 ? p0 : 0); p < np[t].length; p++) {
      if (np[t][p].indexOf(probe) !== -1) return { t: t, p: p };
    }
  }
  return null;
}
function anchorChapters(turns, chapters) {
  var np = turns.map(function (t) { return t.paras.map(norm); });
  var nt = turns.map(function (t) { return norm(t.paras.join(' ')); }); // joined fallback
  var out = [], fromT = 0, fromP = 0;
  chapters.forEach(function (ch) {
    if (ch.phrase == null) { out.push({ name: ch.name, turnIdx: 0, paraIdx: 0, pinned: true }); return; }
    var probe = norm(ch.phrase).split(' ').slice(0, 7).join(' ');
    var hit = probe ? seekPhrase(np, fromT, fromP, probe) : null;
    var rescan = false;
    // Fallbacks rescan from the top, so they can land BEHIND the previous chapter.
    // Flag it — the preflight asserts monotonicity rather than trusting the match.
    if (!hit && probe) { hit = seekPhrase(np, 0, 0, probe); rescan = !!hit; }
    if (!hit && probe) { // a probe straddling a paragraph break still matches the joined turn
      for (var i = 0; i < nt.length; i++) if (nt[i].indexOf(probe) !== -1) { hit = { t: i, p: 0 }; rescan = true; break; }
    }
    out.push({ name: ch.name, turnIdx: hit ? hit.t : -1, paraIdx: hit ? hit.p : -1, pinned: false, rescan: rescan });
    if (hit) { fromT = hit.t; fromP = hit.p + 1; }
  });
  return out;
}

// The sun/gem border tracks the show's ANCHOR VOICE — the first name in the byline —
// not host-vs-guest semantics. Colouring every host sun would flatten Ep5/Ep6 (which
// have no guest) to a single colour, and would make Joe gem in Ep1 ("Hosted by Ember")
// but sun in Ep2+. The byline itself still names every host. Falls back to Ember only
// if a transcript carries no byline; the preflight rejects a byline naming a non-speaker.
function anchorVoice(parsed) {
  var names = (parsed.meta.hosts && parsed.meta.hosts.length) ? parsed.meta.hosts : ['Ember'];
  return names[0].toUpperCase();
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

// Phase 2 — "Watch on YouTube": the FINAL YouTube chapter list (EpN_chapters.txt,
// "M:SS Title") turned into deep-links (watch?v=ID&t=SECs). Video IDs verified from
// the Season-1 playlist RSS. An episode with no id yet gets no block; the preflight
// rejects an id without its timestamps file, so the block can't vanish by accident.
var YT = { 1: 'kUp8xtcrCj8', 2: 'nQxQWQUFK9A', 3: 'VT-8snBb510', 4: 'puRTy4rxkPc', 5: 'qjaMdP4uErc', 6: 'CSeZMCMIh40', 7: 'QhocOXuvlYw', 8: 'IWOBp90JSgI' };
function ytChaptersPath(n) { return path.join(SRC, 'Ep' + n + '_chapters.txt'); }
function loadYtChapters(n) {
  var out = [], p = ytChaptersPath(n);
  // Was: catch -> return [], which made the whole Watch box vanish without a word.
  // The filename is a convention, not a manifest field, so a rename is invisible.
  if (!fs.existsSync(p)) throw new Error('Ep' + n + ' has a YouTube id but no Ep' + n + '_chapters.txt');
  var txt = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  txt.split(/\r?\n/).forEach(function (line) {
    var m = line.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?\s+(.+)$/);
    if (!m) return;
    var sec = m[3] ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : (+m[1] * 60 + +m[2]);
    out.push({ sec: sec, ts: m[3] ? m[1] + ':' + m[2] + ':' + m[3] : m[1] + ':' + m[2], title: m[4].trim() });
  });
  return out;
}
function renderWatch(ep) {
  if (!YT[ep.n]) return '';
  var chs = loadYtChapters(ep.n);
  if (!chs.length) return '';
  var base = 'https://www.youtube.com/watch?v=' + YT[ep.n];
  var items = chs.map(function (c) {
    return '<li><a href="' + base + '&t=' + c.sec + 's" target="_blank" rel="noopener"><span class="yt-ts">' + c.ts + '</span> ' + esc(c.title) + '</a></li>';
  }).join('');
  return '    <nav class="watch-yt"><p class="chapters-label"><a href="' + base + '&t=0s" target="_blank" rel="noopener">&#9654; Watch on YouTube</a></p><ol>' + items + '</ol></nav>\n';
}

// A chapter that starts mid-turn splits the turn: the paragraphs before it close
// out one .turn block, the <h2> lands at top level (so it gets the chapter rule and
// spacing), and the rest of the turn reopens as a `.cont` block. Continuations carry
// no speaker line and an empty data-speaker, so the read-aloud player doesn't
// re-announce a speaker who never stopped talking. A turn with no mid-turn anchor
// emits exactly the markup it always did.
function renderTurns(parsed, anchored) {
  var anchor = anchorVoice(parsed);
  var byTurn = {};
  (anchored || []).forEach(function (a, k) {
    if (a.turnIdx < 0) return;
    var t = (byTurn[a.turnIdx] = byTurn[a.turnIdx] || {});
    (t[a.paraIdx] = t[a.paraIdx] || []).push({ k: k, name: a.name });
  });
  var out = [];
  parsed.turns.forEach(function (t, ti) {
    var isHost = t.speaker.toUpperCase() === anchor;
    var name = tc(t.speaker);
    var marks = byTurn[ti] || {};
    var frag = [], isFirst = true;
    function flush() {
      if (!frag.length) return;
      var cont = !isFirst;
      out.push('      <div class="turn ' + (isHost ? 'host' : 'guest') + (cont ? ' cont' : '') +
        '" data-speaker="' + (cont ? '' : escAttr(name)) + '">\n' +
        (cont ? '' : '        <p class="spk">' + esc(name) + '</p>\n') + frag.join('\n') + '\n      </div>');
      frag = []; isFirst = false;
    }
    t.paras.forEach(function (p, pi) {
      if (marks[pi]) {
        flush();
        marks[pi].forEach(function (c) {
          out.push('      <h2 class="chapter" id="ch-' + c.k + '">' + esc(c.name) + '</h2>');
        });
      }
      frag.push('        <p class="para">' + esc(p) + '</p>');
    });
    flush();
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
  if (parsed.meta.hostLine) metaBits.push('Hosted by ' + esc(parsed.meta.hostLine));
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
    renderTOC(anchored) + renderWatch(ep) + '    <div class="transcript">\n' + renderTurns(parsed, anchored) + '\n    </div>\n' +
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

// ---- preflight ----
// Everything this generator loads used to degrade to an empty list on failure, so a
// renamed file or a drifted format removed a feature and reported success. Each check
// below turns one of those silent omissions into a hard stop. `node build/build_transcripts.js --check`
// runs the checks and writes nothing.
var ERRORS = [], WARNINGS = [];
function err(ep, msg) { ERRORS.push('Ep' + ep.n + ': ' + msg); }
function warn(ep, msg) { WARNINGS.push('Ep' + ep.n + ': ' + msg); }

function preflight(ep, parsed, anchored) {
  ['title', 'subtitle', 'desc', 'slug', 'src', 'img'].forEach(function (k) {
    if (!ep[k]) err(ep, 'manifest is missing `' + k + '`');
  });
  if (!fs.existsSync(path.join(SRC, ep.img))) err(ep, 'hero image not found: ' + ep.img);

  // No block of the author's transcript may be dropped on the floor.
  if (parsed.dropped !== 0) err(ep, parsed.dropped + ' source block(s) dropped by parseTranscript');
  if (!parsed.turns.length) err(ep, 'no speaker turns parsed — check the "SPEAKER:" format');

  // A byline that names someone who never speaks silently repaints every turn .guest.
  var speakers = {};
  parsed.turns.forEach(function (t) { speakers[t.speaker.toUpperCase()] = true; });
  if (!parsed.meta.hostLine) err(ep, 'no "Hosted by" line found — byline would be dropped');
  (parsed.meta.hosts || []).forEach(function (h) {
    if (!speakers[h.toUpperCase()]) err(ep, 'byline names host "' + h + '" but no such speaker exists — all turns would render as guest');
  });

  // Chapters: present means non-empty, matched, and in order.
  if (ep.chapters) {
    if (!anchored.length) err(ep, 'chapters source parsed to zero chapters: ' + ep.chapters);
    var unmatched = anchored.filter(function (a) { return !a.pinned && a.turnIdx < 0; });
    if (unmatched.length) err(ep, 'UNMATCHED chapter anchor(s): ' + unmatched.map(function (u) { return u.name; }).join(' | '));
    anchored.filter(function (a) { return a.rescan; }).forEach(function (a) {
      warn(ep, 'chapter "' + a.name + '" matched only on a global rescan — verify its position');
    });
    for (var i = 1; i < anchored.length; i++) {
      var p = anchored[i - 1], c = anchored[i];
      if (p.turnIdx < 0 || c.turnIdx < 0) continue;
      if (c.turnIdx < p.turnIdx || (c.turnIdx === p.turnIdx && c.paraIdx < p.paraIdx)) {
        err(ep, 'chapter "' + c.name + '" anchors BEFORE "' + p.name + '" — the TOC would jump backwards');
      }
    }
  } else warn(ep, 'no `chapters` key — the table of contents is absent');

  // YouTube: an id and a timestamps file must arrive together, or neither.
  var hasId = Object.prototype.hasOwnProperty.call(YT, ep.n);
  var hasTs = fs.existsSync(ytChaptersPath(ep.n));
  if (hasId && !/^[A-Za-z0-9_-]{11}$/.test(YT[ep.n])) err(ep, 'YouTube id "' + YT[ep.n] + '" is not a valid 11-character id');
  if (hasId && !hasTs) err(ep, 'YouTube id set but Ep' + ep.n + '_chapters.txt is missing — the Watch box would vanish');
  if (!hasId && hasTs) warn(ep, 'Ep' + ep.n + '_chapters.txt exists but no YouTube id — no Watch box (expected if the video is unreleased)');

  if (!ep.mf) warn(ep, 'no `mf` key — the companion essay is omitted from llms-full.txt');
}

// ---- run ----
var CHECK_ONLY = process.argv.indexOf('--check') !== -1;
var slugs = {};
var built = episodes.map(function (ep) {
  if (slugs[ep.slug]) err(ep, 'duplicate slug "' + ep.slug + '" (would overwrite Ep' + slugs[ep.slug] + ')');
  slugs[ep.slug] = ep.n;
  var parsed = parseTranscript(fs.readFileSync(path.join(SRC, ep.src), 'utf8'));
  var anchored = anchorChapters(parsed.turns, ep.chapters ? loadChapters(ep.chapters) : []);
  preflight(ep, parsed, anchored);
  return { ep: ep, parsed: parsed, anchored: anchored };
});

WARNINGS.forEach(function (w) { console.log('  ⚠ ' + w); });
if (ERRORS.length) {
  console.error('\n✗ preflight failed — nothing written:\n' + ERRORS.map(function (e) { return '    ' + e; }).join('\n') + '\n');
  process.exit(1);
}
if (CHECK_ONLY) { console.log('\n✓ preflight passed for ' + episodes.length + ' episodes (--check: nothing written).'); return; }

var rows = [];
built.forEach(function (b) {
  var ep = b.ep, parsed = b.parsed, anchored = b.anchored;
  var ext = path.extname(ep.img) || '.png';
  var coverFile = 'cover' + ext.toLowerCase();
  var dir = path.join(OUT, ep.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(SRC, ep.img), path.join(dir, coverFile));
  fs.writeFileSync(path.join(dir, 'index.html'), episodePage(ep, parsed, coverFile, anchored));
  rows.push(indexRow(ep));
  var mid = anchored.filter(function (a) { return !a.pinned && a.paraIdx > 0; }).length;
  var narr = parsed.turns.filter(function (t) { return t.speaker.toUpperCase() === 'NARRATOR'; }).length;
  console.log('  ✓ Ep' + ep.n + '  ' + ep.slug + '  (' + parsed.turns.length + ' turns, ' + parsed.paras + ' paras, ' +
    anchored.length + ' chapters — all matched' + (mid ? ', ' + mid + ' mid-turn' : '') +
    ', hosts: ' + (parsed.meta.hosts || []).join('+') + (narr ? ', narrator×' + narr : '') + ')');
});
fs.writeFileSync(path.join(OUT, 'index.html'), indexPage(rows.join('\n')));
fs.writeFileSync(path.join(SITE, 'sitemap.xml'), sitemap());
console.log('  ✓ transcripts/index.html');
console.log('  ✓ sitemap.xml (' + (episodes.length + 3) + ' urls)');
updateLlms();
updateLlmsFull();
console.log('Done — ' + episodes.length + ' episodes.');
