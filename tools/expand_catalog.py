"""Expands the catalog and gives every item the data the agents reason with.

Three things happen to backend/storefront.json:

1. Every item gets a `profile`: flavor family, richness and brightness on a
   0-4 scale, texture, the occasions it suits, and explicit pairings with a
   reason a person would accept. The recommendation engine reads these, so a
   new item is recommendable the moment it has a profile rather than needing a
   hand-written entry in the engine.
2. The menu grows from 22 items to 44: eight more weekly flavors, six more
   plant-based, and two more per seasonal menu. Each new item carries the same
   fields as the originals (nutrition, allergens, reviews) so the detail page
   is as complete for them as for the first eight.
3. Seasonal items get a `releaseDate` inside their menu's window, so the
   calendar has something to show per item rather than one date per season.
   Offers get a `rule` block that both the browser and the server evaluate.

Idempotent: re-running updates profiles and rules in place and only adds
items that are missing. Run: python tools/expand_catalog.py
"""

import json
import pathlib
from datetime import date

STOREFRONT = pathlib.Path(__file__).resolve().parent.parent / "backend/storefront.json"

# ── Nutrition helper (same shape add_item_detail.py writes) ──────────────

# Daily values the panel divides by, per the FDA 2,000-calorie basis.
DV = {"fat": 78, "sat": 20, "carbs": 275, "fiber": 28, "protein": 50, "sodium": 2300}


def nutrition(grams, kcal, fat, sat, carbs, sugar, protein, sodium, fiber):
    pct = lambda value, key: round(value / DV[key] * 100)
    return {
        "servingGrams": grams,
        "calories": kcal,
        "perServing": [
            {"label": "Total fat", "value": f"{fat}g", "dv": pct(fat, "fat")},
            {"label": "Saturated fat", "value": f"{sat}g", "dv": pct(sat, "sat")},
            {"label": "Total carbohydrate", "value": f"{carbs}g", "dv": pct(carbs, "carbs")},
            {"label": "Total sugars", "value": f"{sugar}g", "dv": None},
            {"label": "Dietary fiber", "value": f"{fiber}g", "dv": pct(fiber, "fiber")},
            {"label": "Protein", "value": f"{protein}g", "dv": pct(protein, "protein")},
            {"label": "Sodium", "value": f"{sodium}mg", "dv": pct(sodium, "sodium")},
        ],
    }


def review(item_id, n, name, initials, stars, when, body, verified="Verified purchase"):
    return {"id": f"{item_id}-r{n}", "name": name, "initials": initials, "stars": stars,
            "date": when, "verified": verified, "body": body}


# ── Profiles for every item, existing and new ─────────────────────────────
#
# family: the dominant flavor. rich/bright: 0-4. texture: one word the engine
# contrasts on. occasions: ids from storefront `occasions`. pairs: (id, why).

PROFILES = {
    # weekly
    "pink-velvet":      ("cream",   2, 1, "soft",  ["birthday", "kids", "thank-you"],
                         [("brown-butter", "cream cheese against browned butter"), ("lemon-cloud", "keeps a sweet box from cloying")]),
    "brown-butter":     ("cocoa",   3, 0, "chewy", ["just-because", "office", "thank-you", "kids"],
                         [("midnight-fudge", "the classic cocoa pairing"), ("lemon-cloud", "keeps a butter-forward box from flattening")]),
    "lemon-cloud":      ("citrus",  0, 3, "light", ["just-because", "dinner-party", "office"],
                         [("strawberry-stack", "two bright flavors, different textures"), ("pink-velvet", "adds body under the citrus")]),
    "biscoff":          ("caramel", 3, 0, "dense", ["thank-you", "office"],
                         [("coconut-matcha", "green tea cuts the caramel"), ("brown-butter", "caramel and browned butter run together")]),
    "strawberry-stack": ("berry",   1, 3, "light", ["birthday", "kids", "dinner-party"],
                         [("pink-velvet", "the crowd-pleasing pink pair"), ("midnight-fudge", "berry and dark cocoa")]),
    "midnight-fudge":   ("cocoa",   4, 0, "dense", ["dinner-party", "kids"],
                         [("lemon-cloud", "cuts the fudge with something sharp"), ("strawberry-stack", "berry lifts a heavy cocoa box")]),
    "salted-honey":     ("caramel", 2, 1, "soft",  ["thank-you", "dinner-party"],
                         [("lemon-cloud", "honey and lemon, the obvious pair"), ("brown-butter", "two toasty flavors with salt in common")]),
    "raspberry-oat":    ("berry",   1, 2, "crisp", ["just-because", "office", "kids"],
                         [("midnight-fudge", "tart raspberry against dark cocoa"), ("salted-honey", "oat crumble and honey belong together")]),
    "carrot-crown":     ("spice",   2, 1, "soft",  ["thank-you", "office", "dinner-party"],
                         [("lemon-cloud", "citrus after the spice"), ("coconut-matcha", "green tea cools warm spice")]),
    "tiramisu-cup":     ("coffee",  3, 0, "soft",  ["dinner-party", "thank-you"],
                         [("lemon-cloud", "a clean finish after espresso"), ("biscoff", "coffee and speculoos, the café pair")]),
    "key-lime-tart":    ("citrus",  1, 4, "crisp", ["dinner-party", "just-because", "office"],
                         [("midnight-fudge", "sharp lime against dark cocoa"), ("coconut-matcha", "lime and coconut")]),
    "banana-pudding":   ("cream",   2, 1, "soft",  ["kids", "office", "just-because"],
                         [("brown-butter", "wafers and browned butter cookies"), ("raspberry-oat", "adds a tart edge to the cream")]),
    "pistachio-croissant": ("nut",  3, 0, "flaky", ["thank-you", "dinner-party"],
                         [("lemon-cloud", "citrus lifts the pistachio"), ("strawberry-stack", "pistachio and strawberry")]),
    "cinnamon-roll":    ("spice",   3, 0, "soft",  ["office", "kids", "just-because"],
                         [("lemon-cloud", "something bright after the swirl"), ("raspberry-oat", "fruit cuts the brown sugar")]),
    "salted-caramel-brownie": ("cocoa", 4, 0, "dense", ["dinner-party", "kids", "thank-you"],
                         [("key-lime-tart", "lime cuts a dense brownie"), ("strawberry-stack", "berry lifts the cocoa")]),
    "vanilla-macaron":  ("cream",   2, 1, "crisp", ["thank-you", "birthday", "dinner-party"],
                         [("tiramisu-cup", "vanilla next to espresso"), ("raspberry-oat", "adds fruit to a vanilla box")]),
    # plant-based
    "coconut-matcha":   ("green",   1, 2, "light", ["office", "just-because"],
                         [("almond-fig", "both plant-based, different textures"), ("lemon-cloud", "clean and bright together")]),
    "almond-fig":       ("nut",     2, 2, "soft",  ["dinner-party", "thank-you"],
                         [("coconut-matcha", "rounds out the plant-based half"), ("biscoff", "fig and caramel")]),
    "oat-choc-chip":    ("cocoa",   3, 0, "chewy", ["office", "kids", "just-because"],
                         [("lemon-poppy-loaf", "citrus against the chocolate, both plant-based"), ("mango-coconut", "tropical fruit lifts the cocoa")]),
    "mango-coconut":    ("tropical", 1, 3, "soft", ["dinner-party", "just-because"],
                         [("oat-choc-chip", "cocoa under bright mango"), ("coconut-matcha", "two coconut bases, one grassy, one fruity")]),
    "avocado-mousse":   ("cocoa",   4, 0, "soft",  ["dinner-party", "thank-you"],
                         [("mango-coconut", "mango cuts a dense mousse"), ("lemon-poppy-loaf", "lemon against dark chocolate")]),
    "lemon-poppy-loaf": ("citrus",  1, 3, "soft",  ["office", "just-because"],
                         [("oat-choc-chip", "lemon and chocolate, both plant-based"), ("avocado-mousse", "adds richness to a light loaf")]),
    "pb-blondie":       ("nut",     3, 0, "dense", ["kids", "office"],
                         [("mango-coconut", "fruit lightens peanut butter"), ("lemon-poppy-loaf", "bright citrus after the blondie")]),
    "apple-hand-pie":   ("orchard", 1, 2, "flaky", ["kids", "office", "thank-you"],
                         [("oat-choc-chip", "apple pie and a chocolate chip cookie"), ("coconut-matcha", "matcha next to cinnamon apple")]),
    # harvest
    "maple-pecan":      ("nut",     3, 0, "soft",  ["thank-you", "dinner-party"],
                         [("spiced-pear", "pecan and pear, the harvest pair"), ("lemon-cloud", "citrus keeps maple from cloying")]),
    "spiced-pear":      ("orchard", 1, 2, "flaky", ["dinner-party", "thank-you"],
                         [("maple-pecan", "pear and maple pecan"), ("salted-honey", "honey and orchard fruit")]),
    "cider-donut":      ("spice",   2, 1, "soft",  ["kids", "office", "just-because"],
                         [("maple-pecan", "cider donut with maple"), ("brown-butter", "two warm, toasty flavors")]),
    "pumpkin-cheesecake": ("spice", 3, 0, "soft",  ["dinner-party", "thank-you", "office"],
                         [("lemon-cloud", "citrus after pumpkin spice"), ("cider-donut", "the full autumn table")]),
    "caramel-apple-tart": ("orchard", 2, 2, "flaky", ["kids", "dinner-party"],
                         [("maple-pecan", "apple and pecan"), ("brown-butter", "caramel apple next to browned butter")]),
    # holiday
    "peppermint-bark":  ("mint",    2, 1, "crisp", ["office", "thank-you", "kids"],
                         [("midnight-fudge", "mint and dark cocoa"), ("yule-log", "peppermint on the chocolate log")]),
    "yule-log":         ("cocoa",   4, 0, "soft",  ["dinner-party", "birthday"],
                         [("peppermint-bark", "the holiday chocolate pair"), ("lemon-cloud", "something sharp after the log")]),
    "gingerbread":      ("spice",   2, 1, "soft",  ["office", "thank-you"],
                         [("lemon-cloud", "lemon and ginger"), ("yule-log", "spice next to chocolate")]),
    "eggnog-puff":      ("cream",   3, 0, "soft",  ["dinner-party", "office"],
                         [("gingerbread", "nutmeg custard with gingerbread"), ("peppermint-bark", "cream puff and peppermint")]),
    "cranberry-scone":  ("citrus",  1, 3, "crisp", ["office", "just-because", "thank-you"],
                         [("yule-log", "tart cranberry against chocolate"), ("gingerbread", "orange zest with ginger")]),
    # lunar
    "mooncake":         ("bean",    2, 1, "dense", ["thank-you", "dinner-party"],
                         [("sesame-ball", "lotus and sesame"), ("mandarin-cloud", "citrus lightens the lotus paste")]),
    "sesame-ball":      ("sesame",  1, 1, "chewy", ["kids", "just-because"],
                         [("mooncake", "sesame and lotus"), ("coconut-matcha", "sesame and matcha")]),
    "almond-cookie":    ("nut",     2, 0, "crisp", ["office", "thank-you"],
                         [("mandarin-cloud", "almond and mandarin"), ("sesame-ball", "two Lunar New Year classics")]),
    "red-bean-bun":     ("bean",    1, 1, "soft",  ["kids", "just-because"],
                         [("sesame-ball", "red bean and sesame"), ("mandarin-cloud", "citrus against the bean")]),
    "mandarin-cloud":   ("citrus",  0, 3, "light", ["dinner-party", "thank-you"],
                         [("mooncake", "lightens a dense mooncake"), ("almond-cookie", "mandarin and almond")]),
    # graduation
    "confetti-cake":    ("cream",   2, 1, "soft",  ["birthday", "kids"],
                         [("strawberry-stack", "two celebration cakes"), ("lemon-bar", "lemon cuts the buttercream")]),
    "grad-cap":         ("cocoa",   2, 0, "crisp", ["birthday", "kids", "office"],
                         [("confetti-cake", "cookie and cake for the table"), ("lemon-bar", "chocolate and lemon")]),
    "lemon-bar":        ("citrus",  1, 3, "dense", ["office", "just-because"],
                         [("confetti-cake", "sharp lemon after sweet cake"), ("grad-cap", "lemon bar and a chocolate cookie")]),
    "celebration-pops": ("cream",   2, 1, "dense", ["birthday", "kids", "office"],
                         [("lemon-bar", "citrus after the candy shell"), ("grad-cap", "pops and cookies for a crowd")]),
    "sparkle-cupcake":  ("cream",   3, 0, "soft",  ["birthday", "kids"],
                         [("lemon-bar", "lemon against buttercream"), ("confetti-cake", "the full celebration spread")]),
}


def profile_for(item_id):
    family, rich, bright, texture, occasions, pairs = PROFILES[item_id]
    return {
        "family": family, "rich": rich, "bright": bright, "texture": texture,
        "occasions": occasions,
        "pairsWith": [{"id": pid, "why": why} for pid, why in pairs],
    }


# ── New items ─────────────────────────────────────────────────────────────

def item(id, name, blurb, price, emoji, tint, badge, tags, rating, allergens, nutr,
         dietary=(), reviews=(), season=None):
    data = {
        "id": id, "name": name, "blurb": blurb, "price": price, "emoji": emoji,
        "tint": tint, "badge": badge, "tags": list(tags), "rating": rating,
        "allergens": list(allergens), "image": f"assets/desserts/{id}.jpg",
        "nutrition": nutrition(*nutr), "dietary": list(dietary), "reviews": list(reviews),
    }
    if season:
        data["season"] = season
    return data


PLANT = ["Plant-based", "No dairy", "No egg"]

NEW_WEEKLY = [
    item("carrot-crown", "Carrot Cake Crown", "Cream cheese swirl · toasted walnut", 5.75, "🥕", "gold", "New",
         ["new", "rich"], 4.6, ["wheat", "dairy", "egg", "tree nut"], (98, 405, 21, 8, 50, 34, 5, 280, 2),
         reviews=[review("carrot-crown", 1, "Hana W.", "HW", 5, "2026-09-16",
                         "Proper carrot cake, not a muffin pretending. The walnut on top is toasted, which is the detail most places skip."),
                  review("carrot-crown", 2, "Ben O.", "BO", 4, "2026-09-09",
                         "Moist, well spiced, generous on the frosting. I'd take it slightly less sweet.")]),
    item("tiramisu-cup", "Tiramisu Cup", "Espresso-soaked sponge · mascarpone", 6.25, "☕", "cocoa", "Fan favorite",
         ["rich", "signature"], 4.8, ["wheat", "dairy", "egg"], (105, 420, 24, 14, 42, 28, 7, 160, 1),
         reviews=[review("tiramisu-cup", 1, "Lucia F.", "LF", 5, "2026-09-18",
                         "Real espresso, real mascarpone. Served cold and it holds its layers all the way down the cup."),
                  review("tiramisu-cup", 2, "Omar H.", "OH", 5, "2026-09-05",
                         "Ordered two for a dinner and ended up hiding one for myself. No regrets.")]),
    item("key-lime-tart", "Key Lime Tart", "Lime curd · graham crust", 5.75, "🍋", "mint", "New",
         ["new", "fruity"], 4.7, ["wheat", "dairy", "egg"], (96, 345, 15, 9, 48, 33, 5, 210, 1),
         reviews=[review("key-lime-tart", 1, "Renee C.", "RC", 5, "2026-09-14",
                         "Sharp enough to make you blink, which is how key lime should be. Crust stays crisp."),
                  review("key-lime-tart", 2, "Theo K.", "TK", 4, "2026-09-07",
                         "Bright and clean. Would love a little more whipped cream on top.")]),
    item("banana-pudding", "Banana Pudding Jar", "Vanilla wafers · whipped cream", 5.5, "🍌", "butter", "Comfort",
         ["shareable"], 4.5, ["wheat", "dairy", "egg"], (120, 380, 14, 8, 58, 40, 5, 230, 2),
         reviews=[review("banana-pudding", 1, "Grace L.", "GL", 5, "2026-09-12",
                         "Tastes like the one my grandmother made, wafers gone soft in the right way."),
                  review("banana-pudding", 2, "Dev P.", "DP", 4, "2026-09-03",
                         "Big portion, very comforting. Best eaten the same day.")]),
    item("pistachio-croissant", "Pistachio Cream Croissant", "Laminated butter · pistachio cream", 6.5, "🥐", "mint", "Signature",
         ["signature", "rich"], 4.8, ["wheat", "dairy", "egg", "tree nut"], (110, 465, 28, 15, 44, 20, 8, 320, 2),
         reviews=[review("pistachio-croissant", 1, "Mina S.", "MS", 5, "2026-09-17",
                         "Shatters when you bite it and the pistachio cream is the real green kind, not dyed."),
                  review("pistachio-croissant", 2, "Carlos R.", "CR", 5, "2026-09-08",
                         "The best thing on the menu, full stop. Get here before eleven or it's gone.")]),
    item("cinnamon-roll", "Cinnamon Swirl Roll", "Brown sugar swirl · vanilla glaze", 5.25, "🌀", "caramel", "Warm",
         ["shareable", "rich"], 4.6, ["wheat", "dairy", "egg"], (115, 440, 17, 9, 66, 36, 7, 340, 2),
         reviews=[review("cinnamon-roll", 1, "Jamal T.", "JT", 5, "2026-09-15",
                         "Soft all the way to the center, glaze still a little warm when I picked it up."),
                  review("cinnamon-roll", 2, "Elise N.", "EN", 4, "2026-09-06",
                         "Great roll. Sweet, so pair it with something sharp.")]),
    item("salted-caramel-brownie", "Salted Caramel Brownie", "Fudge brownie · flaky salt", 5.5, "🍫", "cocoa", "Fan favorite",
         ["rich", "shareable"], 4.8, ["wheat", "dairy", "egg", "soy"], (92, 445, 23, 13, 56, 42, 5, 290, 3),
         reviews=[review("salted-caramel-brownie", 1, "Kai M.", "KM", 5, "2026-09-19",
                         "Fudgy, not cakey. The caramel is ribboned through rather than a puddle on top."),
                  review("salted-caramel-brownie", 2, "Sofia A.", "SA", 5, "2026-09-10",
                         "Took a box to the office and had to send a photo of the empty tray by noon.")]),
    item("vanilla-macaron", "Vanilla Bean Macarons", "Almond shells · vanilla bean ganache · set of 3", 6.0, "🍬", "pink", "Signature",
         ["signature", "shareable"], 4.7, ["egg", "dairy", "tree nut"], (54, 250, 11, 6, 34, 30, 4, 60, 1),
         reviews=[review("vanilla-macaron", 1, "Noor B.", "NB", 5, "2026-09-13",
                         "Feet on the shells, chewy inside, and you can see the vanilla seeds in the ganache."),
                  review("vanilla-macaron", 2, "Wes D.", "WD", 4, "2026-09-04",
                         "Delicate and pretty. Three is a tease, I wanted six.")]),
]

NEW_PLANT = [
    item("oat-choc-chip", "Oat Milk Chocolate Chip", "Dark chips · oat milk dough", 4.95, "🍪", "cocoa", "Plant-based",
         ["vegan", "shareable"], 4.6, ["wheat", "soy"], (70, 320, 14, 6, 46, 24, 3, 210, 2), dietary=PLANT,
         reviews=[review("oat-choc-chip", 1, "Priya V.", "PV", 5, "2026-09-16",
                         "Crisp edge, soft middle, and nobody at the table guessed it was plant-based."),
                  review("oat-choc-chip", 2, "Milo J.", "MJ", 4, "2026-09-08",
                         "Good cookie. A little more salt would push it to five.")]),
    item("mango-coconut", "Mango Coconut Panna Cotta", "Coconut cream · mango coulis", 5.75, "🥭", "gold", "Plant-based",
         ["vegan", "fruity", "new"], 4.7, ["tree nut"], (110, 280, 13, 11, 40, 32, 2, 40, 2),
         dietary=["Plant-based", "No dairy", "No gluten"],
         reviews=[review("mango-coconut", 1, "Anika R.", "AR", 5, "2026-09-17",
                         "Silky and light. The mango on top is actual fruit, not syrup."),
                  review("mango-coconut", 2, "Leo G.", "LG", 4, "2026-09-09",
                         "Refreshing after a heavy meal. Wish the cup were bigger.")]),
    item("avocado-mousse", "Dark Chocolate Avocado Mousse", "70% cocoa · whipped avocado", 5.95, "🥑", "cocoa", "Plant-based",
         ["vegan", "rich"], 4.5, ["soy"], (100, 330, 22, 8, 34, 22, 4, 60, 6),
         dietary=["Plant-based", "No dairy", "No gluten"],
         reviews=[review("avocado-mousse", 1, "Tess H.", "TH", 5, "2026-09-14",
                         "Deep, dark and dense. You cannot taste the avocado, only the texture it gives."),
                  review("avocado-mousse", 2, "Rafael M.", "RM", 4, "2026-09-05",
                         "Very rich, one is plenty. Great for someone avoiding dairy.")]),
    item("lemon-poppy-loaf", "Lemon Poppyseed Loaf", "Olive oil crumb · lemon glaze", 5.25, "🍋", "butter", "Plant-based",
         ["vegan", "fruity"], 4.6, ["wheat"], (95, 340, 14, 2, 50, 30, 4, 220, 2), dietary=PLANT,
         reviews=[review("lemon-poppy-loaf", 1, "Ivy C.", "IC", 5, "2026-09-15",
                         "Tender crumb from the olive oil and a glaze with real lemon bite."),
                  review("lemon-poppy-loaf", 2, "Sam O.", "SO", 4, "2026-09-06",
                         "Solid morning slice. Goes with coffee better than most things here.")]),
    item("pb-blondie", "Peanut Butter Blondie", "Roasted peanut butter · brown sugar", 5.25, "🥜", "caramel", "Plant-based",
         ["vegan", "rich", "shareable"], 4.6, ["wheat", "peanut", "soy"], (88, 400, 20, 5, 48, 30, 8, 260, 2), dietary=PLANT,
         reviews=[review("pb-blondie", 1, "Dana K.", "DK", 5, "2026-09-18",
                         "Chewy, salty-sweet, and the peanut flavor is roasted rather than raw."),
                  review("pb-blondie", 2, "Aaron F.", "AF", 4, "2026-09-10",
                         "My kids demolished these. Dense, so one goes a long way.")]),
    item("apple-hand-pie", "Cinnamon Apple Hand Pie", "Flaky crust · cinnamon apples", 5.5, "🥧", "caramel", "Plant-based",
         ["vegan", "shareable"], 4.7, ["wheat"], (105, 360, 17, 6, 50, 22, 3, 240, 2), dietary=PLANT,
         reviews=[review("apple-hand-pie", 1, "Ruth E.", "RE", 5, "2026-09-16",
                         "Crust flakes like it was made with butter. Apples still have some bite."),
                  review("apple-hand-pie", 2, "Nate S.", "NS", 5, "2026-09-07",
                         "Perfect car snack, no fork required. Ordered again the next week.")]),
]

# Two more per seasonal menu, keyed by menu id. Reviews for unreleased items
# are from last season, which is what a returning item would actually have.
NEW_SEASONAL = {
    "harvest": [
        item("pumpkin-cheesecake", "Pumpkin Spice Cheesecake Bar", "Spiced pumpkin · gingersnap crust", 6.25, "🎃", "caramel", "Seasonal",
             ["rich", "shareable"], 4.7, ["wheat", "dairy", "egg"], (105, 410, 24, 14, 42, 30, 6, 300, 1), season="harvest",
             reviews=[review("pumpkin-cheesecake", 1, "Molly B.", "MB", 5, "2025-10-12",
                             "The gingersnap crust is the trick. Not too sweet, properly spiced."),
                      review("pumpkin-cheesecake", 2, "Chris D.", "CD", 4, "2025-10-05",
                             "Creamy and autumnal. I'd like it back every year.")]),
        item("caramel-apple-tart", "Caramel Apple Tartlet", "Sliced apple · salted caramel drizzle", 6.0, "🍎", "gold", "Seasonal",
             ["fruity", "shareable"], 4.6, ["wheat", "dairy", "egg"], (100, 370, 16, 8, 54, 34, 4, 220, 3), season="harvest",
             reviews=[review("caramel-apple-tart", 1, "Farah N.", "FN", 5, "2025-10-19",
                             "Thin apple slices fanned out like a bakery window. The caramel has salt, thank goodness."),
                      review("caramel-apple-tart", 2, "Owen P.", "OP", 4, "2025-10-11",
                             "Good tart. Apples could be a touch softer.")]),
    ],
    "holiday": [
        item("eggnog-puff", "Eggnog Cream Puff", "Choux · nutmeg custard", 5.75, "🥛", "butter", "Seasonal",
             ["signature"], 4.6, ["wheat", "dairy", "egg"], (90, 350, 22, 13, 32, 20, 6, 180, 0), season="holiday",
             reviews=[review("eggnog-puff", 1, "Holly R.", "HR", 5, "2025-12-14",
                             "Nutmeg custard piped generously, choux still crisp. Tastes like the season."),
                      review("eggnog-puff", 2, "Sanjay M.", "SM", 4, "2025-12-06",
                             "Lovely, if you like eggnog. I do.")]),
        item("cranberry-scone", "Cranberry Orange Scone", "Dried cranberry · orange zest glaze", 5.25, "🍊", "berry", "Seasonal",
             ["fruity", "shareable"], 4.5, ["wheat", "dairy", "egg"], (98, 380, 16, 9, 54, 26, 6, 330, 2), season="holiday",
             reviews=[review("cranberry-scone", 1, "Beth A.", "BA", 5, "2025-12-11",
                             "Crumbly in the right way and the orange glaze keeps it from being dry."),
                      review("cranberry-scone", 2, "Victor L.", "VL", 4, "2025-12-02",
                             "A morning scone that works at dessert too. Tart cranberries.")]),
    ],
    "lunar": [
        item("red-bean-bun", "Red Bean Pillow Bun", "Steamed milk bun · sweet red bean", 5.25, "🥟", "pink", "Seasonal",
             ["shareable"], 4.6, ["wheat", "dairy"], (85, 260, 6, 3, 46, 16, 6, 120, 3), season="lunar",
             reviews=[review("red-bean-bun", 1, "Wei Z.", "WZ", 5, "2026-02-10",
                             "Pillowy, warm, red bean not too sweet. My grandmother approved, which is rare."),
                      review("red-bean-bun", 2, "Amy T.", "AT", 4, "2026-02-03",
                             "Soft and comforting. Best warm.")]),
        item("mandarin-cloud", "Mandarin Cloud Cake", "Chiffon · mandarin curd", 6.25, "🍊", "gold", "Seasonal",
             ["fruity", "signature"], 4.7, ["wheat", "egg"], (100, 320, 12, 4, 48, 30, 5, 170, 1), season="lunar",
             reviews=[review("mandarin-cloud", 1, "Jin K.", "JK", 5, "2026-02-14",
                             "Light as the name says. The mandarin curd is fragrant rather than sour."),
                      review("mandarin-cloud", 2, "Elena V.", "EV", 5, "2026-02-07",
                             "Beautiful, and no dairy so my sister could have it too.")]),
    ],
    "graduation": [
        item("celebration-pops", "Celebration Cake Pops", "Vanilla cake · candy shell · set of 3", 5.5, "🍭", "pink", "Seasonal",
             ["shareable"], 4.5, ["wheat", "dairy", "egg", "soy"], (60, 270, 12, 7, 38, 28, 3, 150, 0), season="graduation",
             reviews=[review("celebration-pops", 1, "Tara S.", "TS", 5, "2026-05-24",
                             "School colors on request and they held up in a warm car. Kids went feral."),
                      review("celebration-pops", 2, "Miguel A.", "MA", 4, "2026-05-16",
                             "Cute and easy to hand out. Sweet, as expected.")]),
        item("sparkle-cupcake", "Vanilla Sparkle Cupcake", "Vanilla bean · shimmer buttercream", 5.75, "🧁", "butter", "Seasonal",
             ["signature", "shareable"], 4.7, ["wheat", "dairy", "egg"], (98, 400, 19, 12, 54, 40, 4, 240, 1), season="graduation",
             reviews=[review("sparkle-cupcake", 1, "Zoe W.", "ZW", 5, "2026-05-30",
                             "The shimmer is edible glitter, not sugar crystals, so it photographs like a dream."),
                      review("sparkle-cupcake", 2, "Paul H.", "PH", 4, "2026-05-21",
                             "Very good vanilla cupcake dressed up for the occasion.")]),
    ],
}

# Missing nutrition on the two newest weekly items.
BACKFILL_NUTRITION = {
    "salted-honey":  (96, 370, 16, 9, 52, 36, 5, 260, 1),
    "raspberry-oat": (90, 335, 13, 6, 50, 24, 4, 190, 3),
}

# Release dates stagger each menu's items across its window, so the calendar
# has something to show per item rather than one date per season.
RELEASE = {
    "harvest":    {"maple-pecan": "2026-09-20", "spiced-pear": "2026-09-20", "cider-donut": "2026-09-27",
                   "pumpkin-cheesecake": "2026-10-04", "caramel-apple-tart": "2026-10-11"},
    "holiday":    {"peppermint-bark": "2026-11-15", "gingerbread": "2026-11-15", "yule-log": "2026-11-22",
                   "eggnog-puff": "2026-11-29", "cranberry-scone": "2026-12-06"},
    "lunar":      {"mooncake": "2027-01-25", "sesame-ball": "2027-01-25", "almond-cookie": "2027-02-01",
                   "red-bean-bun": "2027-02-01", "mandarin-cloud": "2027-02-08"},
    "graduation": {"confetti-cake": "2027-04-20", "grad-cap": "2027-04-20", "lemon-bar": "2027-04-27",
                   "celebration-pops": "2027-05-04", "sparkle-cupcake": "2027-05-11"},
}

# ── Offers, each with the rule both the browser and the server evaluate ──
#
# Rule types: percent (tiers or flat), free-addon, fixed-per-item, free-delivery.
# `requires` names evidence the evaluator must find in the box or the account.

OFFERS = [
    {
        "id": "offer-bundle",
        "label": "Because a full box costs less",
        "title": "Complete the six-count, up to 15% off",
        "detail": "Fill all six slots and the box drops to the bundle price. Three or more flavors gets the full 15%.",
        "reason": "Six singles cost more than one box, so we would rather you fill it.",
        "value": "Save up to 15%",
        "tint": "pink", "emoji": "🎁",
        "rule": {"type": "percent", "tiers": [
            {"minItems": 6, "minFlavors": 3, "percent": 15},
            {"minItems": 6, "percent": 10},
        ]},
    },
    {
        "id": "offer-party",
        "label": "Because this is a big box",
        "title": "Party Box: free flavor flight",
        "detail": "Twelve or more treats and we add a six-piece flavor flight to the order, free.",
        "reason": "Past a dozen you are feeding a room, and the flight helps people choose.",
        "value": "Free flight ($9)",
        "tint": "berry", "emoji": "🎉",
        "rule": {"type": "free-addon", "minItems": 12, "addon": {"name": "Flavor flight", "value": 9}},
    },
    {
        "id": "offer-season",
        "label": "Because it's in season",
        "title": "$1.50 off every seasonal treat",
        "detail": "Any item from the live seasonal menu is $1.50 off while the menu runs.",
        "reason": "Seasonal items run for weeks, not months. The launch price gets them tried.",
        "value": "$1.50 off each",
        "tint": "caramel", "emoji": "🍂",
        "rule": {"type": "fixed-per-item", "amount": 1.5, "requires": "seasonal", "maxUnits": 6},
    },
    {
        "id": "offer-reorder",
        "label": "Because you reorder",
        "title": "Your usual, 15% off",
        "detail": "Four or more of a flavor you keep coming back for, and the whole box takes 15% off.",
        "reason": "Regulars get the regular's price.",
        "value": "Save 15%",
        "tint": "gold", "emoji": "🔁",
        "rule": {"type": "percent", "percent": 15, "requires": "favorite", "minFavoriteUnits": 4, "signedIn": True},
    },
    {
        "id": "offer-delivery",
        "label": "Because you're close",
        "title": "Free delivery over $45",
        "detail": "Choose delivery at checkout and a box over $45 ships free. Otherwise delivery is $6.95.",
        "reason": "Applied on its own at checkout. Nothing to enter.",
        "value": "Save $6.95",
        "tint": "mint", "emoji": "🚚",
        "auto": True,
        "rule": {"type": "free-delivery", "minSubtotal": 45, "fee": 6.95},
    },
]

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def short(iso):
    d = date.fromisoformat(iso)
    return f"{MONTHS[d.month - 1]} {d.day}"


def merge(existing, new_items):
    """Appends items whose id is not already present."""
    have = {i["id"] for i in existing}
    added = [i for i in new_items if i["id"] not in have]
    existing.extend(added)
    return len(added)


def main():
    data = json.loads(STOREFRONT.read_text(encoding="utf-8"))
    added = 0

    added += merge(data["weeklyMenu"], NEW_WEEKLY)
    added += merge(data["plantBased"], NEW_PLANT)
    for menu in data["eventMenus"]:
        menu.setdefault("items", [])
        added += merge(menu["items"], NEW_SEASONAL.get(menu["id"], []))
        for entry in menu["items"]:
            entry["releaseDate"] = RELEASE[menu["id"]].get(entry["id"], menu["opens"])
            entry["season"] = menu["id"]
            entry.setdefault("badge", "Seasonal")
        # Keep the human-readable window and the highlight list true to the data.
        menu["window"] = f"{short(menu['opens'])} – {short(menu['closes'])}"
        menu["highlights"] = [entry["name"] for entry in menu["items"][:3]]

    for item_id, nutr in BACKFILL_NUTRITION.items():
        for entry in data["weeklyMenu"]:
            if entry["id"] == item_id and not entry.get("nutrition"):
                entry["nutrition"] = nutrition(*nutr)

    every = [*data["weeklyMenu"], *data["plantBased"],
             *(entry for menu in data["eventMenus"] for entry in menu["items"])]
    missing = [entry["id"] for entry in every if entry["id"] not in PROFILES]
    if missing:
        raise SystemExit(f"No profile for: {missing}")
    TAG_ALIASES = {"fruit": "fruity", "plant-based": "vegan"}
    for entry in every:
        entry["profile"] = profile_for(entry["id"])
        entry["tags"] = list(dict.fromkeys(TAG_ALIASES.get(t, t) for t in entry.get("tags", [])))
        entry.setdefault("dietary", [])
        if "vegan" in entry["tags"] and not entry["dietary"]:
            entry["dietary"] = ["Plant-based", "No dairy", "No egg"]
        entry.setdefault("reviews", [])

    ids = {entry["id"] for entry in every}
    dangling = [(entry["id"], p["id"]) for entry in every
                for p in entry["profile"]["pairsWith"] if p["id"] not in ids]
    if dangling:
        raise SystemExit(f"Pairings point at unknown items: {dangling}")

    data["smartOffers"] = OFFERS

    STOREFRONT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Added {added} items; catalog now has {len(every)} "
          f"({len(data['weeklyMenu'])} weekly, {len(data['plantBased'])} plant-based, "
          f"{sum(len(m['items']) for m in data['eventMenus'])} seasonal). "
          f"{len(OFFERS)} offers with rules.")


if __name__ == "__main__":
    main()
