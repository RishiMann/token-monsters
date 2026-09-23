"""Seasonal menus and release dates, computed from today's date.

Mirrors frontend/js/seasons.js so the agents and the storefront agree on
what is on the counter: a menu is live between `opens` and `closes`, and
each item inside it releases on its own `releaseDate`.
"""

from datetime import date


def _day(iso):
    return date.fromisoformat(iso)


def days_until(iso, today=None):
    today = today or date.today()
    return (_day(iso) - today).days


def season_state(menu, today=None):
    """live | preorder | planned | closed, plus days until it opens."""
    today = today or date.today()
    if not menu.get("opens") or not menu.get("closes"):
        return {"state": "planned", "days_until": None}
    opens, closes = _day(menu["opens"]), _day(menu["closes"])
    if opens <= today <= closes:
        state = "live"
    elif today < opens:
        state = "preorder" if days_until(menu["opens"], today) <= 56 else "planned"
    else:
        state = "closed"
    return {"state": state, "days_until": days_until(menu["opens"], today)}


def is_released(item, menu, today=None):
    today = today or date.today()
    if season_state(menu, today)["state"] != "live":
        return False
    return today >= _day(item.get("releaseDate") or menu["opens"])


def with_state(menus, today=None):
    today = today or date.today()
    out = []
    for menu in menus:
        info = season_state(menu, today)
        items = menu.get("items", [])
        out.append({
            **{k: v for k, v in menu.items() if k != "items"},
            "status": info["state"],
            "daysUntil": info["days_until"],
            "items": [{"id": i["id"], "name": i["name"], "price": i.get("price"),
                       "releaseDate": i.get("releaseDate") or menu["opens"],
                       "released": is_released(i, menu, today)} for i in items],
        })
    return out


def released_items(menus, today=None):
    """Seasonal items a customer can buy today, tagged with their menu."""
    today = today or date.today()
    out = []
    for menu in menus:
        for item in menu.get("items", []):
            if is_released(item, menu, today):
                out.append({**item, "season": menu["id"], "seasonName": menu["name"],
                            "badge": item.get("badge", "Seasonal")})
    return out


def live_seasons(menus, today=None):
    today = today or date.today()
    return [m for m in with_state(menus, today) if m["status"] == "live"]


def upcoming_releases(menus, today=None, limit=None):
    today = today or date.today()
    out = []
    for menu in menus:
        if season_state(menu, today)["state"] == "closed":
            continue
        for item in menu.get("items", []):
            if is_released(item, menu, today):
                continue
            when = item.get("releaseDate") or menu["opens"]
            out.append({"id": item["id"], "name": item["name"], "menu": menu["name"],
                        "menuId": menu["id"], "date": when, "daysUntil": days_until(when, today)})
    out.sort(key=lambda r: (r["date"], r["name"]))
    return out[:limit] if limit else out
