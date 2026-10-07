"""The home page's two ornaments, drawn from geometry rather than by hand:

- the shamseh (the sun rosette at the heart of an illuminated Persian page), inlined in
  index.html between <!--shamseh:start--> and <!--shamseh:end-->, ring by ring so the page can
  draw it in on load;
- a khatam tile (eight-pointed stars and the crosses between them), assets/img/khatam.svg,
  the texture behind the page.

    python gryffin/ornament.py          # rewrite both
    python gryffin/ornament.py --check  # only check they're up to date
"""

from __future__ import annotations

import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
START, END = "<!--shamseh:start-->", "<!--shamseh:end-->"


def pt(r: float, deg: float) -> str:
    a = math.radians(deg - 90)  # 0 degrees points up
    return f"{r * math.cos(a):.2f},{r * math.sin(a):.2f}"


def star(points: int, outer: float, inner: float, turn: float = 0) -> str:
    """A star polygon: ``points`` tips on ``outer``, valleys on ``inner``."""
    step = 360 / points
    verts = []
    for k in range(points):
        verts.append(pt(outer, turn + k * step))
        verts.append(pt(inner, turn + k * step + step / 2))
    return " ".join(verts)


def polygon(sides: int, r: float, turn: float = 0) -> str:
    return " ".join(pt(r, turn + k * 360 / sides) for k in range(sides))


def star_polygon(n: int, skip: int, r: float, turn: float = 0) -> str:
    """{n/skip}: every ``skip``-th vertex of an n-gon joined, as one closed path."""
    seen, k, d = set(), 0, []
    while k not in seen:
        seen.add(k)
        d.append(("M" if not d else "L") + pt(r, turn + k * 360 / n))
        k = (k + skip) % n
    return " ".join(d) + " Z"


def shamseh() -> str:
    """Rings from the outside in; each ring is drawn in after the one before."""
    rings = [
        ['<circle r="240" pathLength="1"/>', '<circle r="229" pathLength="1"/>'],
        [f'<polygon points="{star(32, 229, 204)}" pathLength="1"/>'],
        [f'<polygon points="{star(16, 198, 156, 11.25)}" pathLength="1"/>'],
        [
            f'<polygon points="{polygon(4, 150)}" pathLength="1"/>',
            f'<polygon points="{polygon(4, 150, 45)}" pathLength="1"/>',
            f'<polygon points="{polygon(4, 150, 22.5)}" pathLength="1"/>',
            f'<polygon points="{polygon(4, 150, 67.5)}" pathLength="1"/>',
        ],
        [
            '<circle r="104" pathLength="1"/>',
            f'<polygon points="{star(8, 100, 66, 22.5)}" pathLength="1"/>',
        ],
        [f'<path d="{star_polygon(8, 3, 54)}" pathLength="1"/>', '<circle r="20" pathLength="1"/>'],
    ]
    dots = "".join(
        f'<circle class="dot" cx="{pt(252, k * 22.5).split(",")[0]}" cy="{pt(252, k * 22.5).split(",")[1]}" r="3"/>'
        for k in range(16)
    )
    groups = "\n".join(
        f'    <g class="ring r{n}">{"".join(shapes)}</g>' for n, shapes in enumerate(rings, 1)
    )
    return (
        f"{START}\n"
        '  <svg class="shamseh" viewBox="-260 -260 520 520" role="img" aria-label="شمسه">\n'
        f"{groups}\n"
        f'    <g class="ring dots">{dots}</g>\n'
        "  </svg>\n"
        f"  {END}"
    )


def khatam(size: int = 96) -> str:
    """One tile of the khatam: an eight-pointed star at each corner and in the middle, the
    points of neighbouring stars meeting so crosses form between them."""
    h = size / 2
    r = h * 0.62
    stars = []
    for cx, cy in ((0, 0), (size, 0), (0, size), (size, size), (h, h)):
        for turn in (0, 45):
            pts = " ".join(
                f"{cx + r * math.cos(math.radians(turn + 90 * k)):.2f},"
                f"{cy + r * math.sin(math.radians(turn + 90 * k)):.2f}"
                for k in range(4)
            )
            stars.append(f'<polygon points="{pts}"/>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}"><g fill="none" stroke="#f2b33d" stroke-width="1" '
        f'stroke-opacity="0.55">{"".join(stars)}</g></svg>\n'
    )


def main(argv: list[str]) -> int:
    check = "--check" in argv
    index = ROOT / "index.html"
    page = index.read_text(encoding="utf-8")
    if START not in page or END not in page:
        print("index.html lost its shamseh markers", file=sys.stderr)
        return 1
    built = re.sub(re.escape(START) + ".*?" + re.escape(END), lambda _: shamseh(), page, flags=re.S)
    wanted = {index: built, ROOT / "assets" / "img" / "khatam.svg": khatam()}
    stale = [
        p.name
        for p, text in wanted.items()
        if not p.exists() or p.read_text(encoding="utf-8") != text
    ]
    if check:
        if stale:
            print(
                "Out of date (run python gryffin/ornament.py):", ", ".join(stale), file=sys.stderr
            )
        return 1 if stale else 0
    for p, text in wanted.items():
        p.write_text(text, encoding="utf-8")
    print("Wrote", ", ".join(stale) or "nothing (up to date)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
