"""Temu listings and 1688 image search through Apify actors (https://apify.com).

Temu and 1688 have no public product API, so scraping "actors" on Apify do the work:
one call runs an actor and returns its dataset items. Which actor to use, and the shape
of its input, differ per actor, so both are settings (see hunter/README.md): the input
is a JSON template where {query}, {image_url} and {limit} are filled in. Output fields
are read loosely, since each actor names them a little differently.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..categories import Category
from ..matching import best_match, search_terms
from ..models import MarketListing, OfferDetail, SupplierOffer
from .base import LinkError, pick, to_count, to_number

log = logging.getLogger(__name__)

RUN_URL = "https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"

DEFAULT_TEMU_INPUT = '{"searchQueries": ["{query}"], "maxItems": {limit}}'
DEFAULT_1688_IMAGE_INPUT = '{"imageUrls": ["{image_url}"], "maxItems": {limit}}'
DEFAULT_1688_KEYWORD_INPUT = '{"keywords": ["{query}"], "maxItems": {limit}}'
DEFAULT_TEMU_PRODUCT_INPUT = '{"startUrls": [{"url": "{url}"}], "maxItems": 1}'
DEFAULT_1688_BATCH_INPUT = '{"imageUrls": {image_urls}, "maxItems": {limit}}'
# Where a batched image search says which of the pictures a result belongs to.
SOURCE_IMAGE_FIELDS = (
    "queryImage", "searchImage", "searchImageUrl", "inputImage", "inputImageUrl",
    "sourceImage", "sourceImageUrl", "input.imageUrl", "query.imageUrl",
)  # fmt: skip
MATCH_RESULTS = 5  # results asked for when looking a product up on Temu (each one is paid for)
DEFAULT_1688_DETAIL_INPUT = '{"startUrls": [{"url": "{url}"}], "maxItems": 1}'


def fill(template: str, **values: Any) -> dict:
    """Fill a JSON input template. Strings go inside the template's quotes (escaped);
    numbers and lists go in as JSON."""
    text = template
    for key, value in values.items():
        encoded = json.dumps(value, ensure_ascii=False)
        if isinstance(value, str):
            encoded = encoded[1:-1]  # the template supplies the quotes
        text = text.replace("{" + key + "}", encoded)
    return json.loads(text)


class Apify:
    def __init__(self, token: str, client: httpx.Client | None = None, timeout: float = 300):
        self.token = token
        self.http = client or httpx.Client(timeout=timeout)

    def run(self, actor: str, payload: dict) -> list[dict]:
        url = RUN_URL.format(actor=actor.replace("/", "~"))
        r = self.http.post(url, params={"token": self.token}, json=payload)
        r.raise_for_status()
        data = r.json()
        return [x for x in data if isinstance(x, dict)] if isinstance(data, list) else []


class TemuMarket:
    name = "temu"

    def __init__(
        self,
        apify: Apify,
        actor: str,
        input_template: str = DEFAULT_TEMU_INPUT,
        product_actor: str = "",
        product_input: str = DEFAULT_TEMU_PRODUCT_INPUT,
    ):
        self.apify = apify
        self.actor = actor
        self.input_template = input_template
        self.product_actor = product_actor  # reads one product page, for pasted links
        self.product_input = product_input

    def trending(self, category: Category, limit: int) -> list[MarketListing]:
        payload = fill(self.input_template, query=category.temu_query, limit=limit)
        items = self.apify.run(self.actor, payload)
        listings = [x for x in (temu_listing(i, category.key) for i in items) if x]
        return listings[:limit]

    def find_similar(self, listing: MarketListing) -> MarketListing | None:
        """The same product on Temu, by searching its title's keywords."""
        terms = search_terms(listing.title)
        if not terms:
            return None
        items = self.apify.run(
            self.actor, fill(self.input_template, query=terms, limit=MATCH_RESULTS)
        )
        return best_match(listing, [x for x in (temu_listing(i, "") for i in items) if x])

    def handles(self, url: str) -> bool:
        host = urlsplit(url).hostname or ""
        return host == "temu.com" or host.endswith(".temu.com")

    def listing_by_url(self, url: str) -> MarketListing | None:
        if not self.product_actor:
            raise LinkError("temu_links_not_configured")
        items = self.apify.run(self.product_actor, fill(self.product_input, url=url))
        found = next((x for x in (temu_listing(i, "") for i in items) if x), None)
        if found and not found.url.startswith("http"):
            found.url = url
        return found


def temu_listing(item: dict, category: str) -> MarketListing | None:
    price = to_number(
        pick(
            item,
            "price",
            "salePrice",
            "currentPrice",
            "priceInfo.price",
            "price.amount",
            "priceText",
        )
    )
    url = pick(item, "url", "productUrl", "link", "goodsUrl")
    title = pick(item, "title", "name", "goodsName")
    if not price or not url or not title:
        return None
    sold_text = pick(item, "soldCount", "sold", "sales", "salesTip", "soldText")
    reviews = pick(item, "reviewCount", "reviews", "commentCount", "ratingCount")
    rating = to_number(pick(item, "rating", "stars", "score"))
    return MarketListing(
        source="temu",
        id=str(pick(item, "id", "goodsId", "productId") or url),
        title=str(title),
        url=str(url),
        image_url=str(pick(item, "image", "imageUrl", "thumbnail", "images.0", "thumbUrl") or ""),
        price_usd=price,
        category=category,
        sold_total=to_count(sold_text),
        reviews=to_count(reviews),
        rating=rating if rating is not None and rating <= 5 else None,
    )


class Supplier1688:
    def __init__(
        self,
        apify: Apify,
        image_actor: str,
        keyword_actor: str = "",
        image_input: str = DEFAULT_1688_IMAGE_INPUT,
        keyword_input: str = DEFAULT_1688_KEYWORD_INPUT,
        batch_input: str = DEFAULT_1688_BATCH_INPUT,
        detail_actor: str = "",
        detail_input: str = DEFAULT_1688_DETAIL_INPUT,
    ):
        self.apify = apify
        self.image_actor = image_actor
        self.keyword_actor = keyword_actor
        self.image_input = image_input
        self.keyword_input = keyword_input
        self.batch_input = batch_input  # "" turns batching off
        self.detail_actor = detail_actor  # reads one offer page, to show it on our site
        self.detail_input = detail_input

    def offer_detail(self, url: str) -> OfferDetail | None:
        """Pictures, specs, variants and shop badges of one offer page."""
        if not self.detail_actor:
            raise LinkError("details_not_configured")
        items = self.apify.run(self.detail_actor, fill(self.detail_input, url=url))
        return next((d for d in (offer_detail(i, url) for i in items) if d), None)

    def by_images(self, image_urls: list[str], limit: int) -> dict[str, list[SupplierOffer]]:
        """One actor run for many pictures (one run fee instead of one per picture).

        Only works if the actor says which picture each result is for; if it doesn't,
        nothing is returned and the hunt searches picture by picture.
        """
        if not self.batch_input or not image_urls:
            return {}
        payload = fill(self.batch_input, image_urls=image_urls, limit=limit * len(image_urls))
        found: dict[str, list[SupplierOffer]] = {}
        for item in self.apify.run(self.image_actor, payload):
            source = pick(item, *SOURCE_IMAGE_FIELDS)
            offer = offer_1688(item)
            if source in image_urls and offer and len(found.get(source, [])) < limit:
                found.setdefault(source, []).append(offer)
        if not found:
            log.warning("The 1688 actor doesn't tag results with their picture; no batching")
        return found

    def by_image(self, image_url: str, limit: int) -> list[SupplierOffer]:
        if not image_url:
            return []
        items = self.apify.run(
            self.image_actor, fill(self.image_input, image_url=image_url, limit=limit)
        )
        return [x for x in (offer_1688(i) for i in items) if x][:limit]

    def by_keyword(self, query: str, limit: int) -> list[SupplierOffer]:
        if not self.keyword_actor:
            return []
        items = self.apify.run(
            self.keyword_actor, fill(self.keyword_input, query=query, limit=limit)
        )
        return [x for x in (offer_1688(i) for i in items) if x][:limit]


def offer_1688(item: dict) -> SupplierOffer | None:
    # A price range on 1688 runs from the big-order price to the small-order price;
    # a first order is small, so take the higher end.
    price = to_number(
        pick(
            item, "price", "priceRange", "price.value", "salePrice", "priceInfo.price", "minPrice"
        ),
        highest=True,
    )
    url = pick(item, "url", "detailUrl", "offerUrl", "link", "productUrl")
    if not price or not url:
        return None
    grams = to_number(pick(item, "weight", "unitWeight", "weightGrams"))
    shop = str(
        pick(item, "shopName", "companyName", "sellerName", "supplierName", "shop.name", "company")
        or ""
    )
    factory = pick(item, "isFactory", "factory", "isSourceFactory", "sourceFactory")
    repurchase = to_number(pick(item, "repurchaseRate", "rePurchaseRate", "buyAgainRate"))
    rating = to_number(pick(item, "shopRating", "rating", "score", "shop.rating"))
    return SupplierOffer(
        id=str(pick(item, "offerId", "id", "productId") or url),
        title=str(pick(item, "title", "subject", "name") or ""),
        url=str(url),
        image_url=str(pick(item, "image", "imageUrl", "img", "mainImage") or ""),
        price_cny=price,
        moq=int(to_number(pick(item, "moq", "minOrderQuantity", "quantityBegin", "minOrder")) or 1),
        sales=to_count(
            pick(
                item, "sales", "soldCount", "monthSold", "saleCount", "transactions", "bookedCount"
            )
        ),
        weight_kg=grams / 1000 if grams and grams > 10 else None,
        shop_name=shop,
        shop_url=str(pick(item, "shopUrl", "companyUrl", "sellerUrl", "shop.url") or ""),
        location=str(pick(item, "location", "province", "city", "sendAddress", "area") or ""),
        years=to_count(
            pick(item, "tpYear", "years", "yearsOnPlatform", "memberYears", "shop.years")
        ),
        # Chinese shop names say "厂" (factory) when they are one.
        is_factory=bool(factory) if factory is not None else ("厂" in shop or None),
        repurchase_rate=repurchase / 100 if repurchase and repurchase > 1 else repurchase,
        rating=rating if rating is not None and rating <= 5 else None,
        price_tiers=price_tiers(
            pick(item, "priceTiers", "priceRanges", "quantityPrices", "skuPriceRanges")
        ),
    )


def price_tiers(value: Any) -> list[list[float]]:
    """1688 quantity pricing, as [[from quantity, price], ...] sorted by quantity."""
    tiers = []
    for tier in value if isinstance(value, list) else []:
        if not isinstance(tier, dict):
            continue
        qty = to_number(pick(tier, "startQuantity", "beginAmount", "minQuantity", "quantity"))
        price = to_number(pick(tier, "price", "value"))
        if qty and price:
            tiers.append([int(qty), price])
    return sorted(tiers)


def _strings(value: Any) -> list[str]:
    """A list of strings from a list of strings or of {url/name/text: ...} objects."""
    out = []
    for v in value if isinstance(value, list) else []:
        text = (
            v
            if isinstance(v, str)
            else pick(v, "url", "fullPathImageURI", "name", "text", "label")
            if isinstance(v, dict)
            else None
        )
        if text:
            out.append(str(text))
    return out


def offer_detail(item: dict, url: str) -> OfferDetail | None:
    offer = offer_1688({**item, "url": pick(item, "url", "detailUrl", "offerUrl") or url})
    if offer is None:
        return None
    images = _strings(pick(item, "images", "imageList", "mainImages", "pics", "imageUrls"))
    attrs_raw = pick(item, "attributes", "productAttributes", "props", "specs", "attributeList")
    if isinstance(attrs_raw, dict):
        attributes = [[str(k), str(v)] for k, v in attrs_raw.items()]
    else:
        attributes = [
            [
                str(pick(a, "name", "attributeName", "key") or ""),
                str(pick(a, "value", "attributeValue", "values") or ""),
            ]
            for a in attrs_raw or []
            if isinstance(a, dict)
        ]
    skus = []
    for sku in pick(item, "skus", "skuList", "skuInfos", "variants") or []:
        if not isinstance(sku, dict):
            continue
        name = pick(sku, "name", "specAttrs", "spec", "title", "attributes")
        skus.append({
            "name": " / ".join(_strings(name)) if isinstance(name, list) else str(name or ""),
            "price_cny": to_number(pick(sku, "price", "discountPrice", "salePrice")),
            "stock": to_count(pick(sku, "stock", "amountOnSale", "canBookCount", "quantity")),
        })  # fmt: skip
    badges = _strings(pick(item, "badges", "shopBadges", "serviceTags", "tags", "labels"))
    return OfferDetail(
        offer=offer,
        images=images or ([offer.image_url] if offer.image_url else []),
        attributes=[a for a in attributes if a[0] and a[1]],
        skus=[x for x in skus if x["name"]],
        badges=badges,
    )
