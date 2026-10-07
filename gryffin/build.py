"""Builds the Gryffin home page from products.json, and puts a product's own pages under it.

    python gryffin/build.py                 # rebuild index.html's product list and _headers
    python gryffin/build.py --check         # only check they're up to date (CI, tests)
    python gryffin/build.py add SLUG PATH   # copy a product's site (a folder or one .html)
                                            # to gryffin/SLUG/, served at gryffin.uk/SLUG/

Each product in products.json is one row on the home page. A product either lives on its own
address ("url", e.g. a subdomain with its own server) or is hosted here ("hosted": true, its
files in gryffin/SLUG/). Only static pages are hosted here: anything with accounts, logins or
payments keeps its own subdomain, so it never shares this origin with the other products.

The home page has no scripts and a strict Content-Security-Policy. A hosted product's pages
get the same security headers except that policy, which they set themselves (a
<meta http-equiv="Content-Security-Policy"> in their HTML), so the home page's rules never
break them and theirs never loosen the home page's.

Standard library only.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
REGISTRY = ROOT / "products.json"
INDEX = ROOT / "index.html"
HEADERS = ROOT / "_headers"

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}$")
# Names the home page itself uses at the top level; a product can't take them.
RESERVED = {"assets", "index", "404", "build", "products", "readme", "licenses", "fonts", "img"}
REQUIRED = ("slug", "name", "tagline", "for", "what")
DASHES = ("—", "–")  # em and en dash: the house style uses commas and periods

LIST_START = "<!--products:start (built from products.json by build.py; edit products.json, not this list)-->"
LIST_END = "<!--products:end-->"
COUNT = re.compile(r"<!--products:count-->.*?<!--/products:count-->", re.S)

HOME_CSP = (
    "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self';"
    " script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'self';"
    " form-action 'none'; frame-ancestors 'none'"
)
COMMON_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Strict-Transport-Security": "max-age=63072000",
    "Cross-Origin-Opener-Policy": "same-origin",
}


class RegistryError(ValueError):
    pass


# --- the registry -------------------------------------------------------------------------


def load(path: Path = REGISTRY) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    products = data.get("products") if isinstance(data, dict) else None
    if not isinstance(products, list):
        raise RegistryError('products.json must be {"products": [...]}')
    validate(products, path.parent)
    return products


def validate(products: list[dict], root: Path = ROOT) -> None:
    problems: list[str] = []
    seen: set[str] = set()
    for n, p in enumerate(products, 1):
        where = f"product {n} ({p.get('slug', '?')})"
        for key in REQUIRED:
            if not isinstance(p.get(key), str) or not p[key].strip():
                problems.append(f"{where}: '{key}' is missing")
        slug = p.get("slug", "")
        if not SLUG.match(slug) or slug in RESERVED:
            problems.append(f"{where}: slug must be 2-31 of a-z 0-9 - and not {sorted(RESERVED)}")
        if slug in seen:
            problems.append(f"{where}: slug used twice")
        seen.add(slug)
        texts = [str(p.get(k, "")) for k in (*REQUIRED, "letter")]
        texts += [str(x) for x in p.get("points", []) if isinstance(p.get("points"), list)]
        texts += [str(x.get("alt", "")) for x in p.get("shots", []) if isinstance(x, dict)]
        if any(d in t for t in texts for d in DASHES):
            problems.append(f"{where}: a text has an em or en dash; use a comma or period")
        points = p.get("points", [])
        if (
            not isinstance(points, list)
            or len(points) > 5
            or not all(isinstance(x, str) and x.strip() for x in points)
        ):
            problems.append(f"{where}: 'points' must be up to 5 short texts")
        shots = p.get("shots", [])
        if not isinstance(shots, list) or len(shots) > 2:
            problems.append(f"{where}: 'shots' must be up to 2 pictures")
            shots = []
        for shot in shots:
            src = str(shot.get("src", "")) if isinstance(shot, dict) else ""
            if not src.startswith("assets/img/") or ".." in src or not (root / src).is_file():
                problems.append(f"{where}: shot {src!r} must be a file in assets/img/")
            if not isinstance(shot, dict) or not str(shot.get("alt", "")).strip():
                problems.append(f"{where}: every shot needs an 'alt' saying what it shows")
        if p.get("hosted"):
            if not (root / slug / "index.html").is_file():
                problems.append(
                    f"{where}: hosted, but {slug}/index.html isn't there (build.py add)"
                )
        else:
            url = p.get("url", "")
            parts = urlsplit(url)
            if parts.scheme != "https" or not parts.hostname:
                problems.append(f"{where}: 'url' must be an https address, or set \"hosted\": true")
        logo, letter = p.get("logo"), p.get("letter")
        if logo:
            if (
                not str(logo).startswith("assets/img/")
                or ".." in str(logo)
                or not (root / logo).is_file()
            ):
                problems.append(f"{where}: logo {logo!r} must be a file in assets/img/")
        elif not (isinstance(letter, str) and 1 <= len(letter.strip()) <= 2):
            problems.append(
                f"{where}: give a 'logo' (assets/img/...) or a 'letter' (1-2 characters)"
            )
    if problems:
        raise RegistryError("\n".join(problems))


def href(p: dict) -> str:
    return f"/{p['slug']}/" if p.get("hosted") else p["url"]


def address(p: dict) -> str:
    if p.get("hosted"):
        return f"gryffin.uk/{p['slug']}"
    parts = urlsplit(p["url"])
    return (parts.hostname or "") + (parts.path.rstrip("/") if parts.path not in ("", "/") else "")


# --- the home page --------------------------------------------------------------------------


def widths(products: list[dict]) -> list[bool]:
    """Which panels take the whole row: those with pictures, and the last of a run of
    picture-less ones when the run is odd, so no panel sits next to an empty space."""
    wide = [bool(p.get("shots")) for p in products]
    run: list[int] = []
    for n, p in enumerate([*products, {"shots": [1]}]):
        if p.get("shots"):
            if len(run) % 2:
                wide[run[-1]] = True
            run = []
        else:
            run.append(n)
    return wide


def panel(p: dict, wide: bool = False) -> str:
    """One product on the home page: a panel with what it is and the way in, and, when the
    product has pictures ("shots"), the product itself in browser frames beside it."""
    e = html.escape
    pid = f"p-{p['slug']}"
    if p.get("logo"):
        mark = f'<span class="mark"><img src="{e(p["logo"])}" alt="" width="56" height="56"></span>'
    else:
        mark = f'<span class="mark letter" aria-hidden="true">{e(p["letter"].strip())}</span>'
    points = "".join(
        f'<li><svg aria-hidden="true"><use href="#i-check"/></svg>{e(x)}</li>'
        for x in p.get("points", [])
    )
    if points:
        points = f'\n              <ul class="points" role="list">{points}</ul>'
    shots = p.get("shots", [])
    if shots:
        frames = "".join(
            f'<figure class="frame {kind}"><span class="chrome" aria-hidden="true">'
            f'<i></i><i></i><i></i></span><img src="{e(shot["src"])}" alt="{e(shot["alt"])}"'
            f' width="1440" height="900"{lazy} decoding="async"></figure>'
            for shot, kind, lazy in zip(shots, ("front", "back"), ("", ' loading="lazy"'))
        )
        art = f'\n            <div class="shots">{frames}</div>'
    else:
        word = (p.get("letter") or p["name"]).strip()
        art = f'\n            <div class="monogram" aria-hidden="true"><span>{e(word)}</span></div>'
    kind = "panel featured" if shots else "panel wide" if wide else "panel"
    name = e(p["name"])
    return f"""      <li class="{kind}">
        <article aria-labelledby="{pid}">
          <div class="panel-text">
            <div class="panel-head">{mark}<div><h3 id="{pid}">{name}</h3><p class="tagline">{e(p["tagline"])}</p></div></div>
            <p class="for"><b>برای</b> {e(p["for"])}</p>
            <p class="what">{e(p["what"])}</p>{points}
            <div class="panel-foot"><a class="btn" href="{e(href(p))}">ورود به {name}<svg aria-hidden="true"><use href="#i-arrow"/></svg></a><span class="address" dir="ltr">{e(address(p))}</span></div>
          </div>{art}
        </article>
      </li>"""


def render_index(page: str, products: list[dict]) -> str:
    if LIST_START not in page or LIST_END not in page or not COUNT.search(page):
        raise RegistryError("index.html lost its products:start/end or products:count markers")
    head, rest = page.split(LIST_START, 1)
    _, tail = rest.split(LIST_END, 1)
    rows = "\n".join(panel(p, w) for p, w in zip(products, widths(products)))
    listing = (
        f'{LIST_START}\n    <ul class="panels" role="list">\n{rows}\n    </ul>\n    {LIST_END}'
    )
    page = head + listing + tail
    count = f'<!--products:count--><span class="count">{len(products)} محصول</span><!--/products:count-->'
    return COUNT.sub(count, page, count=1)


def render_headers(products: list[dict]) -> str:
    lines = [
        "# Built by build.py from products.json: edit those, not this file.",
        "# Every page: the security headers. The home page's own files also get its strict CSP;",
        "# a hosted product's pages don't, they set their own (see build.py).",
        "/*",
        *(f"  {k}: {v}" for k, v in COMMON_HEADERS.items()),
        f"  Content-Security-Policy: {HOME_CSP}",
        "",
        "/assets/*",
        "  Cross-Origin-Resource-Policy: same-origin",
        "",
        "# Fonts never change in place (a new version gets a new file name).",
        "/assets/fonts/*",
        "  Cache-Control: public, max-age=31536000, immutable",
    ]
    for p in products:
        if p.get("hosted"):
            slug = p["slug"]
            lines += [
                "",
                f"# {slug}: hosted here, in {slug}/",
                f"/{slug}",
                "  ! Content-Security-Policy",
            ]
            lines += [f"/{slug}/*", "  ! Content-Security-Policy"]
    return "\n".join(lines) + "\n"


def build(check: bool = False, root: Path = ROOT) -> list[str]:
    """Rebuilds index.html and _headers (or, with check, lists what's out of date)."""
    products = load(root / "products.json")
    wanted = {
        root / "index.html": render_index(
            (root / "index.html").read_text(encoding="utf-8"), products
        ),
        root / "_headers": render_headers(products),
    }
    stale = []
    for path, text in wanted.items():
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            stale.append(path.name)
            if not check:
                path.write_text(text, encoding="utf-8")
    return stale


# --- putting a product's site under the home page ------------------------------------------

ROOT_PATH = re.compile(r"""\b(?:src|href|action|poster)\s*=\s*["']/(?!/)([^"']*)""", re.I)
EXTERNAL_SCRIPT = re.compile(r"""<script[^>]+src\s*=\s*["'](?:https?:)?//([^/"']+)""", re.I)
APP_SIGNS = {
    'type="password"': "a password field",
    "type='password'": "a password field",
    "document.cookie": "cookies",
    "localStorage": "browser storage",
    "sessionStorage": "browser storage",
}


def scan(folder: Path) -> list[str]:
    """What to look at before a product's pages go live under gryffin.uk/SLUG/."""
    notes: list[str] = []
    for page in sorted(folder.rglob("*.htm*")):
        text = page.read_text(encoding="utf-8", errors="replace")
        name = page.relative_to(folder)
        for m in ROOT_PATH.finditer(text):
            notes.append(
                f"{name}: '/{m.group(1)}' starts at the site root; under /SLUG/ it must be relative"
            )
        for m in EXTERNAL_SCRIPT.finditer(text):
            notes.append(f"{name}: loads a script from {m.group(1)}; its own CSP must allow it")
        for sign, what in APP_SIGNS.items():
            if sign in text:
                notes.append(
                    f"{name}: uses {what}. Pages with logins or accounts belong on their own "
                    "subdomain, not on gryffin.uk (they'd share it with every other product)"
                )
    return notes


def add(slug: str, source: Path, replace: bool = False, root: Path = ROOT) -> list[str]:
    if not SLUG.match(slug) or slug in RESERVED:
        raise RegistryError(f"slug must be 2-31 of a-z 0-9 - and not {sorted(RESERVED)}")
    target = root / slug
    if target.exists() and not replace:
        raise RegistryError(f"{slug}/ is already there; pass --replace to overwrite it")
    if not source.exists():
        raise RegistryError(f"{source} doesn't exist")
    if target.exists():
        shutil.rmtree(target)
    if source.is_dir():
        if not (source / "index.html").is_file():
            raise RegistryError(f"{source} has no index.html")
        shutil.copytree(
            source, target, ignore=shutil.ignore_patterns(".git", ".DS_Store", "_headers")
        )
    elif source.suffix.lower() in (".html", ".htm"):
        target.mkdir()
        shutil.copy2(source, target / "index.html")
    else:
        raise RegistryError("give a folder with index.html, or one .html file")
    return scan(target)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="only report what's out of date")
    sub = parser.add_subparsers(dest="cmd")
    a = sub.add_parser("add", help="copy a product's site to gryffin/SLUG/")
    a.add_argument("slug")
    a.add_argument("source", type=Path)
    a.add_argument("--replace", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "add":
            notes = add(args.slug, args.source, args.replace)
            print(f"Copied to gryffin/{args.slug}/ (gryffin.uk/{args.slug}/).")
            for note in notes:
                print("  check:", note)
            print(
                f'Now add or update "{args.slug}" in products.json with "hosted": true, then run build.py.'
            )
            return 0
        stale = build(check=args.check)
    except RegistryError as e:
        print(e, file=sys.stderr)
        return 1
    if args.check and stale:
        print("Out of date (run python gryffin/build.py):", ", ".join(stale), file=sys.stderr)
        return 1
    print("Up to date." if not stale else "Rebuilt: " + ", ".join(stale))
    return 0


if __name__ == "__main__":
    sys.exit(main())
