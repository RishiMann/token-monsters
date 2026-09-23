"""Fetches the dessert photographs and points the catalog at them.

Each item in tools/photos.json maps to a Pexels photo. The photo is fetched
at 800x600 (the CDN crops and compresses server-side, so nothing is
processed here), saved as frontend/assets/desserts/<id>.jpg, and the item's
`image` in backend/storefront.json is switched to it. The vector art an item
used before is removed once its photo is in place, and an ATTRIBUTION.md
records where every photo came from.

Pexels photos are free to use without attribution; the record is kept so a
photo can be traced or replaced.

Run: python tools/fetch_photos.py [--force]
"""

import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "tools/photos.json"
STOREFRONT = ROOT / "backend/storefront.json"
OUT = ROOT / "frontend/assets/desserts"
PARAMS = "?auto=compress&cs=tinysrgb&w=800&h=600&fit=crop"


def fetch(url, dest):
    request = urllib.request.Request(url, headers={"User-Agent": "FrostedCorner/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response, open(dest, "wb") as out:
        out.write(response.read())


def main():
    force = "--force" in sys.argv
    manifest = {k: v for k, v in json.loads(MANIFEST.read_text()).items() if not k.startswith("_")}
    OUT.mkdir(parents=True, exist_ok=True)

    fetched, kept, failed = [], [], []
    for item_id, photo in manifest.items():
        dest = OUT / f"{item_id}.jpg"
        if dest.exists() and not force:
            kept.append(item_id)
            continue
        try:
            fetch(photo["src"] + PARAMS, dest)
            fetched.append(item_id)
        except Exception as exc:  # keep going; the summary names what failed
            failed.append((item_id, str(exc)))
            if dest.exists():
                dest.unlink()

    data = json.loads(STOREFRONT.read_text(encoding="utf-8"))
    every = [*data["weeklyMenu"], *data["plantBased"],
             *(entry for menu in data["eventMenus"] for entry in menu["items"])]
    switched = 0
    for entry in every:
        if (OUT / f"{entry['id']}.jpg").exists():
            entry["image"] = f"assets/desserts/{entry['id']}.jpg"
            switched += 1
            old = OUT / f"{entry['id']}.svg"
            if old.exists():
                old.unlink()
    STOREFRONT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    lines = ["# Dessert photographs", "",
             "Source: [Pexels](https://www.pexels.com), under the "
             "[Pexels License](https://www.pexels.com/license/) (free to use, no attribution required).",
             "Fetched by `tools/fetch_photos.py` from `tools/photos.json`; each file is the CDN's 800x600 crop.", "",
             "| Item | Photo | Description |", "| --- | --- | --- |"]
    for item_id, photo in manifest.items():
        photo_id = photo["src"].split("/photos/")[1].split("/")[0]
        lines.append(f"| `{item_id}` | https://www.pexels.com/photo/{photo_id}/ | {photo['alt']} |")
    (OUT / "ATTRIBUTION.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"fetched {len(fetched)}, kept {len(kept)}, failed {len(failed)}; "
          f"{switched} catalog items now use photos")
    for item_id, why in failed:
        print(f"  FAILED {item_id}: {why}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
