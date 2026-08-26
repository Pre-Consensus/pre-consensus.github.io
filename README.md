# Pre-Consensus

A real-money portfolio site. Static, black and white, no build step, no backend.

Positions and reasoning live in `data/`. The site reads them in the browser and does
all the portfolio math client-side. A GitHub Action refreshes quotes on a schedule.

---

## Run it locally

Open `index.html` directly and the browser will block it from reading `data/` — you need
a local server:

```bash
cd preconsensus && python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

---

## First-time setup

**1. Put your logo in.** Save your PC monogram as `assets/logo.svg` (black artwork on a
transparent background). It's picked up automatically and inverted in dark mode. Until
you add it, the header falls back to typeset "PC".

**2. Fill in `data/portfolio.json`.**

| Field | What it does |
|---|---|
| `startingCash` | The dollars you funded the Public.com account with |
| `inceptionDate` | Day one. The benchmark is measured from here |
| `cashFlows` | Later deposits/withdrawals: `{"date":"…","amount":5000}`. Keeps returns honest |
| `benchmark.startPrice` | Leave at `0` — the fetch script pins it to the real close on your inception date the first time it runs |
| `repoUrl` | Your GitHub repo. Powers the "inspect the commit history" link |
| `seedData` | **Delete this line** once your real trades are in. It drives the placeholder banner |

**3. Log your trades.** Public.com has no API, so this part is manual — which is fine,
you trade in weeks, not milliseconds. After each fill, add to that position's `trades`:

```json
{ "date": "2026-08-26", "action": "buy", "qty": 120, "price": 41.85, "fees": 0,
  "note": "Why, in one or two sentences, at the moment of the trade." }
```

Sells are identical with `"action": "sell"`. Everything else — average cost, weight,
realised and unrealised P&L, benchmark spread — is derived. When a position's shares
reach zero it moves itself to the Closed table and keeps its page.

**4. Write the thesis.** One markdown file per position at `data/theses/<TICKER>.md`.
`EXMPL.md` is a scaffold showing the structure; replace it. Supported: headings, bold,
italic, links, lists, blockquotes, code, horizontal rules.

**5. Add updates** to a position's `updates` array as the story develops. Append new
dated entries — never edit an old one. If you were wrong, say so in a new entry and
leave the original standing. That's the whole product.

---

## Prices

```bash
python3 scripts/fetch_prices.py
```

Pulls a quote for every ticker plus the benchmark and writes `data/prices.json`. The
front end re-reads that file every 60 seconds, so an open tab updates without a refresh.

Source is Yahoo Finance, roughly 15 minutes delayed and free. The footer says so, which
is the honest thing to do. Two notes from setting this up:

- Yahoo rate-limits a *browser-shaped* User-Agent but serves a plain `Mozilla/5.0`
  happily. The script uses the plain one. Don't "improve" it into a Chrome string.
- Stooq used to work as a keyless fallback and now sits behind a JS challenge. The
  fallback is Finnhub instead: get a free key, add it to the repo as a secret named
  `FINNHUB_KEY`, and it's used only when Yahoo throttles. Without a key it's skipped.

For genuine real-time data you'd need a paid feed (Polygon, ~$30/mo). Add a fetcher in
`scripts/fetch_prices.py` and set `"delayed": False` in the output.

### The scheduled refresh

`.github/workflows/prices.yml` runs every 30 minutes during market hours and commits
`data/prices.json` if it changed. GitHub cron is UTC and ignores daylight saving, so the
window drifts an hour half the year — harmless.

---

## Deploying

**GitHub Pages** is the natural home, since the repo is public anyway:

1. Push this folder to a public repo.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. It's live at `https://<you>.github.io/<repo>/` in a minute or two.

Vercel and Netlify also work — point them at the folder, no build command, no output
directory.

---

## About the proof

The credibility claim of this site is that calls were made *before* the move, and git is
what backs that up. Each trade and thesis is a commit with a timestamp you can't forge.

The price bot commits every half hour, which would bury the trades in `git log`. So the
footer link points at the history of `data/` specifically, and the useful command is:

```bash
git log --follow -p -- data/portfolio.json
```

That shows every change to the positions and reasoning, and nothing else.

---

## Disclaimer

Publishing your own positions and reasoning is not regulated investment advice. It stays
that way as long as you don't manage anyone else's money, charge for personalised
recommendations, or take compensation for promoting a security. If any of that changes,
talk to a securities lawyer before it does. The site carries a standing disclaimer in
the footer — edit the wording in `index.html`, but don't remove it.
