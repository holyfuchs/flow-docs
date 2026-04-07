#!/usr/bin/env python3
"""
Download historical daily close prices from CryptoCompare (free, no API key).
Paginates to get full history. Outputs one JS file per asset.

Usage:
    python3 download_prices.py
"""

import json
import os
import time
import urllib.request
import urllib.error

# (cryptocompare_symbol, output_js_const, output_filename)
ASSETS = [
    ("BTC",   "BITCOIN_PRICES",   "bitcoin_prices.js"),
    ("ETH",   "ETHEREUM_PRICES",  "ethereum_prices.js"),
    ("FLOW",  "FLOW_PRICES",      "flow_prices.js"),
    ("AAVE",  "AAVE_PRICES",      "aave_prices.js"),
    ("UNI",   "UNISWAP_PRICES",   "uniswap_prices.js"),
    ("LINK",  "CHAINLINK_PRICES", "chainlink_prices.js"),
    ("SOL",   "SOLANA_PRICES",    "solana_prices.js"),
    ("MATIC", "MATIC_PRICES",     "matic_prices.js"),
    ("MKR",   "MAKER_PRICES",     "maker_prices.js"),
]

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE    = "https://min-api.cryptocompare.com/data/v2/histoday"

def fetch_all(symbol):
    """Paginate backwards until no more data. Returns list of (time, close) sorted asc."""
    collected = {}
    to_ts = None
    while True:
        url = f"{BASE}?fsym={symbol}&tsym=USD&limit=2000"
        if to_ts:
            url += f"&toTs={to_ts}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())

        if data.get("Response") != "Success":
            print(f"  API error: {data.get('Message', data)}")
            break

        entries = data["Data"]["Data"]
        new = {e["time"]: e["close"] for e in entries if e["close"] > 0}
        if not new or all(t in collected for t in new):
            break
        collected.update(new)

        earliest = min(new)
        # CryptoCompare returns zeros before listing — stop when we hit them
        zero_count = sum(1 for e in entries if e["close"] == 0)
        if zero_count > 5:
            break

        to_ts = earliest - 1
        time.sleep(0.5)

    return [collected[t] for t in sorted(collected)]

def write_js(prices, const_name, js_path):
    with open(js_path, "w") as f:
        f.write(f"export const {const_name} = [{','.join(str(round(p, 6)) for p in prices)}];\n")
    print(f"  {len(prices)} days → {os.path.basename(js_path)}")

for symbol, const_name, filename in ASSETS:
    print(f"Fetching {symbol}...")
    try:
        prices = fetch_all(symbol)
        if prices:
            write_js(prices, const_name, os.path.join(OUT_DIR, filename))
        else:
            print(f"  No data returned.")
    except Exception as e:
        print(f"  ERROR: {e}")
    time.sleep(1.0)

print("\nDone.")
