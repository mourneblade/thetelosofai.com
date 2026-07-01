# thetelosofai.com

Website for **The Telos of AI** — a podcast about what AI is for, from Forces of Good Publishing.

## How it deploys
- Hosted on **Netlify**, auto-deployed from the `main` branch of this repo.
- Site files live in `TheTelosofAI_site/` — Netlify's publish directory (see `netlify.toml`).
- To publish a change: commit to `main` and `git push`. Netlify rebuilds automatically.

## Transcripts subsystem
Episode transcripts are generated, not hand-written:

```
build/episodes.json        ← manifest: one entry per episode (title, slug, hook, source files)
build/build_transcripts.js ← reads the Substack .txt + NO-TEXT thumbnail from ../../Transcripts/
                             and writes the index, per-episode pages, covers, and sitemap
TheTelosofAI_site/transcripts/
  index.html               ← generated episode list
  <slug>/index.html        ← generated episode page (hero + read-aloud player + transcript)
  <slug>/cover.png         ← the episode's NO-TEXT hero image (title/watermark drawn in CSS)
  transcript.css / player.js ← shared styling + the plain browser-voice read-aloud player
```

Adding an episode: drop the transcript `.txt` + a clean 1280×720 thumbnail into
`Websites/Transcripts/`, add one entry to `build/episodes.json`, then run:

```
node build/build_transcripts.js
```

Commit and push — Netlify does the rest. The build tooling sits outside the publish
directory, so it never ships; only the finished static pages deploy.
