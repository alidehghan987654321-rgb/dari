"""Product categories, and spotting products that are risky to import or sell.

Each category knows how to search for it on Temu (English), on 1688 (Chinese) and on
Amazon (Keepa best-seller category ID). Some categories are off limits for a normal
seller: they need safety certificates, health permits or dangerous-goods shipping.
Titles are also scanned, because a "car vacuum" in the car category still has a
lithium battery in it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class Category:
    key: str
    fa: str  # name shown to sellers
    en: str
    temu_query: str
    zh_query: str
    amazon_category_id: int  # Amazon US root/sub category, for Keepa best sellers
    default_weight_kg: float  # used when neither listing nor supplier gives a weight
    keywords: tuple[str, ...] = ()  # English/Chinese words that point to this category
    restricted: bool = False
    note_fa: str = ""


CATEGORIES: dict[str, Category] = {
    c.key: c
    for c in [
        Category(
            "home_kitchen",
            "خانه و آشپزخانه",
            "Home & Kitchen",
            "kitchen gadgets",
            "厨房用品",
            1055398,
            0.5,
            (
                "kitchen",
                "cooking",
                "utensil",
                "dish",
                "sink",
                "lid",
                "bottle opener",
                "厨房",
                "锅",
                "碗",
            ),
        ),
        Category(
            "storage",
            "نظم‌دهی و نگهداری",
            "Storage & Organization",
            "storage organizer",
            "收纳",
            3610841,
            0.7,
            ("storage", "organizer", "drawer", "closet", "hanger", "收纳", "整理"),
        ),
        Category(
            "car",
            "لوازم جانبی خودرو",
            "Car Accessories",
            "car accessories",
            "汽车用品",
            15684181,
            0.4,
            ("car ", "car seat", "vehicle", "auto ", "dashboard", "cup holder", "汽车", "车载"),
        ),
        Category(
            "sports_travel",
            "ورزش و سفر",
            "Sports & Travel",
            "travel accessories",
            "运动户外",
            3375251,
            0.6,
            ("travel", "packing", "yoga", "fitness", "gym", "camping", "旅行", "运动", "瑜伽"),
        ),
        Category(
            "pets",
            "حیوانات خانگی",
            "Pet Supplies",
            "pet supplies",
            "宠物用品",
            2619533011,
            0.5,
            ("pet", "dog", "cat ", "cat,", "puppy", "kitten", "宠物", "狗", "猫"),
        ),
        Category(
            "phone_accessories",
            "لوازم جانبی موبایل",
            "Phone Accessories",
            "phone accessories",
            "手机配件",
            2335752011,
            0.2,
            ("phone", "iphone", "smartphone", "手机"),
            note_fa="فقط مدل‌های بدون باتری؛ پاوربانک و شارژر باتری‌دار جزو کالای خطرناکن.",
        ),
        Category(
            "beauty_tools",
            "ابزار زیبایی",
            "Beauty Tools",
            "beauty tools",
            "美容工具",
            3760911,
            0.2,
            ("hair", "makeup brush", "curler", "nail", "comb", "美容", "发"),
            note_fa="فقط ابزار؛ کرم، سرم و هر چیزی که روی پوست زده میشه مجوز بهداشتی می‌خواد.",
        ),
        Category(
            "garden",
            "باغ و فضای باز",
            "Garden & Outdoor",
            "garden tools",
            "园艺",
            2972638011,
            0.8,
            ("garden", "plant", "outdoor", "patio", "园艺", "花盆"),
        ),
        Category(
            "office_stationery",
            "اداری و لوازم‌تحریر",
            "Office & Stationery",
            "office supplies",
            "办公用品",
            1064954,
            0.4,
            (
                "office",
                "pen",
                "notebook",
                "desk organizer",
                "stapler",
                "stationery",
                "办公",
                "文具",
                "笔",
            ),
        ),
        Category(
            "tools_hardware",
            "ابزار و یراق‌آلات",
            "Tools & Hardware",
            "hand tools",
            "五金工具",
            228013,
            0.8,
            (
                "tool",
                "wrench",
                "screwdriver",
                "pliers",
                "hardware",
                "drill bit",
                "工具",
                "五金",
                "螺丝",
            ),
        ),
        Category(
            "lighting",
            "روشنایی و لوازم نور",
            "Lighting",
            "led lights",
            "灯具",
            495224,
            0.6,
            ("light", "lamp", "led strip", "bulb", "lantern", "灯", "灯具", "照明"),
        ),
        Category(
            "bags_luggage",
            "کیف و چمدان",
            "Bags & Luggage",
            "bags backpack",
            "箱包",
            15743631,
            0.7,
            (
                "bag",
                "backpack",
                "wallet",
                "purse",
                "luggage",
                "handbag",
                "包",
                "背包",
                "钱包",
                "箱",
            ),
        ),
        Category(
            "jewelry_accessories",
            "بدلیجات و زیورآلات",
            "Jewelry & Accessories",
            "fashion jewelry",
            "饰品",
            7192394011,
            0.1,
            (
                "jewelry",
                "necklace",
                "bracelet",
                "earring",
                "ring",
                "pendant",
                "首饰",
                "饰品",
                "项链",
            ),
        ),
        Category(
            "watches",
            "ساعت",
            "Watches",
            "wrist watch",
            "手表",
            6358540011,
            0.2,
            ("watch", "wristwatch", "手表", "腕表"),
        ),
        Category(
            "home_decor",
            "دکوراسیون منزل",
            "Home Décor",
            "home decor",
            "家居装饰",
            1063278,
            0.6,
            ("decor", "wall art", "vase", "candle", "cushion", "frame", "装饰", "摆件", "花瓶"),
        ),
        Category(
            "bathroom",
            "حمام و سرویس بهداشتی",
            "Bathroom",
            "bathroom accessories",
            "浴室用品",
            1057782,
            0.5,
            (
                "bathroom",
                "shower",
                "towel",
                "soap dispenser",
                "toothbrush holder",
                "浴室",
                "卫浴",
                "淋浴",
            ),
        ),
        Category(
            "bedroom_textile",
            "اتاق‌خواب و نساجی",
            "Bedroom & Textile",
            "bedding set",
            "床上用品",
            1063308,
            0.9,
            ("bedding", "pillow", "blanket", "bed sheet", "quilt", "床品", "枕头", "被子"),
        ),
        Category(
            "crafts_hobby",
            "هنر، خیاطی و سرگرمی",
            "Crafts & Hobby",
            "craft supplies",
            "手工用品",
            2617941011,
            0.4,
            ("craft", "sewing", "knitting", "diy", "paint", "sticker", "手工", "手作", "缝纫"),
        ),
        Category(
            "party_supplies",
            "لوازم جشن و مهمانی",
            "Party Supplies",
            "party supplies",
            "派对用品",
            2528042011,
            0.4,
            ("party", "balloon", "birthday", "decoration", "banner", "派对", "气球", "生日"),
        ),
        Category(
            "cleaning",
            "نظافت و شستشو",
            "Cleaning",
            "cleaning tools",
            "清洁用品",
            3732341,
            0.5,
            ("cleaning", "brush", "mop", "sponge", "duster", "清洁", "打扫", "拖把"),
        ),
        Category(
            "fashion_accessories",
            "اکسسوری پوشاک",
            "Fashion Accessories",
            "fashion accessories",
            "时尚配件",
            7141124011,
            0.3,
            (
                "hat",
                "belt",
                "scarf",
                "socks",
                "sunglasses",
                "gloves",
                "帽子",
                "围巾",
                "袜子",
                "太阳镜",
            ),
        ),
        Category(
            "kids_toys",
            "اسباب‌بازی کودک",
            "Kids & Toys",
            "toys",
            "玩具",
            165793011,
            0.5,
            ("toy", "kids", "baby", "toddler", "montessori", "children", "玩具", "儿童", "婴儿"),
            restricted=True,
            note_fa="گواهی ایمنی کودک (CPC در آمریکا، EN71/CE در اروپا) لازمه؛ بدون مدرک نیار.",
        ),
        Category(
            "cosmetics",
            "آرایشی و بهداشتی",
            "Cosmetics",
            "skincare",
            "护肤品",
            3760911,
            0.3,
            (
                "cream",
                "serum",
                "lotion",
                "skincare",
                "shampoo",
                "perfume",
                "lipstick",
                "护肤",
                "面霜",
                "精华",
            ),
            restricted=True,
            note_fa="ثبت و مجوز بهداشتی می‌خواد و در صورت مشکل پوستی، مسئولیتش با فروشنده‌ست.",
        ),
        Category(
            "batteries",
            "برقی باتری‌دار",
            "Battery-powered",
            "rechargeable gadgets",
            "充电",
            172282,
            0.4,
            (
                "rechargeable",
                "battery",
                "lithium",
                "power bank",
                "cordless",
                "wireless charger",
                "充电",
                "电池",
                "锂",
            ),
            restricted=True,
            note_fa="باتری لیتیومی کالای خطرناک حساب میشه: حمل هوایی محدودیت داره و گواهی MSDS/UN38.3 لازمه.",
        ),
        Category(
            "food_health",
            "خوراکی، مکمل و پزشکی",
            "Food, Supplements & Medical",
            "supplements",
            "保健品",
            3760901,
            0.3,
            ("supplement", "vitamin", "capsule", "snack", "medical", "tea ", "保健", "食品", "药"),
            restricted=True,
            note_fa="مجوز غذا و دارو لازمه؛ برای فروشنده‌ی معمولی مناسب نیست.",
        ),
    ]
}

# Brands and phrases that invite a trademark or patent complaint. Naming a brand only
# to say "fits"/"compatible with" is usually allowed, but the product itself must not
# carry the brand, and a patented design can't be copied at all.
IP_WATCHLIST = (
    "drop stop",
    "stanley",
    "yeti",
    "owala",
    "hydro flask",
    "hydroflask",
    "magsafe",
    "apple",
    "airpods",
    "iphone case",
    "disney",
    "marvel",
    "pokemon",
    "sanrio",
    "hello kitty",
    "nike",
    "adidas",
    "lego",
    "dyson",
    "shark tank",
    "as seen on tv",
    "patented",
)


def find_category(key: str) -> Category:
    try:
        return CATEGORIES[key]
    except KeyError:
        known = ", ".join(CATEGORIES)
        raise ValueError(f"Unknown category {key!r}. Known: {known}") from None


def hunt_categories() -> list[Category]:
    """The categories a normal hunt goes through (the restricted ones are skipped)."""
    return [c for c in CATEGORIES.values() if not c.restricted]


def hunt_rotation(per_day: int, day_index: int | None = None) -> list[Category]:
    """The categories to hunt today. Instead of searching every category each day, the
    hunt walks a few categories at a time and cycles through them over the following days,
    so the catalog keeps filling across all of them. per_day<=0 (or >= all) hunts them all."""
    cats = hunt_categories()
    if per_day <= 0 or per_day >= len(cats):
        return cats
    if day_index is None:
        day_index = date.today().toordinal()
    batches = [cats[i : i + per_day] for i in range(0, len(cats), per_day)]
    return batches[day_index % len(batches)]


def _mentions(text: str, word: str) -> bool:
    if re.search(r"[一-鿿]", word):  # Chinese has no word boundaries
        return word in text
    return re.search(r"(?<![a-z])" + re.escape(word.strip()), text) is not None


def restricted_matches(title: str) -> list[Category]:
    """Restricted categories that a product's title points to."""
    text = f" {title.lower()} "
    return [
        c
        for c in CATEGORIES.values()
        if c.restricted and any(_mentions(text, w) for w in c.keywords)
    ]


def ip_matches(title: str) -> list[str]:
    text = f" {title.lower()} "
    return [w for w in IP_WATCHLIST if _mentions(text, w)]


def classify(title: str, hint: str = "") -> str:
    """Best category for a title; the hint (where it was found) wins unless the title
    clearly points to a restricted category."""
    restricted = restricted_matches(title)
    if restricted:
        return restricted[0].key
    if hint in CATEGORIES:
        return hint
    text = f" {title.lower()} "
    best, best_hits = "home_kitchen", 0
    for c in CATEGORIES.values():
        hits = sum(_mentions(text, w) for w in c.keywords)
        if hits > best_hits:
            best, best_hits = c.key, hits
    return best


_PACK_PATTERNS = (
    r"(\d+)\s*[- ]?(?:pack|pcs|pieces|pc|count|ct)\b",
    r"\bset of (\d+)\b",
    r"\bpack of (\d+)\b",
    r"(\d+)\s*(?:件|个|只|条)",
)


def pack_qty(title: str) -> int:
    """How many pieces one listing sells ("2 Pack", "set of 6"); 1 when it doesn't say."""
    text = title.lower()
    for pattern in _PACK_PATTERNS:
        m = re.search(pattern, text)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 50:
                return n
    return 1
