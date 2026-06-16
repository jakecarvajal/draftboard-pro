"""
check_players.py  —  Audit players in the Google Sheet.

Fetches the Players tab via the public gviz API and reports:
  - Count of players with id < 1547 (original synthetic waves) vs id >= 1547 (real scraped)
  - A preview of the first 30 synthetic-era players with their key stat and a
    name-quality flag (REAL / GENERATED) based on simple heuristics.

Run:
  python check_players.py
  python check_players.py --limit 50   # show more rows
"""

import argparse
import json
import re
import sys

import requests

SHEET_ID    = "1j11FxEEADuAvFy5pJKVsQAfJKPGO6TRTxJT6gHnDRFI"
PLAYERS_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:json&sheet=Players"

SYNTHETIC_ID_CUTOFF = 1547


# ── Gviz parser (mirrors the JS version in index.html) ───────────────────────

def parse_gviz(text):
    start = text.index("{")
    end   = text.rindex("}") + 1
    data  = json.loads(text[start:end])
    cols  = [c["label"] for c in data["table"]["cols"]]
    rows  = []
    for row in data["table"]["rows"]:
        cells = row.get("c") or []
        obj   = {}
        for i, col in enumerate(cols):
            cell = cells[i] if i < len(cells) else None
            obj[col] = cell["v"] if (cell and cell.get("v") is not None) else None
        rows.append(obj)
    return rows


# ── Name heuristic ────────────────────────────────────────────────────────────

# Flags that almost certainly mean a name was machine-generated.
_GENERATED_RE = re.compile(
    r"""
      \d           |  # any digit
      [_@#]        |  # common auto-gen separators
      ^[A-Z]{4,}$    # all-caps single token
    """,
    re.VERBOSE,
)

def name_quality(name: str) -> str:
    """Return 'REAL' or 'GENERATED' based on lightweight heuristics."""
    if not name:
        return "GENERATED"
    parts = name.strip().split()
    # Must have at least first + last
    if len(parts) < 2:
        return "GENERATED"
    # Any part that triggers the generated pattern
    for part in parts:
        if _GENERATED_RE.search(part):
            return "GENERATED"
        # Each part should start with an uppercase letter
        if not part[0].isupper():
            return "GENERATED"
        # Suspiciously short tokens (single char that isn't an initial with a dot)
        if len(part) == 1:
            return "GENERATED"
    return "REAL"


# ── Fetch & analyse ───────────────────────────────────────────────────────────

def fetch_players():
    print(f"Fetching Players tab from Google Sheets…")
    try:
        r = requests.get(PLAYERS_URL, timeout=20)
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"ERROR: could not fetch sheet — {e}", file=sys.stderr)
        sys.exit(1)
    players = parse_gviz(r.text)
    print(f"  {len(players)} rows returned.\n")
    return players


def main():
    ap = argparse.ArgumentParser(description="Audit synthetic vs real players in the Google Sheet")
    ap.add_argument("--limit", type=int, default=30, help="How many id<1547 players to print (default: 30)")
    args = ap.parse_args()

    players = fetch_players()

    # Partition by id
    synthetic = []
    real_scraped = []
    unparseable  = []

    for p in players:
        try:
            pid = int(float(p.get("id") or 0))
        except (ValueError, TypeError):
            unparseable.append(p)
            continue
        p["_id_int"] = pid
        if pid < SYNTHETIC_ID_CUTOFF:
            synthetic.append(p)
        else:
            real_scraped.append(p)

    synthetic.sort(key=lambda p: p["_id_int"])

    # ── Summary counts ────────────────────────────────────────────────────────
    print("=" * 66)
    print("  PLAYER COUNT BREAKDOWN")
    print("=" * 66)
    print(f"  id < {SYNTHETIC_ID_CUTOFF}  (original synthetic waves) : {len(synthetic):>5}")
    print(f"  id >= {SYNTHETIC_ID_CUTOFF} (scraped from TBC)         : {len(real_scraped):>5}")
    if unparseable:
        print(f"  unparseable id                              : {len(unparseable):>5}")
    print(f"  TOTAL                                       : {len(players):>5}")
    print()

    # ── Name-quality breakdown for synthetic group ────────────────────────────
    real_names      = [p for p in synthetic if name_quality(p.get("name","")) == "REAL"]
    generated_names = [p for p in synthetic if name_quality(p.get("name","")) == "GENERATED"]

    print("  Name quality within id < 1547:")
    print(f"    Look like real people : {len(real_names)}")
    print(f"    Look generated        : {len(generated_names)}")
    print()

    # ── Per-player table (first N synthetic) ─────────────────────────────────
    limit = min(args.limit, len(synthetic))
    print("=" * 66)
    print(f"  FIRST {limit} PLAYERS WITH id < {SYNTHETIC_ID_CUTOFF}")
    print("=" * 66)
    print(f"  {'ID':>5}  {'Name':<28}  {'Conf':<14}  {'Stat':>8}  {'Quality'}")
    print(f"  {'-'*5}  {'-'*28}  {'-'*14}  {'-'*8}  {'-'*9}")

    for p in synthetic[:limit]:
        pid   = p["_id_int"]
        name  = (p.get("name") or "—")[:28]
        conf  = (p.get("conf") or "—")[:14]
        quality = name_quality(p.get("name",""))

        is_pitcher = str(p.get("isPitcher","")).lower() in ("true","1","yes")
        if is_pitcher:
            raw = p.get("jucoP_era")
            stat_str = f"ERA {float(raw):.2f}" if raw is not None else "ERA  —"
        else:
            raw = p.get("juco_ops")
            stat_str = f"OPS {float(raw):.3f}" if raw is not None else "OPS  —"

        print(f"  {pid:>5}  {name:<28}  {conf:<14}  {stat_str:>8}  {quality}")

    if len(synthetic) > limit:
        print(f"\n  … and {len(synthetic) - limit} more (run with --limit N to see more)")
    print()


if __name__ == "__main__":
    main()
