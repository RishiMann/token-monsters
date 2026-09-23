"""Adds nutrition panels and per-item reviews to the catalog.

Nutrition is per single serving and consistent with each dessert's size and
richness. Reviews are written per item so the detail page reads like a real
product page rather than the same three quotes repeated.

Run: python tools/add_item_detail.py
"""

import json
import pathlib

STOREFRONT = pathlib.Path(__file__).resolve().parent.parent / "backend/storefront.json"

# id: (serving grams, calories, fat, saturated, carbs, sugar, protein, sodium, fiber)
NUTRITION = {
    "pink-velvet":      (92, 385, 18, 11, 52, 36, 4, 290, 1),
    "brown-butter":     (78, 340, 17, 10, 44, 27, 4, 250, 2),
    "lemon-cloud":      (88, 295, 11, 6, 46, 32, 3, 180, 1),
    "biscoff":          (96, 430, 21, 12, 57, 38, 5, 310, 2),
    "strawberry-stack": (110, 365, 16, 9, 51, 34, 5, 210, 2),
    "midnight-fudge":   (95, 455, 24, 14, 55, 40, 6, 270, 3),
    "coconut-matcha":   (84, 310, 15, 9, 40, 24, 4, 150, 3),
    "almond-fig":       (102, 395, 22, 7, 44, 26, 7, 190, 4),
    "maple-pecan":      (108, 440, 23, 9, 54, 37, 6, 240, 3),
    "spiced-pear":      (105, 350, 16, 8, 48, 28, 4, 200, 3),
    "cider-donut":      (86, 375, 19, 8, 47, 29, 4, 320, 1),
    "peppermint-bark":  (74, 330, 19, 12, 37, 33, 3, 95, 1),
    "yule-log":         (118, 470, 25, 15, 56, 41, 7, 230, 3),
    "gingerbread":      (100, 400, 17, 9, 58, 38, 5, 350, 2),
    "mooncake":         (90, 420, 14, 6, 68, 42, 6, 180, 2),
    "sesame-ball":      (70, 265, 10, 3, 41, 18, 4, 60, 2),
    "almond-cookie":    (62, 290, 16, 7, 33, 17, 4, 140, 2),
    "confetti-cake":    (112, 425, 19, 11, 60, 44, 5, 260, 1),
    "grad-cap":         (80, 360, 18, 10, 46, 30, 4, 220, 2),
    "lemon-bar":        (94, 340, 15, 8, 49, 35, 4, 160, 1),
}

DIETARY = {
    "coconut-matcha": ["Plant-based", "No dairy"],
    "almond-fig": ["Plant-based"],
    "sesame-ball": ["Plant-based", "No wheat"],
    "lemon-cloud": ["Vegetarian"],
}

# Three reviews per core flavor, written to the item rather than the brand.
REVIEWS = {
    "pink-velvet": [
        ("Jules M.", 5, "2026-09-14", "Verified purchase",
         "The frosting is cream cheese, not that sugary whipped stuff. Took these to my sister's garden party and they were gone before the drinks came out."),
        ("Priya N.", 5, "2026-09-02", "Verified purchase",
         "My go-to. The crumb is genuinely velvet — soft without being wet, which is where most red velvet falls apart."),
        ("Dan R.", 4, "2026-08-21", "Verified purchase",
         "Great flavor, though a touch sweeter than I'd like. Pairs well with the lemon one if you're building a box."),
    ],
    "brown-butter": [
        ("Marcus T.", 5, "2026-09-18", "Verified purchase",
         "You can actually taste the browned butter — nutty and a little savory underneath. Most chocolate chip cookies are just sugar with chips in."),
        ("Elena K.", 5, "2026-09-07", "Verified purchase",
         "Still soft on day two, which almost never happens. The sea salt on top does a lot of work."),
        ("Chris B.", 4, "2026-08-29", "Verified purchase",
         "Solid and reliable. I wish the chocolate pools were a bit bigger but no real complaints."),
    ],
    "lemon-cloud": [
        ("Amara O.", 5, "2026-09-16", "Verified purchase",
         "Sharp, not artificial. It tastes like actual lemons rather than lemon flavoring, and the glaze cracks properly when you bite it."),
        ("Tom W.", 5, "2026-09-05", "Verified purchase",
         "The one I order after a heavy meal. Light enough that it doesn't sit on you."),
        ("Sofia L.", 5, "2026-08-24", "Verified purchase",
         "Bought a box for the office and this was the first to go. Even the people who 'don't like sweet things' had one."),
    ],
    "biscoff": [
        ("Nina P.", 5, "2026-09-12", "Verified purchase",
         "Speculoos done properly — the caramel is burnt just enough to stop it being cloying. Dense in the good way."),
        ("Owen H.", 4, "2026-09-01", "Verified purchase",
         "Rich, so one is plenty. Very good with coffee, a bit much on its own."),
        ("Grace M.", 5, "2026-08-19", "Verified purchase",
         "My husband asks for this one specifically. The butterscotch actually tastes like butterscotch and not just brown sugar."),
    ],
    "strawberry-stack": [
        ("Jules M.", 5, "2026-09-16", "Verified celebration",
         "Ordered this for a birthday and it was the centerpiece. Real strawberries, and the cream isn't over-sweetened."),
        ("Ben A.", 5, "2026-09-09", "Verified purchase",
         "The shortcake layer holds up instead of going soggy, which is the whole problem with strawberry desserts."),
        ("Hana S.", 4, "2026-08-27", "Verified purchase",
         "Beautiful and it photographs well. Slightly messy to eat standing up at a party, so plan for plates."),
    ],
    "midnight-fudge": [
        ("Devon C.", 5, "2026-09-19", "Verified purchase",
         "Properly dark. The ganache center is still molten in the middle and it is not sweet, which is rare and welcome."),
        ("Rita J.", 5, "2026-09-08", "Verified purchase",
         "If you like dark chocolate this is the one. I pair it with the lemon to cut through."),
        ("Alex F.", 4, "2026-08-30", "Verified purchase",
         "Very rich — I split one. Cocoa nibs on top add a nice bitter crunch."),
    ],
    "coconut-matcha": [
        ("Yuki T.", 5, "2026-09-15", "Verified purchase",
         "Actual ceremonial-grade matcha flavor, grassy rather than sweet. Plant-based and you genuinely cannot tell."),
        ("Marco D.", 4, "2026-09-03", "Verified purchase",
         "Coconut is subtle, which I liked. If you want a strong coconut hit this isn't it, but the balance is good."),
        ("Leah B.", 5, "2026-08-22", "Verified purchase",
         "Dairy-free and it doesn't taste like a compromise. My daughter can't have dairy and she picks this every time."),
    ],
    "almond-fig": [
        ("Isabel R.", 5, "2026-09-13", "Verified purchase",
         "Fig and almond is an underrated pairing and this nails it. Barely sweet, more like something you'd get after dinner."),
        ("Paul G.", 5, "2026-09-04", "Verified purchase",
         "The frangipane is proper — dense, nutty, not the gluey kind. Worth the extra dollar."),
        ("Mira K.", 4, "2026-08-25", "Verified purchase",
         "Lovely but it does contain almonds, obviously, so not one for a mixed group with nut allergies."),
    ],
}

# Two reviews for each seasonal item, hooked to what the item actually is.
SEASONAL_REVIEWS = {
    "maple-pecan": [("Kara W.", 5, "Real maple, not syrup flavoring, and the pecans stay crisp."),
                    ("Joel M.", 4, "Sweet but the pecan bitterness balances it. Very autumn.")],
    "spiced-pear": [("Tess H.", 5, "The pastry shatters properly and the pear isn't mushy."),
                    ("Raj P.", 5, "Spicing is restrained — you can still taste the fruit.")],
    "cider-donut": [("Molly F.", 5, "Tastes like the ones from an orchard. The cinnamon sugar is generous."),
                    ("Evan S.", 4, "Best eaten same day. Still good the next morning but not the same.")],
    "peppermint-bark": [("Dana L.", 5, "Snaps cleanly and the peppermint is cooling rather than toothpasty."),
                        ("Nate K.", 4, "Very sweet. Good in small pieces with coffee.")],
    "yule-log": [("Clara V.", 5, "Showstopper for the table. The ganache is dark enough to offset the sponge."),
                 ("Sam O.", 5, "Ordered for twelve people and it sliced beautifully.")],
    "gingerbread": [("Hugo B.", 5, "Proper molasses depth and a real ginger burn at the end."),
                    ("Anita D.", 4, "Warming and not too sweet. I'd like a touch more spice.")],
    "mooncake": [("Wei L.", 5, "The lotus paste is smooth and not grainy, which is the giveaway for a good one."),
                 ("Fiona C.", 5, "Gave these as gifts and they were very well received.")],
    "sesame-ball": [("Jin H.", 5, "Chewy outside, warm sesame inside. Exactly right."),
                    ("Nora A.", 4, "Lovely texture. Best eaten fresh rather than saved.")],
    "almond-cookie": [("Ravi S.", 5, "Short, crumbly and toasty. Reminds me of the bakery ones growing up."),
                      ("Gina T.", 4, "Simple and good. Not flashy, just well made.")],
    "confetti-cake": [("Beth N.", 5, "The confetti doesn't bleed into the crumb, so it still looks sharp when sliced."),
                      ("Omar Y.", 5, "Ordered for a graduation and it did the job — fun without being childish.")],
    "grad-cap": [("Lucy P.", 5, "Adorable and the cocoa is actually dark, so adults ate them too."),
                 ("Theo R.", 4, "Cute. The gold dust does transfer onto fingers a bit.")],
    "lemon-bar": [("Ada M.", 5, "Proper curd, properly sharp. The shortbread base doesn't go soft."),
                  ("Kyle J.", 5, "My favorite of the spring menu. I order two.")],
}

INITIALS = lambda name: "".join(part[0] for part in name.split()[:2]).upper()


def nutrition_for(item_id):
    values = NUTRITION.get(item_id)
    if not values:
        return None
    grams, kcal, fat, sat, carbs, sugar, protein, sodium, fiber = values
    return {
        "servingGrams": grams,
        "calories": kcal,
        "perServing": [
            {"label": "Total fat", "value": f"{fat}g", "dv": round(fat / 78 * 100)},
            {"label": "Saturated fat", "value": f"{sat}g", "dv": round(sat / 20 * 100)},
            {"label": "Total carbohydrate", "value": f"{carbs}g", "dv": round(carbs / 275 * 100)},
            {"label": "Total sugars", "value": f"{sugar}g", "dv": None},
            {"label": "Dietary fiber", "value": f"{fiber}g", "dv": round(fiber / 28 * 100)},
            {"label": "Protein", "value": f"{protein}g", "dv": round(protein / 50 * 100)},
            {"label": "Sodium", "value": f"{sodium}mg", "dv": round(sodium / 2300 * 100)},
        ],
    }


def main():
    data = json.loads(STOREFRONT.read_text(encoding="utf-8"))

    def decorate(item, seasonal=False):
        item["nutrition"] = nutrition_for(item["id"])
        item["dietary"] = DIETARY.get(item["id"], [])
        if seasonal:
            item["reviews"] = [
                {"id": f"{item['id']}-r{index}", "name": name, "initials": INITIALS(name),
                 "stars": stars, "date": "2026-09-10", "verified": "Verified purchase",
                 "body": body}
                for index, (name, stars, body) in enumerate(SEASONAL_REVIEWS.get(item["id"], []), 1)
            ]
        else:
            item["reviews"] = [
                {"id": f"{item['id']}-r{index}", "name": name, "initials": INITIALS(name),
                 "stars": stars, "date": date, "verified": verified, "body": body}
                for index, (name, stars, date, verified, body)
                in enumerate(REVIEWS.get(item["id"], []), 1)
            ]
        if item["reviews"]:
            item["reviewCount"] = len(item["reviews"])
            item["rating"] = round(
                sum(review["stars"] for review in item["reviews"]) / len(item["reviews"]), 1)
        return item

    for key in ("weeklyMenu", "plantBased"):
        data[key] = [decorate(item) for item in data[key]]
    for menu in data.get("eventMenus", []):
        menu["items"] = [decorate(item, seasonal=True) for item in menu.get("items", [])]

    STOREFRONT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    total = sum(len(i["reviews"]) for k in ("weeklyMenu", "plantBased") for i in data[k])
    total += sum(len(i["reviews"]) for m in data["eventMenus"] for i in m["items"])
    print(f"nutrition on {len(NUTRITION)} items, {total} reviews written")


if __name__ == "__main__":
    main()
