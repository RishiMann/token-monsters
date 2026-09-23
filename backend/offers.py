"""Offer rules, evaluated the way the browser does (frontend/js/offers.js).

Every offer in the catalog carries a `rule`. Given the box and what is known
about the customer, each offer is either eligible with the amount it takes
off, or ineligible with the plain reason why. One discount applies at a time;
free delivery is automatic and stacks.

Lines are [{"item": <catalog item>, "qty": int}].
"""


def _money(value):
    return f"${value:.2f}"


def _plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def _facts(lines, customer, live_seasons):
    customer = customer or {}
    count = sum(l["qty"] for l in lines)
    subtotal = sum(l["item"]["price"] * l["qty"] for l in lines)
    live_ids = {s["id"] for s in live_seasons}
    seasonal_units = sum(
        l["qty"] for l in lines
        if l["item"].get("season") and (not live_ids or l["item"]["season"] in live_ids))
    favorites = customer.get("favorites") or []
    favorite_ids = {f["id"] for f in favorites}
    favorite_lines = sorted(
        (l for l in lines if l["item"]["id"] in favorite_ids),
        key=lambda l: -l["qty"])
    return {
        "lines": lines, "count": count, "subtotal": subtotal,
        "flavors": len({l["item"]["id"] for l in lines}),
        "seasonal_units": seasonal_units,
        "live_season_name": live_seasons[0]["name"] if live_seasons else None,
        "signed_in": bool(customer.get("signed_in")),
        "favorites": favorites, "favorite_lines": favorite_lines,
    }


def _evaluate(offer, f):
    rule = offer.get("rule") or {}
    kind = rule.get("type")

    if kind == "percent":
        if rule.get("requires") == "favorite":
            if not f["signed_in"]:
                return {"eligible": False, "why": "Sign in and your reorder rate applies to a box of favorites."}
            if not f["favorites"]:
                return {"eligible": False, "why": "Order a couple of boxes first — this one prices your regulars."}
            need = rule.get("minFavoriteUnits", 4)
            hit = next((l for l in f["favorite_lines"] if l["qty"] >= need), None)
            if hit:
                return {"eligible": True, "discount": round(f["subtotal"] * rule["percent"] / 100, 2),
                        "why": f"{hit['qty']} × {hit['item']['name']} — you keep coming back for it."}
            closest = f["favorite_lines"][0] if f["favorite_lines"] else None
            name = closest["item"]["name"] if closest else f["favorites"][0].get("name", "a favorite")
            have = closest["qty"] if closest else 0
            return {"eligible": False, "progress": round(have / need * 100),
                    "why": f"Add {_plural(need - have, 'more')} {name} — {need} of a favorite unlocks it."}

        tiers = rule.get("tiers") or [{"minItems": rule.get("minItems", 0), "percent": rule["percent"]}]
        tier = next((t for t in tiers
                     if f["count"] >= t.get("minItems", 0) and f["flavors"] >= t.get("minFlavors", 0)), None)
        if tier:
            better = next((t for t in tiers if t["percent"] > tier["percent"]), None)
            nudge = ""
            if better and f["flavors"] < better.get("minFlavors", 0):
                nudge = f" Mix in {_plural(better['minFlavors'] - f['flavors'], 'more flavor')} for {better['percent']}%."
            return {"eligible": True, "percent": tier["percent"],
                    "discount": round(f["subtotal"] * tier["percent"] / 100, 2),
                    "why": f"{f['count']} treats across {_plural(f['flavors'], 'flavor')} — the box takes {tier['percent']}% off.{nudge}"}
        need = min(t.get("minItems", 0) for t in tiers)
        return {"eligible": False, "progress": round(f["count"] / need * 100) if need else 0,
                "why": f"Add {_plural(need - f['count'], 'more')} to fill the six-count."}

    if kind == "free-addon":
        need = rule.get("minItems", 12)
        if f["count"] >= need:
            return {"eligible": True, "discount": 0, "addon": rule.get("addon"),
                    "why": f"{f['count']} treats — the {rule['addon']['name'].lower()} rides along free."}
        return {"eligible": False, "progress": round(f["count"] / need * 100),
                "why": f"Add {_plural(need - f['count'], 'more')} for the party box."}

    if kind == "fixed-per-item" and rule.get("requires") == "seasonal":
        if not f["live_season_name"]:
            return {"eligible": False, "why": "No seasonal menu is live right now."}
        if f["seasonal_units"] == 0:
            return {"eligible": False, "why": f"Add something from {f['live_season_name']} to use it."}
        units = min(f["seasonal_units"], rule.get("maxUnits", f["seasonal_units"]))
        return {"eligible": True, "discount": round(rule["amount"] * units, 2),
                "why": f"{_plural(units, 'seasonal treat')} in the box at {_money(rule['amount'])} off each."}

    if kind == "free-delivery":
        need = rule.get("minSubtotal", 45)
        if f["subtotal"] >= need:
            return {"eligible": True, "discount": 0, "progress": 100,
                    "why": "Applied on its own when you choose delivery at checkout."}
        return {"eligible": False, "progress": round(f["subtotal"] / need * 100),
                "why": f"{_money(need - f['subtotal'])} more and delivery is free. Applies on its own at checkout."}

    return {"eligible": False, "why": "Not available."}


def evaluate_offers(offers, lines, customer=None, live_seasons=()):
    """Every offer with eligibility, value and reason. Eligible first."""
    f = _facts(lines, customer, list(live_seasons))
    out = []
    for offer in offers:
        result = _evaluate(offer, f)
        out.append({
            **offer,
            "eligible": result["eligible"],
            "discount": result.get("discount", 0),
            "addon": result.get("addon"),
            "why": result["why"],
            "progress": result.get("progress", 100 if result["eligible"] else None),
        })
    out.sort(key=lambda o: (not o["eligible"], -o["discount"]))
    return out


def price(offers, lines, applied_id=None, fulfillment="pickup", customer=None, live_seasons=()):
    """The receipt: subtotal, the applied discount if it still holds, delivery, total."""
    evaluated = evaluate_offers(offers, lines, customer, live_seasons)
    f = _facts(lines, customer, list(live_seasons))
    applied = next((o for o in evaluated
                    if o["id"] == applied_id and o["eligible"] and not o.get("auto")), None)
    delivery = next((o for o in offers if (o.get("rule") or {}).get("type") == "free-delivery"), None)
    fee = (delivery or {}).get("rule", {}).get("fee", 6.95)
    threshold = (delivery or {}).get("rule", {}).get("minSubtotal", 45)
    delivery_free = f["subtotal"] >= threshold
    delivery_fee = fee if fulfillment == "delivery" and not delivery_free else 0
    discount = applied["discount"] if applied else 0
    return {
        "subtotal": round(f["subtotal"], 2),
        "applied": applied,
        "discount": round(discount, 2),
        "addon": applied.get("addon") if applied else None,
        "fulfillment": fulfillment,
        "deliveryFee": round(delivery_fee, 2),
        "deliveryFree": fulfillment == "delivery" and delivery_free,
        "total": round(max(0, f["subtotal"] - discount + delivery_fee), 2),
    }
