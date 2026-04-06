#!/usr/bin/env python3
"""Convert a price CSV (Investing.com format) to a JS price array.

Usage:
    python3 csv_to_js.py "Flow Historical Data (1).csv" flow_prices.js
    python3 csv_to_js.py input.csv output.js           # custom files
"""

import csv
import sys
import os

def convert(csv_path, js_path):
    prices = []
    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            price = row.get('Price', '').strip().replace('"', '').replace(',', '')
            if price:
                prices.append(float(price))

    # CSV is newest-first → reverse to oldest-first
    prices.reverse()

    const_name = os.path.splitext(os.path.basename(js_path))[0].upper()
    const_name = const_name.replace('-', '_').replace(' ', '_')

    with open(js_path, 'w') as f:
        f.write(f'export const {const_name} = [{",".join(str(p) for p in prices)}];\n')

    print(f"Wrote {len(prices)} prices → {js_path}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        csv_file = 'Flow Historical Data (1).csv'
        js_file  = 'flow_prices.js'
    elif len(sys.argv) < 3:
        csv_file = sys.argv[1]
        js_file  = os.path.splitext(os.path.basename(csv_file))[0].lower().replace(' ', '_') + '.js'
    else:
        csv_file = sys.argv[1]
        js_file  = sys.argv[2]
    convert(csv_file, js_file)
