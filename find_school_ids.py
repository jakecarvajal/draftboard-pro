"""
find_school_ids.py — Discover TBC school IDs for all schools in the Players sheet.

Strategy per school:
  1. If a player from that school already has a tbcId  -> visit /content/player/{id}/ directly
  2. Otherwise -> search TBC for the player name, find their profile link, visit it
  Then extract the school ID from stats_college or /content/school/ links on the profile page.

Saves results to schools.json in the format { "school_id": { "name": "...", "conf": "..." } }
"""

import json
import time
import re
import gspread
from google.oauth2.service_account import Credentials
from playwright.sync_api import sync_playwright

SHEET_ID = "1j11FxEEADuAvFy5pJKVsQAfJKPGO6TRTxJT6gHnDRFI"
TBC_BASE = "https://www.thebaseballcube.com"
SCOPES   = ["https://www.googleapis.com/auth/spreadsheets"]

# IDs confirmed from admin HTML + previous runs
KNOWN_IDS = {
    "Blinn College":             "20349",
    "Central Arizona College":   "20222",
    "Mississippi Gulf Coast CC": "20852",
}


def load_players():
    creds = Credentials.from_service_account_file("Credentials.json", scopes=SCOPES)
    gc    = gspread.authorize(creds)
    ws    = gc.open_by_key(SHEET_ID).worksheet("Players")
    rows  = ws.get_all_values()
    headers = rows[0]
    def col(n): return headers.index(n) if n in headers else -1
    ni, si, ci, ti = col("name"), col("school"), col("conf"), col("tbcId")
    out = []
    for row in rows[1:]:
        def g(i): return row[i].strip() if i >= 0 and i < len(row) else ""
        out.append({"name": g(ni), "school": g(si), "conf": g(ci), "tbc_id": g(ti)})
    return out


def pick_one_per_school(players):
    """Return { school_name -> {conf, player_name, tbc_id} }.
    Prefer a row that already has a tbcId so we can skip the search step."""
    seen = {}
    for p in sorted(players, key=lambda x: (not x["tbc_id"], x["name"])):
        s = p["school"]
        if s and s not in seen:
            seen[s] = {"conf": p["conf"], "player": p["name"], "tbc_id": p["tbc_id"]}
    return seen


EXTRACT_SCHOOL_ID_JS = r"""() => {
    // Priority 1: links like /content/stats_college/2024~20349/
    const statLinks = Array.from(document.querySelectorAll('a[href*="stats_college"]'));
    for (const a of statLinks) {
        const m = a.href.match(/stats_college\/(\d+)~(\d+)\//);
        if (m) return { schoolId: m[2], year: m[1], src: 'stats_college', text: a.textContent.trim() };
    }
    // Priority 2: links like /content/school/20349/
    const schoolLinks = Array.from(document.querySelectorAll('a[href*="/content/school/"]'));
    for (const a of schoolLinks) {
        const m = a.href.match(/\/content\/school\/(\d+)\//);
        if (m) return { schoolId: m[1], src: 'school_page', text: a.textContent.trim() };
    }
    // Priority 3: any href containing a 4-6 digit ID after a tilde (team season pages)
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    for (const a of allLinks) {
        if (a.href.includes('/content/player/')) continue;
        const m = a.href.match(/~(\d{4,6})\//);
        if (m) return { schoolId: m[1], src: 'tilde_pattern', text: a.textContent.trim() };
    }
    // Debug: return a snippet of the page so we can see what's there
    return { schoolId: null, debug: document.body.innerText.substring(0, 400) };
}"""


def search_for_player(page, name):
    """Search TBC for player name, return first /content/player/ ID found."""
    query = name.replace(" ", "_")
    page.goto(f"{TBC_BASE}/search_results.asp?Q={query}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
    return page.evaluate(r"""() => {
        const links = Array.from(document.querySelectorAll('a[href*="/content/player/"]'));
        if (!links.length) return null;
        const m = links[0].href.match(/\/content\/player\/(\d+)\//);
        return m ? m[1] : null;
    }""")


def main():
    print("Loading Players sheet...")
    players = load_players()
    schools = pick_one_per_school(players)
    print(f"Unique schools : {len(schools)}")

    # Seed with known IDs
    found   = dict(KNOWN_IDS)   # school_name -> school_id (string)
    missing = []

    to_discover = {s: info for s, info in schools.items() if s not in found}
    print(f"Already known  : {len(found)}")
    print(f"To discover    : {len(to_discover)}\n")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        for school_name, info in to_discover.items():
            tbc_id = info["tbc_id"]
            player = info["player"]
            print(f"  {school_name:45s}", end="  ", flush=True)

            try:
                # Step 1 — land on a player profile page
                if tbc_id:
                    page.goto(f"{TBC_BASE}/content/player/{tbc_id}/",
                              wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_timeout(3000)
                    via = "direct"
                else:
                    found_tbc = search_for_player(page, player)
                    if not found_tbc:
                        print(f"MISS  (no TBC result for '{player}')")
                        missing.append(school_name)
                        time.sleep(1)
                        continue
                    page.goto(f"{TBC_BASE}/content/player/{found_tbc}/",
                              wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_timeout(3000)
                    via = "search"

                # Step 2 — extract school ID from profile page
                info_js = page.evaluate(EXTRACT_SCHOOL_ID_JS)

                if info_js and info_js.get("schoolId"):
                    sid = info_js["schoolId"]
                    found[school_name] = sid
                    label = info_js.get("text", "")[:30]
                    print(f"ID={sid:<8} via={via:<7} src={info_js.get('src','')}  '{label}'")
                else:
                    dbg = (info_js or {}).get("debug", "")[:120].replace("\n", " ")
                    print(f"MISS  (no link found, player='{player}', page='{dbg}')")
                    missing.append(school_name)

            except Exception as e:
                print(f"ERROR: {e}")
                missing.append(school_name)

            time.sleep(1.5)

        browser.close()

    # Build and save schools.json
    output = {}
    for school_name, info in schools.items():
        if school_name in found:
            output[found[school_name]] = {
                "name": school_name,
                "conf": info["conf"],
            }

    with open("schools.json", "w") as f:
        json.dump(output, f, indent=2, sort_keys=True)

    print(f"\n{'='*60}")
    print(f"  Schools found  : {len(found)} / {len(schools)}")
    print(f"  Missing        : {len(missing)}")
    print(f"  Saved to       : schools.json")
    print(f"{'='*60}")

    if missing:
        print("\nStill missing IDs for:")
        for s in missing:
            print(f"  {s}")


if __name__ == "__main__":
    main()
