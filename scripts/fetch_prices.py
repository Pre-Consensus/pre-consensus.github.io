#!/usr/bin/env python3
"""
Refresh data/prices.json for the Pre-Consensus site.

Reads the tickers out of data/portfolio.json (plus the benchmark), pulls a quote
for each, and writes them back as a flat JSON file the front end can poll.

Standard library only — no pip install, runs the same on your Mac and in CI.

Sources, in order of preference:
  1. Yahoo Finance chart endpoint  — free, no key, ~15 min delayed
  2. Finnhub                       — free key in FINNHUB_KEY, used only if Yahoo throttles

If you later want genuine real-time data, get a Polygon or Finnhub key, add a
fetcher below, and set "delayed": False in the output.

Usage:  python3 scripts/fetch_prices.py
"""

import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORTFOLIO = ROOT / "data" / "portfolio.json"
PRICES = ROOT / "data" / "prices.json"

# Deliberately a plain, honest UA. A full browser UA string gets 429'd here,
# because it claims to be Chrome while obviously not being Chrome.
UA = "Mozilla/5.0"
SOURCE_LABEL = "Yahoo Finance (delayed)"


def get(url, timeout=20, tries=4):
    """GET with backoff. The free endpoints rate-limit hard; a 429 is normal
    and simply means wait a moment, not that the ticker is bad."""
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 502, 503, 504):
                time.sleep(2 ** attempt + 1)   # 2s, 3s, 5s, 9s
                continue
            raise
        except (urllib.error.URLError, OSError) as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last


def from_yahoo(ticker):
    """Latest price via the chart endpoint. Returns (price, prev_close) or None.
    Tries both Yahoo hosts — they rate-limit independently."""
    for host in ("query1", "query2"):
        url = (f"https://{host}.finance.yahoo.com/v8/finance/chart/{ticker}"
               f"?interval=1d&range=5d")
        try:
            meta = json.loads(get(url))["chart"]["result"][0]["meta"]
        except (urllib.error.URLError, urllib.error.HTTPError, KeyError, TypeError,
                IndexError, ValueError, OSError):
            continue
        price = meta.get("regularMarketPrice")
        if price is not None:
            return float(price), meta.get("chartPreviousClose") or meta.get("previousClose")
    return None


def from_finnhub(ticker):
    """Fallback for when Yahoo is throttling. Needs a free key in FINNHUB_KEY —
    set it as a repo secret and the workflow passes it through. Without a key
    this quietly does nothing."""
    key = os.environ.get("FINNHUB_KEY")
    if not key:
        return None
    url = f"https://finnhub.io/api/v1/quote?symbol={ticker}&token={key}"
    try:
        d = json.loads(get(url, tries=2))
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError):
        return None
    if not d.get("c"):
        return None
    return float(d["c"]), d.get("pc")


def quote(ticker):
    for name, fn in (("yahoo", from_yahoo), ("finnhub", from_finnhub)):
        result = fn(ticker)
        if result:
            price, prev = result
            return {"price": round(price, 4),
                    "prevClose": round(float(prev), 4) if prev else None,
                    "src": name}
    return None


def close_on(ticker, day):
    """Closing price on a specific YYYY-MM-DD, for pinning the benchmark start."""
    try:
        start = int(datetime.strptime(day, "%Y-%m-%d")
                    .replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?period1={start - 86400 * 6}&period2={start + 86400 * 6}&interval=1d")
    try:
        res = json.loads(get(url))["chart"]["result"][0]
        stamps = res["timestamp"]
        closes = res["indicators"]["quote"][0]["close"]
    except (urllib.error.URLError, KeyError, TypeError, IndexError,
            json.JSONDecodeError, OSError):
        return None
    # The first session on or after the requested day.
    for ts, c in zip(stamps, closes):
        if c is not None and ts >= start - 43200:
            return round(float(c), 4)
    return None


def main():
    portfolio = json.loads(PORTFOLIO.read_text())

    tickers = [p["ticker"] for p in portfolio.get("positions", [])]
    bench = portfolio.get("benchmark") or {}
    if bench.get("symbol") and bench["symbol"] not in tickers:
        tickers.append(bench["symbol"])

    quotes, failed = {}, []
    for t in tickers:
        q = quote(t)
        if q:
            quotes[t] = q
            print(f"  {t:<8} {q['price']:>12,.2f}   ({q['src']})")
        else:
            failed.append(t)
            print(f"  {t:<8} {'no quote':>12}", file=sys.stderr)
        time.sleep(1.2)   # be a good citizen with the free endpoints

    PRICES.write_text(json.dumps({
        "asOf": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "delayed": True,
        "source": SOURCE_LABEL,
        "failed": failed,
        "quotes": quotes,
    }, indent=2) + "\n")
    print(f"\nWrote {PRICES.relative_to(ROOT)} — {len(quotes)} quote(s)"
          + (f", {len(failed)} failed" if failed else ""))

    # One-time: pin the benchmark's price on the inception date so the
    # comparison is against the same dollars over the same window.
    if bench.get("symbol") and not bench.get("startPrice"):
        px = close_on(bench["symbol"], bench.get("startDate")
                      or portfolio.get("inceptionDate", ""))
        if px:
            portfolio["benchmark"]["startPrice"] = px
            PORTFOLIO.write_text(json.dumps(portfolio, indent=2) + "\n")
            print(f"Pinned {bench['symbol']} inception close at {px}")

    # A total failure is worth a non-zero exit so CI shows red.
    return 1 if tickers and not quotes else 0


if __name__ == "__main__":
    sys.exit(main())
