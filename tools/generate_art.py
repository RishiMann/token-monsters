"""Generates the dessert illustrations in frontend/assets/desserts/.

Vector art rather than photography: it stays sharp at any size, weighs a few
kilobytes per item, needs no image licensing and no network at runtime. Each
dessert is composed from a shared set of forms (cookie, cupcake, slice, tart,
donut, mousse, macaron, loaf) with its own palette, so the menu reads as one
family instead of a pile of mismatched stock photos.

Run: python tools/generate_art.py
"""

import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "frontend/assets/desserts"

W, H = 400, 300


def svg(body, bg_from, bg_to, name):
    """Wraps art in the shared card: soft backdrop, glow and plate shadow."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-label="{name}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{bg_from}"/>
      <stop offset="1" stop-color="{bg_to}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="36%" r="54%">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".55"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="7"/>
    </filter>
  </defs>
  <rect width="{W}" height="{H}" fill="url(#bg)"/>
  <rect width="{W}" height="{H}" fill="url(#glow)"/>
  <ellipse cx="200" cy="245" rx="98" ry="15" fill="#3b1f2b" opacity=".15" filter="url(#soft)"/>
{body}
</svg>
"""


def _chips(layout, colors):
    return "\n".join(
        f'    <ellipse cx="{x}" cy="{y}" rx="{r}" ry="{round(r * 0.82, 1)}" '
        f'fill="{colors[i % len(colors)]}" transform="rotate({rot} {x} {y})"/>'
        for i, (x, y, r, rot) in enumerate(layout)
    )


def _sprinkles(layout, colors):
    return "\n".join(
        f'    <rect x="{x}" y="{y}" width="3.4" height="9" rx="1.7" '
        f'fill="{colors[i % len(colors)]}" transform="rotate({rot} {x} {y})"/>'
        for i, (x, y, rot) in enumerate(layout)
    )


# ── Forms ────────────────────────────────────────────────────────────────

def cupcake(frost, frost_dark, wrapper, wrapper_dark, cherry=None):
    topper = (
        f'  <circle cx="200" cy="70" r="10" fill="{cherry}"/>\n'
        f'  <path d="M200 60 q6 -12 16 -14" stroke="#7a9a4a" stroke-width="4" fill="none" stroke-linecap="round"/>'
        if cherry else ""
    )
    return f"""  <path d="M142 168 h116 l-13 62 a12 12 0 0 1 -12 10 h-66 a12 12 0 0 1 -12 -10 z" fill="{wrapper}"/>
  <path d="M142 168 h116 l-3 14 h-110 z" fill="{wrapper_dark}" opacity=".5"/>
  <g fill="{wrapper_dark}" opacity=".4">
    <rect x="160" y="174" width="5" height="60" rx="2.5"/>
    <rect x="186" y="174" width="5" height="64" rx="2.5"/>
    <rect x="212" y="174" width="5" height="64" rx="2.5"/>
    <rect x="238" y="174" width="5" height="60" rx="2.5"/>
  </g>
  <path d="M150 170 c-6 -26 10 -34 16 -46 c4 -9 0 -18 8 -25 c9 -8 22 -2 26 -10 c5 -10 20 -10 26 -1 c6 9 20 4 26 13 c6 9 2 18 8 26 c7 10 18 20 12 43 z"
        fill="{frost}"/>
  <path d="M150 170 c-3 -13 2 -22 8 -30 c6 12 18 16 30 12 c-2 12 8 22 22 20 c12 -2 18 -10 18 -20 c10 8 24 6 28 -6 c8 8 10 16 6 24 z"
        fill="{frost_dark}" opacity=".32"/>
  <ellipse cx="176" cy="122" rx="13" ry="8" fill="#ffffff" opacity=".32" transform="rotate(-22 176 122)"/>
{topper}"""


def cookie(dough, dough_dark, chip_layout, chip_colors):
    return f"""  <path d="M200 76 c44 0 84 28 84 72 c0 44 -38 76 -84 76 c-46 0 -84 -32 -84 -76 c0 -44 40 -72 84 -72 z"
        fill="{dough}"/>
  <path d="M200 92 c36 0 68 22 68 58 c0 34 -30 60 -68 60 c-38 0 -68 -26 -68 -60 c0 -36 32 -58 68 -58 z"
        fill="{dough_dark}" opacity=".2"/>
  <path d="M150 112 c14 -16 34 -24 52 -24" stroke="#ffffff" stroke-opacity=".32"
        stroke-width="7" stroke-linecap="round" fill="none"/>
  <g>
{_chips(chip_layout, chip_colors)}
  </g>
  <circle cx="124" cy="230" r="4" fill="{dough_dark}" opacity=".7"/>
  <circle cx="286" cy="223" r="3" fill="{dough_dark}" opacity=".6"/>
  <circle cx="274" cy="236" r="5" fill="{dough_dark}" opacity=".45"/>"""


def slice_cake(sponge, cream, fruit, fruit_dark, berries=True):
    """A slice lying on its side, point to the left, layers clipped to it."""
    top = ""
    if berries:
        top = f"""  <path d="M232 100 c10 -7 23 -2 25 9 c2 11 -7 20 -18 19 c-12 -1 -18 -14 -7 -28 z" fill="{fruit}"/>
  <path d="M240 104 c4 -3 10 -1 11 5" stroke="#ffffff" stroke-opacity=".55" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M206 112 c8 -6 18 -1 19 8 c1 9 -8 16 -15 15 c-9 -1 -13 -12 -4 -23 z" fill="{fruit_dark}"/>"""
    return f"""  <defs>
    <clipPath id="wedge">
      <path d="M132 216 L268 126 a6 6 0 0 1 10 5 v92 a8 8 0 0 1 -8 8 h-134 a6 6 0 0 1 -4 -15 z"/>
    </clipPath>
  </defs>
  <g clip-path="url(#wedge)">
    <rect x="120" y="120" width="170" height="120" fill="{sponge}"/>
    <rect x="120" y="150" width="170" height="14" fill="{cream}"/>
    <rect x="120" y="182" width="170" height="14" fill="{cream}"/>
    <rect x="120" y="214" width="170" height="12" fill="{cream}"/>
  </g>
  <path d="M132 216 L268 126 a6 6 0 0 1 10 5 v92 a8 8 0 0 1 -8 8 h-134 a6 6 0 0 1 -4 -15 z"
        fill="none" stroke="{fruit_dark}" stroke-opacity=".16" stroke-width="2"/>
  <path d="M132 216 L268 126 a6 6 0 0 1 10 5 l-12 8 c-40 26 -92 60 -134 88 z" fill="{cream}"/>
  <path d="M150 210 c34 -24 76 -50 110 -70" stroke="{fruit}" stroke-width="6"
        fill="none" stroke-linecap="round" opacity=".75"/>
  <path d="M278 131 v92 a8 8 0 0 1 -8 8 h-14 v-92 z" fill="#3b1f2b" opacity=".08"/>
{top}"""


def tart(shell, shell_dark, filling, fruit, fruit_dark):
    ridges = "\n".join(
        f'    <rect x="{round(118 + i * 16.4, 1)}" y="178" width="9" height="32" rx="4.5" '
        f'fill="{shell_dark}" opacity=".5"/>'
        for i in range(10)
    )
    return f"""  <path d="M108 180 v12 c0 20 42 34 92 34 s92 -14 92 -34 v-12 z" fill="{shell}"/>
  <g>
{ridges}
  </g>
  <ellipse cx="200" cy="180" rx="92" ry="34" fill="{shell}"/>
  <ellipse cx="200" cy="178" rx="78" ry="27" fill="{filling}"/>
  <ellipse cx="200" cy="175" rx="58" ry="18" fill="#ffffff" opacity=".18"/>
  <g>
    <ellipse cx="172" cy="172" rx="17" ry="14" fill="{fruit}"/>
    <ellipse cx="172" cy="172" rx="8" ry="6" fill="{fruit_dark}"/>
    <ellipse cx="212" cy="166" rx="15" ry="12" fill="{fruit}"/>
    <ellipse cx="212" cy="166" rx="7" ry="5" fill="{fruit_dark}"/>
    <ellipse cx="238" cy="180" rx="13" ry="11" fill="{fruit}"/>
    <ellipse cx="238" cy="180" rx="6" ry="5" fill="{fruit_dark}"/>
  </g>"""


def donut(dough, glaze, glaze_dark, sprinkle_colors):
    return f"""  <ellipse cx="200" cy="158" rx="92" ry="82" fill="{dough}"/>
  <path d="M108 158 c0 -46 41 -82 92 -82 s92 36 92 82 c0 12 -8 16 -14 8 c-14 -20 -42 -32 -78 -32 s-64 12 -78 32 c-6 8 -14 4 -14 -8 z" fill="{glaze}"/>
  <path d="M112 148 c12 -38 46 -60 88 -60 s76 22 88 60 c-10 -26 -44 -42 -88 -42 s-78 16 -88 42 z" fill="{glaze_dark}" opacity=".35"/>
  <ellipse cx="200" cy="160" rx="30" ry="26" fill="{dough}"/>
  <ellipse cx="200" cy="160" rx="24" ry="20" fill="#fffaf3"/>
  <ellipse cx="200" cy="160" rx="24" ry="20" fill="#3b1f2b" opacity=".1"/>
  <g>
{_sprinkles([(150, 112, 18), (178, 98, -24), (212, 96, 12), (244, 110, -38),
             (136, 140, 42), (262, 138, -12), (196, 116, 60), (228, 122, -52)], sprinkle_colors)}
  </g>"""


def mousse(body, body_dark, top, garnish):
    """A glazed dome with a mirror shine and a citrus wheel."""
    spokes = "\n".join(
        f'    <line x1="278" y1="104" x2="{x}" y2="{y}" stroke="{garnish}" stroke-width="2.4" opacity=".7"/>'
        for x, y in [(278, 88), (292, 96), (292, 112), (278, 120), (264, 112), (264, 96)]
    )
    return f"""  <ellipse cx="200" cy="228" rx="86" ry="18" fill="#ffffff" opacity=".65"/>
  <path d="M124 214 c0 -52 34 -94 76 -94 s76 42 76 94 c0 8 -6 12 -16 12 h-120 c-10 0 -16 -4 -16 -12 z" fill="{body}"/>
  <path d="M124 214 c0 -52 34 -94 76 -94 s76 42 76 94 c0 -34 -30 -62 -76 -62 s-76 28 -76 62 z" fill="{top}"/>
  <path d="M140 198 c4 -40 30 -68 60 -68 c-24 8 -42 34 -44 68 z" fill="#ffffff" opacity=".42"/>
  <path d="M124 214 h152 c0 8 -6 12 -16 12 h-120 c-10 0 -16 -4 -16 -12 z" fill="{body_dark}" opacity=".45"/>
  <ellipse cx="196" cy="124" rx="17" ry="7" fill="#ffffff" opacity=".55"/>
  <circle cx="278" cy="104" r="18" fill="{garnish}"/>
  <circle cx="278" cy="104" r="14" fill="{top}"/>
{spokes}
  <circle cx="278" cy="104" r="4" fill="{garnish}" opacity=".5"/>"""


def macaron(shell, shell_dark, cream):
    return f"""  <ellipse cx="200" cy="122" rx="82" ry="44" fill="{shell}"/>
  <ellipse cx="200" cy="114" rx="70" ry="33" fill="#ffffff" opacity=".2"/>
  <path d="M118 130 c0 20 36 30 82 30 s82 -10 82 -30 v10 c0 20 -36 30 -82 30 s-82 -10 -82 -30 z" fill="{shell_dark}"/>
  <ellipse cx="200" cy="170" rx="80" ry="25" fill="{cream}"/>
  <ellipse cx="200" cy="196" rx="82" ry="42" fill="{shell}"/>
  <path d="M118 196 c0 -22 36 -40 82 -40 s82 18 82 40" fill="{shell_dark}" opacity=".22"/>
  <ellipse cx="166" cy="108" rx="20" ry="9" fill="#ffffff" opacity=".35" transform="rotate(-14 166 108)"/>"""


def loaf(crust, crumb, glaze_color, seed_color):
    """A rolled cake seen end-on, so the spiral does the work."""
    return f"""  <path d="M148 128 h118 a56 56 0 0 1 0 112 h-118 z" fill="{crust}"/>
  <path d="M148 128 h118 a56 56 0 0 1 14 22 h-132 z" fill="{glaze_color}" opacity=".55"/>
  <ellipse cx="148" cy="184" rx="34" ry="56" fill="{crumb}"/>
  <path d="M148 184 m0 -44 a44 44 0 0 1 0 88 a34 34 0 0 1 0 -68 a24 24 0 0 1 0 48 a14 14 0 0 1 0 -28"
        fill="none" stroke="{crust}" stroke-width="11" stroke-linecap="round"/>
  <ellipse cx="148" cy="184" rx="34" ry="56" fill="none" stroke="{glaze_color}" stroke-width="4" opacity=".6"/>
  <path d="M196 134 c26 0 42 10 52 26" stroke="#ffffff" stroke-opacity=".3" stroke-width="7" fill="none" stroke-linecap="round"/>
  <g>
    <ellipse cx="214" cy="240" rx="9" ry="6" fill="{seed_color}" opacity=".8"/>
    <ellipse cx="250" cy="236" rx="7" ry="5" fill="{seed_color}" opacity=".65"/>
  </g>"""


# ── Chip layouts ─────────────────────────────────────────────────────────

CHIPS_CLASSIC = [(168, 124, 11, 12), (222, 116, 9, -20), (194, 158, 12, 34),
                 (152, 166, 8, -8), (240, 162, 10, 22), (206, 190, 7, 15)]
CHIPS_SPARSE = [(174, 126, 10, 8), (224, 130, 9, -16), (198, 166, 11, 30),
                (158, 172, 8, -22), (238, 168, 9, 14)]
CHIPS_SHARD = [(166, 120, 9, 20), (214, 112, 8, -14), (192, 156, 10, 38),
               (150, 164, 7, -30), (236, 158, 9, 10), (200, 190, 8, 24)]
CHIPS_FEW = [(178, 128, 10, 0), (222, 132, 9, 18), (200, 170, 11, -12)]


# ── The catalog ──────────────────────────────────────────────────────────

ITEMS = {
    # Weekly menu
    "pink-velvet": ("#fff1f6", "#ffd9e6", "Pink Velvet Crumb",
                    cupcake("#ffd3e2", "#f08cb6", "#e8557f", "#c73d64", cherry="#c73d64")),
    "brown-butter": ("#fff6ea", "#f6dfc0", "Brown Butter Chip",
                     cookie("#e6b478", "#b97f42", CHIPS_CLASSIC, ["#5a3420", "#402414", "#6b4026"])),
    "lemon-cloud": ("#fffbe8", "#ffeeb4", "Lemon Glaze Cloud",
                    mousse("#ffe27a", "#eec13c", "#fff6cf", "#f6b93b")),
    "biscoff": ("#fff4e4", "#f5dcb6", "Biscoff Butterscotch",
                loaf("#c88540", "#eec18a", "#a85f25", "#7a4418")),
    "strawberry-stack": ("#fff0f1", "#ffd6da", "Strawberry Shortcake",
                         slice_cake("#fff0d8", "#ffd3dc", "#f2536b", "#c9314a")),
    "midnight-fudge": ("#f3eef7", "#ddd0ea", "Midnight Fudge",
                       cookie("#4a2f52", "#2d1a33", CHIPS_SPARSE, ["#1d1022", "#6b4a74", "#2d1a33"])),
    "coconut-matcha": ("#f0f9ee", "#d3ecd0", "Coconut Matcha",
                       macaron("#bcd97f", "#93b957", "#fdfaf0")),
    "almond-fig": ("#f7f2fb", "#e2d6ef", "Almond Fig Tart",
                   tart("#e8c48f", "#c79a5e", "#f6ead6", "#8e5aa8", "#5f3573")),

    # Harvest Festival
    "maple-pecan": ("#fff3e3", "#f3d6ac", "Maple Pecan Stack",
                    slice_cake("#e2b173", "#f7e3c4", "#a4682c", "#7d4a18", berries=False)),
    "spiced-pear": ("#fdf6e6", "#eddfb5", "Spiced Pear Galette",
                    tart("#dfb87c", "#b98f4f", "#f3e4c4", "#c6d47a", "#93a447")),
    "cider-donut": ("#fff2e0", "#f2d7ae", "Cider Donut Box",
                    donut("#d9a05e", "#f0cf9a", "#c98a3f", ["#a8541f", "#e8b76a", "#7d3d12"])),

    # Holiday Table
    "peppermint-bark": ("#eef7f6", "#cfe7e6", "Peppermint Bark Slab",
                        cookie("#f2f6f6", "#c6d9d8", CHIPS_SHARD, ["#d6314a", "#2f7d6b", "#d6314a"])),
    "yule-log": ("#f4eee9", "#ddcdc0", "Chocolate Yule Log",
                 loaf("#5a3826", "#8a5a3c", "#3d2417", "#e8dcc8")),
    "gingerbread": ("#fdf0dd", "#eed4a8", "Gingerbread Spice Cake",
                    slice_cake("#c98a4e", "#f6e6cd", "#8c5220", "#6b3c14", berries=False)),

    # Lunar New Year
    "mooncake": ("#fff3ec", "#f2d5c6", "Lotus Mooncake",
                 tart("#d9a55e", "#b8813f", "#e8c390", "#a8532f", "#7d3a1e")),
    "sesame-ball": ("#fdf4e9", "#ecd9bd", "Sesame Rice Ball",
                    macaron("#f0dcb4", "#d4b98c", "#fff8ec")),
    "almond-cookie": ("#fff8ec", "#f0dfc0", "Lunar Almond Cookie",
                      cookie("#efd3a1", "#cfa96e", CHIPS_FEW, ["#a8763c", "#7d5426", "#a8763c"])),

    # Graduation Season
    "confetti-cake": ("#fdf2ff", "#e9d4f5", "Confetti Celebration Cake",
                      slice_cake("#fbf2ff", "#e2c2f2", "#c46ae0", "#9a44b8", berries=False)),
    "grad-cap": ("#eff2fb", "#d3dbf0", "Grad Cap Cookie",
                 cookie("#3c4670", "#262e4d", CHIPS_FEW, ["#d9b44a", "#f0d075", "#d9b44a"])),
    "lemon-bar": ("#fffbe6", "#f6eaad", "Sunshine Lemon Bar",
                  mousse("#ffe98f", "#e8c74a", "#fffdf2", "#f2b134")),
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for item_id, (bg_from, bg_to, name, art) in ITEMS.items():
        (OUT / f"{item_id}.svg").write_text(svg(art, bg_from, bg_to, name), encoding="utf-8")
    print(f"wrote {len(ITEMS)} illustrations to {OUT}")


if __name__ == "__main__":
    main()
