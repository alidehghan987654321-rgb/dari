"""The Gryffin home page (gryffin/): built from products.json, safe to host product sites under,
and free of the habits that make a page look machine-made."""

import importlib.util
import json
import re
import shutil
from pathlib import Path

import pytest

GRYFFIN = Path(__file__).resolve().parent.parent / "gryffin"
spec = importlib.util.spec_from_file_location("gryffin_build", GRYFFIN / "build.py")
gb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gb)


@pytest.fixture
def site(tmp_path):
    """A copy of the home page to build into."""
    root = tmp_path / "gryffin"
    shutil.copytree(GRYFFIN, root, ignore=shutil.ignore_patterns("__pycache__"))
    return root


def write_registry(root, products):
    (root / "products.json").write_text(json.dumps({"products": products}), encoding="utf-8")


def product(**extra):
    return {
        "slug": "nemoone",
        "name": "نمونه",
        "tagline": "یه محصول",
        "for": "همه",
        "what": "کاری انجام می‌ده.",
        "letter": "N",
        "url": "https://nemoone.gryffin.uk/",
        **extra,
    }


# --- the registry and the build -------------------------------------------------------------


def test_the_page_is_built_from_the_registry():
    assert gb.build(check=True) == []  # index.html and _headers match products.json
    page = (GRYFFIN / "index.html").read_text(encoding="utf-8")
    for p in gb.load():
        assert f'href="{gb.href(p)}"' in page and p["name"] in page
    assert f'<span class="count">{len(gb.load())} محصول</span>' in page


def test_a_new_product_appears_with_its_text_escaped(site):
    write_registry(site, [product(name="<script>x</script>", what='"quoted" & more')])
    assert gb.build(root=site) == ["index.html"]  # nothing hosted: _headers stays
    page = (site / "index.html").read_text(encoding="utf-8")
    assert "<script>x" not in page and "&lt;script&gt;x&lt;/script&gt;" in page
    assert "&quot;quoted&quot; &amp; more" in page
    assert '<span class="count">1 محصول</span>' in page
    assert 'href="https://nemoone.gryffin.uk/"' in page and "nemoone.gryffin.uk</span>" in page
    assert gb.build(root=site) == []  # building again changes nothing


@pytest.mark.parametrize(
    "change, problem",
    [
        ({"slug": "Bad Slug"}, "slug"),
        ({"slug": "assets"}, "slug"),
        ({"url": "http://nemoone.gryffin.uk/"}, "https"),
        ({"url": "javascript:alert(1)"}, "https"),
        ({"what": "سریع — و ساده"}, "dash"),
        ({"logo": "assets/img/nope.png"}, "logo"),
        ({"logo": "../../etc/passwd"}, "logo"),
        ({"letter": ""}, "letter"),
        ({"hosted": True}, "isn't there"),
        ({"name": ""}, "'name' is missing"),
    ],
)
def test_a_bad_registry_entry_is_refused(site, change, problem):
    write_registry(site, [product(**change)])
    with pytest.raises(gb.RegistryError, match=problem):
        gb.build(root=site)


def test_two_products_cant_share_a_slug(site):
    write_registry(site, [product(), product()])
    with pytest.raises(gb.RegistryError, match="twice"):
        gb.build(root=site)


# --- hosting a product's own pages under gryffin.uk/SLUG/ -----------------------------------


def test_adding_a_hosted_product(site, tmp_path):
    source = tmp_path / "bookfin-site"
    source.mkdir()
    (source / "index.html").write_text(
        '<link rel="stylesheet" href="/style.css"><img src="logo.png">'
        '<script src="https://cdn.example.com/x.js"></script><input type="password">',
        encoding="utf-8",
    )
    notes = gb.add("bookfin", source, root=site)
    assert (site / "bookfin" / "index.html").is_file()
    assert any("'/style.css' starts at the site root" in n for n in notes)
    assert any("cdn.example.com" in n for n in notes)
    assert any("own subdomain" in n for n in notes)
    assert not any("logo.png" in n for n in notes)  # relative links are fine

    write_registry(site, [product(slug="bookfin", hosted=True, url=None)])
    gb.build(root=site)
    page = (site / "index.html").read_text(encoding="utf-8")
    assert 'href="/bookfin/"' in page and "gryffin.uk/bookfin</span>" in page
    headers = (site / "_headers").read_text(encoding="utf-8")
    # The home page's strict policy is lifted for the product's pages only.
    assert "/bookfin/*\n  ! Content-Security-Policy" in headers
    assert "/bookfin\n  ! Content-Security-Policy" in headers


def test_add_refuses_bad_input(site, tmp_path):
    page = tmp_path / "one.html"
    page.write_text("<h1>hi</h1>", encoding="utf-8")
    assert gb.add("solo", page, root=site) == []
    assert (site / "solo" / "index.html").read_text(encoding="utf-8") == "<h1>hi</h1>"
    with pytest.raises(gb.RegistryError, match="already there"):
        gb.add("solo", page, root=site)
    assert gb.add("solo", page, replace=True, root=site) == []
    with pytest.raises(gb.RegistryError, match="slug"):
        gb.add("assets", page, root=site)  # would replace the home page's own files
    with pytest.raises(gb.RegistryError, match="slug"):
        gb.add("../escape", page, root=site)
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(gb.RegistryError, match="no index.html"):
        gb.add("empty", empty, root=site)


def test_a_products_own_headers_file_is_not_copied(site, tmp_path):
    """Only the home page decides the headers (one _headers file at the root)."""
    source = tmp_path / "s"
    source.mkdir()
    (source / "index.html").write_text("<p>x</p>", encoding="utf-8")
    (source / "_headers").write_text("/*\n  Access-Control-Allow-Origin: *\n", encoding="utf-8")
    gb.add("prod", source, root=site)
    assert not (site / "prod" / "_headers").exists()


# --- the home page's own rules --------------------------------------------------------------


PAGES = ("index.html", "404.html")


def visible_text(page):
    page = re.sub(r"<(script|style|svg)\b.*?</\1>", " ", page, flags=re.S)
    page = re.sub(r"<!--.*?-->", " ", page, flags=re.S)
    return re.sub(r"<[^>]+>", " ", page)


@pytest.mark.parametrize("name", PAGES)
def test_home_pages_stay_strict(name):
    page = (GRYFFIN / name).read_text(encoding="utf-8")
    assert "<script" not in page and " style=" not in page  # the CSP allows neither
    assert "—" not in visible_text(page) and "–" not in visible_text(page)
    assert 'class="eyebrow"' not in page
    for ref in re.findall(r'(?:src|href)="([^"]+)"', page):
        if ref.startswith(("#", "data:", "tel:", "mailto:", "https://")) or ref == "/":
            continue
        assert (GRYFFIN / ref.lstrip("/")).is_file(), f"{name} links to missing {ref}"
    for ref in re.findall(r'(?:src|href)="(https?://[^"]+)"', page):
        assert not ref.endswith((".css", ".js", ".woff2")), "nothing loads from another site"


def test_stylesheet_fonts_exist_and_headers_are_strict():
    css = (GRYFFIN / "assets" / "site.css").read_text(encoding="utf-8")
    for font in re.findall(r'url\("([^"]+)"\)', css):
        assert (GRYFFIN / "assets" / font).is_file()
    rules = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    assert "letter-spacing" not in rules  # it breaks Persian joins
    headers = (GRYFFIN / "_headers").read_text(encoding="utf-8")
    assert "script-src 'none'" in headers and "frame-ancestors 'none'" in headers
    ignored = (GRYFFIN / ".assetsignore").read_text(encoding="utf-8").split()
    assert {"build.py", "products.json", "README.md"} <= set(ignored)


# --- the showcase: pictures, points, and panel widths ---------------------------------------


@pytest.mark.parametrize(
    "change, problem",
    [
        ({"shots": [{"src": "assets/img/none.webp", "alt": "x"}]}, "shot"),
        ({"shots": [{"src": "assets/img/shekarchi-dash.webp"}]}, "alt"),
        ({"shots": [{"src": "../../etc/passwd", "alt": "x"}]}, "shot"),
        ({"shots": [{"src": "assets/img/shekarchi-dash.webp", "alt": "x"}] * 3}, "up to 2"),
        ({"points": ["a"] * 6}, "points"),
        ({"points": ["سریع – ساده"]}, "dash"),
    ],
)
def test_bad_pictures_or_points_are_refused(site, change, problem):
    write_registry(site, [product(**change)])
    with pytest.raises(gb.RegistryError, match=problem):
        gb.build(root=site)


def test_a_product_with_pictures_is_shown_in_frames(site):
    shot = {"src": "assets/img/shekarchi-dash.webp", "alt": "میز <کار>"}
    write_registry(site, [product(shots=[shot], points=["یک", "دو"])])
    gb.build(root=site)
    page = (site / "index.html").read_text(encoding="utf-8")
    assert 'class="panel featured"' in page and 'class="frame front"' in page
    assert 'alt="میز &lt;کار&gt;"' in page
    assert page.count('<use href="#i-check"/>') == 2


@pytest.mark.parametrize(
    "shots, wide",
    [
        ([1, 0], [True, True]),  # a lone picture-less panel takes the row
        ([1, 0, 0], [True, False, False]),  # two share a row
        ([0, 0, 0], [False, False, True]),  # the odd one out takes the row
        ([0, 1, 0, 0, 0], [True, True, False, False, True]),
    ],
)
def test_no_panel_sits_beside_an_empty_space(shots, wide):
    assert gb.widths([{"shots": [1] if s else []} for s in shots]) == wide


def test_the_ornaments_match_their_geometry():
    spec = importlib.util.spec_from_file_location("gryffin_ornament", GRYFFIN / "ornament.py")
    orn = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(orn)
    assert orn.main(["--check"]) == 0
    page = (GRYFFIN / "index.html").read_text(encoding="utf-8")
    assert page.count('pathLength="1"') >= 10  # drawn in, ring by ring
