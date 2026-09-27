/* The sellers' site. Talks to hunter/app.py; with window.HUNTER_DEMO set (the preview
   page) it runs on bundled sample data instead and never calls the server. */
(function () {
  "use strict";

  var DEMO = window.HUNTER_DEMO || null;
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    config: null, me: null, hunt: null, picks: null, tab: "hunt",
    filter: { cat: "all", verdict: "all", sort: "score", fresh: false }, authMode: "signup", analysis: null, jobs: undefined,
  };

  var ERRORS = {
    not_logged_in: "اول وارد حسابت شو.",
    subscription_required: "این بخش برای مشترک‌هاست. از «حساب من» اشتراک بخر.",
    bad_email: "ایمیل درست نیست.",
    email_taken: "با این ایمیل قبلاً ثبت‌نام شده؛ وارد شو.",
    wrong_login: "ایمیل یا رمز عبور اشتباهه.",
    too_many_attempts: "تلاش زیاد بود؛ ده دقیقه دیگه دوباره امتحان کن.",
    no_online_payment: "پرداخت آنلاین هنوز فعال نشده؛ برای فعال‌سازی با پشتیبانی تماس بگیر.",
    gateway_error: "درگاه پرداخت جواب نداد؛ چند دقیقه دیگه دوباره امتحان کن.",
    no_hunt_yet: "هنوز شکاری انجام نشده.",
    network: "ارتباط با سرور برقرار نشد.",
  };
  var HASH_MESSAGES = {
    paid: "پرداخت انجام شد و اشتراکت فعاله. 🎉",
    "pay-cancelled": "پرداخت لغو شد.",
    "pay-failed": "پرداخت تأیید نشد. اگه پولی کم شده، ظرف ۷۲ ساعت برمی‌گرده.",
  };
  var VERDICT = {
    green: "شکار خوب", yellow: "با احتیاط", red: "نیار",
  };

  // --- helpers ----------------------------------------------------------------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : ""; }
  function usd(n) { return n == null ? "—" : "$" + Number(n).toFixed(2); }
  function cny(n) { return n == null ? "—" : "¥" + Number(n).toFixed(2); }
  function pct(n) { return n == null ? "—" : Math.round(n * 100) + "%"; }
  function count(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
  function toman(n) { return Number(n).toLocaleString("fa-IR"); }
  function faDate(iso) {
    try { return new Date(iso).toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" }); }
    catch (e) { return iso; }
  }
  function catName(key) {
    if (key === "manual") return "تحلیل دستی";
    var c = (state.config && state.config.categories || []).find(function (x) { return x.key === key; });
    return c ? c.fa : key;
  }
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 4500);
  }
  function errText(e) { return ERRORS[e && e.code] || (e && e.message) || ERRORS.network; }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: {}, credentials: "same-origin" };
    if (opts.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var detail = data && data.detail;
          var err = new Error(typeof detail === "string" ? detail : "خطا در ورودی‌ها");
          err.code = typeof detail === "string" ? detail : "invalid";
          err.status = r.status;
          throw err;
        }
        return data;
      });
    }, function () { var e = new Error(ERRORS.network); e.code = "network"; throw e; });
  }

  // --- loading ----------------------------------------------------------------

  function load() {
    if (DEMO) {
      state.config = DEMO.config; state.me = DEMO.me; state.hunt = DEMO.hunt;
      state.picks = DEMO.picks;
      return Promise.resolve();
    }
    return api("/api/config").then(function (c) {
      state.config = c;
      return api("/api/me").then(function (me) { state.me = me; }, function () { state.me = null; });
    }).then(loadHunt);
  }
  function loadHunt() {
    if (DEMO) return Promise.resolve();
    return api("/api/hunt").then(function (h) { state.hunt = h; }, function () { state.hunt = null; });
  }

  // --- rendering ----------------------------------------------------------------

  function render() {
    $("brand-name").textContent = (state.config && state.config.brand) || "شکارچی";
    var tabs = $("tabs");
    var loggedIn = !!state.me;
    tabs.hidden = !loggedIn;
    Array.prototype.forEach.call(tabs.querySelectorAll("button"), function (b) {
      b.setAttribute("aria-current", b.dataset.tab === state.tab ? "page" : "false");
    });
    var end = $("topbar-end");
    if (loggedIn) {
      end.innerHTML =
        (state.me.active
          ? '<span class="pill green"><span class="dot"></span>اشتراک فعال</span>'
          : '<span class="pill neutral">بدون اشتراک</span>') +
        (DEMO ? '<span class="pill yellow">نسخه‌ی نمایشی</span>'
              : '<button type="button" class="btn ghost small" id="logout">خروج</button>');
      var lo = $("logout");
      if (lo) lo.onclick = logout;
    } else {
      end.innerHTML = "";
    }
    var main = $("main");
    if (!loggedIn) { main.innerHTML = landingHTML(); bindLanding(); return; }
    if (state.tab === "picks") renderPicks();
    else if (state.tab === "analyze") { main.innerHTML = analyzeHTML(); bindAnalyze(); }
    else if (state.tab === "account") { main.innerHTML = accountHTML(); bindAccount(); }
    else { main.innerHTML = huntHTML(); bindHunt(); }
    bindCards(main);
  }

  function cardHTML(c) {
    var title = esc(c.title_fa || (c.listing && c.listing.title) || "");
    var initial = esc((c.title_fa || "?").trim().charAt(0));
    var head =
      '<div class="card-head">' +
        '<div class="thumb">' + (c.listing && imgSrc(c.listing.image_url)
          ? '<img src="' + esc(imgSrc(c.listing.image_url)) + '" alt="" loading="lazy" onerror="this.remove()">' : "") + initial + "</div>" +
        "<div><div class=\"card-title\">" + title + "</div>" +
          (c.listing && c.listing.title && c.title_fa ? '<div class="card-sub">' + esc(c.listing.title) + "</div>" : "") +
          '<div class="card-cat">' + esc(catName(c.category)) + ' · <span class="pill ' + c.verdict + '" style="padding:0 8px"><span class="dot"></span>' + VERDICT[c.verdict] + "</span>" +
            (c.is_new ? ' <span class="pill new">جدید امروز</span>' : "") + "</div></div>" +
        '<div class="score ' + c.verdict + '" title="امتیاز از ۱۰۰">' + c.score + "</div>" +
      "</div>";
    if (c.locked) {
      return '<article class="card locked">' + head +
        '<div class="ladder"><div class="rung"><div class="k">1688</div><div class="v">¥00.00</div></div><div class="rung"><div class="k">تا انبار</div><div class="v">$0.00</div></div><div class="rung ours"><div class="k">قیمت پیشنهادی</div><div class="v">$00.00</div></div></div>' +
        '<div class="compare"><div class="market"><div class="k">Temu</div><div class="v">$00.00</div></div><div class="market"><div class="k">آمازون</div><div class="v">$00.00</div></div></div>' +
        '<p class="lock-note">قیمت‌ها، مقایسه با Temu و آمازون، تأمین‌کننده و لینک خرید برای مشترک‌ها باز میشه.</p></article>';
    }
    var p = c.pricing, o = c.offer, l = c.listing;
    var ladder =
      '<div class="ladder">' +
        '<div class="rung"><div class="k">خرید از 1688</div><div class="v">' + cny(o.price_cny * c.pack_qty) + "</div></div>" +
        '<div class="rung"><div class="k">تمام‌شده تا انبار</div><div class="v">' + usd(p.landed_usd) + "</div></div>" +
        '<div class="rung ours"><div class="k">قیمت پیشنهادی</div><div class="v">' + usd(p.price_usd) + "</div></div>" +
      "</div>";
    var stats =
      '<div class="stats">' +
        '<div class="stat"><div class="k">سود هر عدد</div><div class="v">' + usd(p.profit_usd) + "</div></div>" +
        '<div class="stat"><div class="k">حاشیه‌ی سود</div><div class="v">' + pct(p.margin) + "</div></div>" +
        '<div class="stat"><div class="k">بازگشت سرمایه</div><div class="v">' + pct(p.roi) + "</div></div>" +
        '<div class="stat"><div class="k">حداقل سفارش</div><div class="v">' + count(o.moq) + "</div></div>" +
        '<div class="stat"><div class="k">سرمایه‌ی شروع (' + count(c.starter_qty) + ' عدد)</div><div class="v">' + usd(c.starter_capital_usd) + "</div></div>" +
        '<div class="stat"><div class="k">نسبت به قیمت کارخونه</div><div class="v">×' + p.multiplier + "</div></div>" +
      "</div>";
    var reasons = '<ul class="reasons">' +
      (c.pros || []).map(function (r) { return '<li class="pro"><span>' + esc(r) + "</span></li>"; }).join("") +
      (c.cons || []).map(function (r) { return '<li class="con"><span>' + esc(r) + "</span></li>"; }).join("") +
      "</ul>";
    var flags = (c.flags || []).length
      ? '<div class="flags">' + c.flags.map(function (f) { return '<div class="flag">⚠ ' + esc(f) + "</div>"; }).join("") + "</div>" : "";
    var costs =
      "<details><summary>ریز هزینه‌ها و قیمت</summary><table class=\"costs\"><tbody>" +
      row("قیمت کارخونه" + (c.pack_qty > 1 ? " (" + c.pack_qty + " عدد)" : ""), p.factory_usd) +
      row("ایجنت و حمل داخل چین", p.china_side_usd) +
      row("حمل تا انبار دبی (" + Number(c.weight_kg).toFixed(2) + " کیلو)", p.freight_usd) +
      row("بسته‌بندی", p.packaging_usd) +
      row("سهم ارسال به مشتری", p.last_mile_usd) +
      row("کمیسیون فروشگاه", p.platform_fee_usd) +
      row("درگاه پرداخت", p.gateway_usd) +
      row("تبلیغات", p.marketing_usd) +
      row("ذخیره‌ی مرجوعی", p.returns_reserve_usd) +
      '<tr class="total"><td>سود فروشنده</td><td>' + usd(p.profit_usd) + "</td></tr>" +
      "</tbody></table>" +
      '<p class="hint" style="font-size:12px;color:var(--ink-faint);margin:6px 0 0">کمترین قیمت با سود مطلوب: ' + usd(p.floor_usd) +
      " · سربه‌سر: " + usd(p.breakeven_usd) + "</p></details>";
    return '<article class="card">' + head + ladder + compareHTML(c) + stats + reasons + flags +
      supplierHTML(c) + costs + "</article>";
  }

  // The same product on Temu and Amazon, next to our price.
  function compareHTML(c) {
    var p = c.pricing, byMarket = {};
    [c.listing].concat(c.matches || []).forEach(function (x) { if (x && !byMarket[x.source]) byMarket[x.source] = x; });
    function box(name, market, price, ratio, estimated) {
      var x = byMarket[market];
      var demand = x ? (x.monthly_sold != null ? x.monthly_sold : x.sold_total != null ? Math.round(x.sold_total / 12) : null) : null;
      var link = x && safeUrl(x.url)
        ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + (/search/.test(x.url) ? "جستجو" : "آگهی") + " ↗</a>" : "";
      return '<div class="market"><div class="k">' + name + (estimated ? " (تخمینی)" : "") + "</div>" +
        '<div class="v"><span class="num">' + (price == null ? "—" : usd(price)) + "</span> " + chip(ratio) + "</div>" +
        '<div class="k">' + (demand != null ? "~" + count(demand) + " فروش در ماه" : (x || price != null ? "" : "پیدا نشد")) + (link ? " · " + link : "") + "</div></div>";
    }
    return '<div class="compare">' +
      box("Temu", "temu", p.benchmark_usd, p.vs_benchmark, p.benchmark_estimated) +
      box("آمازون", "amazon", p.amazon_usd, p.vs_amazon, false) +
      "</div>";
  }
  function chip(ratio) {
    if (ratio == null) return "";
    var d = Math.round((ratio - 1) * 100);
    var cls = ratio <= 1.0 ? "good" : ratio <= 1.1 ? "warn" : "bad";
    return '<span class="vs-chip ' + cls + '" title="قیمت ما نسبت به این بازار">' + (d > 0 ? "+" : "") + d + "%</span>";
  }

  // Exactly what to buy and from whom, with backups.
  var LEVEL = { gold: "طلایی", silver: "نقره‌ای", bronze: "برنزی", unknown: "نامشخص" };
  function levelPill(level) {
    if (!level || !level.key) return "";
    var cls = { gold: "green", silver: "neutral", bronze: "yellow", unknown: "neutral" }[level.key];
    return '<span class="pill ' + cls + '" title="امتیاز تأمین‌کننده ' + level.points + " از " + level.of + '">سطح تأمین‌کننده: ' + LEVEL[level.key] + "</span>";
  }

  // Exactly what to buy and from whom, with backups, shown here instead of on 1688.
  function supplierHTML(c) {
    var o = c.offer;
    var facts = [];
    if (o.is_factory != null) facts.push(o.is_factory ? "کارخانه" : "بازرگانی (واسطه)");
    if (o.location) facts.push(esc(o.location));
    if (o.years != null) facts.push(toman(o.years) + " سال در 1688");
    if (o.rating != null) facts.push("امتیاز " + o.rating);
    if (o.repurchase_rate != null) facts.push("خرید مجدد " + pct(o.repurchase_rate));
    if (o.sales != null) facts.push(count(o.sales) + " فروش");
    var alts = (c.alternatives || []).map(function (a) {
      return "<li>" + esc(a.shop_name || a.title) + ' — <span class="num">¥' + Number(a.price_cny).toFixed(2) + "</span>" +
        (a.sales != null ? " · " + count(a.sales) + " فروش" : "") + (a.is_factory ? " · کارخانه" : "") +
        (a.url ? ' <button type="button" class="linkbtn" data-offer="' + esc(a.url) + '" data-card="' + esc(c.id) + '">نمایش</button>' : "") + "</li>";
    }).join("");
    return '<div class="supplier">' +
      '<div class="label">تأمین‌کننده در 1688 ' + levelPill(c.level) + "</div>" +
      '<div class="shop">' + esc(o.shop_name || "نام فروشگاه در دسترس نیست") + "</div>" +
      (facts.length ? '<div class="facts">' + facts.map(function (f) { return "<bdi>" + f + "</bdi>"; }).join(" · ") + "</div>" : "") +
      (o.title ? '<div class="offer-title" title="اسم محصول در 1688">' + esc(o.title) + "</div>" : "") +
      tiersHTML(o) +
      '<div class="links">' +
        (o.url ? '<button type="button" class="btn small" data-offer="' + esc(o.url) + '" data-card="' + esc(c.id) + '">نمایش کامل محصول و تأمین‌کننده</button>' : "") +
        (o.url ? '<button type="button" class="btn ghost small" data-copy="' + esc(o.url) + '">کپی لینک برای ایجنت خرید</button>' : "") +
      "</div>" +
      (alts ? '<details class="alts"><summary>' + toman(c.alternatives.length) + " تأمین‌کننده‌ی جایگزین</summary><ul>" + alts + "</ul></details>" : "") +
      '<details class="howto"><summary>چطور بخرم؟</summary><ol>' +
        "<li>«کپی لینک برای ایجنت خرید» رو بزن و لینک رو برای ایجنتت بفرست؛ اسم چینی محصول هم بالا هست تا اشتباه نشه.</li>" +
        "<li>اول ۱ تا ۳ عدد نمونه بخر و جنس، اندازه و بسته‌بندی رو چک کن.</li>" +
        "<li>برای سفارش اصلی (حداقل " + count(c.starter_qty) + " عدد) قیمت پلکانی رو از تأمین‌کننده بپرس و عکس محموله قبل از ارسال بخواه.</li>" +
        "<li>ارسال به انبار دبی و منشأ «ساخت چین» در اسناد.</li>" +
      "</ol></details>" +
    "</div>";
  }
  function tiersHTML(o) {
    return (o.price_tiers || []).length
      ? '<div class="tiers">' + o.price_tiers.map(function (t) {
          return '<span>از <b class="num">' + count(t[0]) + '</b> عدد: <b class="num">¥' + Number(t[1]).toFixed(2) + "</b></span>";
        }).join("") + "</div>" : "";
  }

  // --- a 1688 offer, shown here (sellers in Iran can't open 1688) ------------------

  function imgSrc(u) { return DEMO || !safeUrl(u) ? "" : "/img?u=" + encodeURIComponent(u); }

  function findCard(id) {
    var all = [].concat(state.hunt && state.hunt.candidates || [], state.picks && state.picks.candidates || [],
      (state.jobs && state.jobs.items || []).map(function (j) { return j.result; }), state.analysis ? [state.analysis] : []);
    return all.find(function (c) { return c && c.id === id; });
  }

  function openOffer(url, card) {
    var box = $("offer-modal");
    if (!box) {
      box = document.createElement("div");
      box.id = "offer-modal"; box.className = "modal"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
      $("app").appendChild(box);
      box.addEventListener("click", function (ev) { if (ev.target === box || ev.target.dataset.close) box.hidden = true; });
      document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") box.hidden = true; });
    }
    box.hidden = false;
    var close = '<button type="button" class="btn ghost close" data-close="1">بستن</button>';
    box.innerHTML = '<div class="sheet"><p class="loading">در حال خوندن صفحه‌ی محصول از 1688…</p></div>';
    var got = DEMO ? Promise.resolve((DEMO.details || {})[url] || null) : api("/api/offer?url=" + encodeURIComponent(url));
    got.then(function (view) {
      box.innerHTML = '<div class="sheet">' + close + (view ? offerHTML(view, card, url) : '<p class="empty">جزئیات این محصول در دسترس نیست.</p>') + "</div>";
      bindCopy(box);
    }, function (e) {
      var msg = e.code === "details_not_configured" ? "نمایش جزئیات 1688 هنوز روی سایت فعال نشده." : errText(e);
      box.innerHTML = '<div class="sheet">' + close + '<p class="empty">' + esc(msg) + "</p></div>";
    });
  }

  function offerHTML(v, card, url) {
    var o = v.offer, main = card && card.offer && card.offer.url === url;
    var pics = (v.images || []).map(imgSrc).filter(Boolean);
    var gallery = pics.length
      ? '<div class="gallery">' + pics.slice(0, 8).map(function (src) { return '<img src="' + esc(src) + '" alt="" loading="lazy">'; }).join("") + "</div>"
      : '<div class="gallery no-pic">عکس‌های محصول اینجا نشون داده میشن (در داده‌ی نمونه عکس نیست)</div>';
    var p = card && card.pricing;
    var money = main && p
      ? '<div class="roi">' +
          '<div><span class="k">قیمت فروش پیشنهادی</span><b class="num">' + usd(p.price_usd) + "</b></div>" +
          '<div><span class="k">سود هر عدد</span><b class="num">' + usd(p.profit_usd) + "</b></div>" +
          '<div><span class="k">بازده سرمایه</span><b class="num">' + pct(p.roi) + "</b></div>" +
          '<div><span class="k">سرمایه‌ی شروع (' + count(card.starter_qty) + ' عدد)</span><b class="num">' + usd(card.starter_capital_usd) + "</b></div>" +
          '<div><span class="k">سود اولین محموله</span><b class="num">' + usd(p.profit_usd * card.starter_qty) + "</b></div>" +
        "</div>"
      : (card && card.offer ? '<p class="hint">تأمین‌کننده‌ی جایگزین: <span class="num">¥' + Number(o.price_cny).toFixed(2) +
          '</span> در برابر <span class="num">¥' + Number(card.offer.price_cny).toFixed(2) + "</span> تأمین‌کننده‌ی اصلی.</p>" : "");
    var attrs = (v.attributes_fa || []).map(function (a) { return "<tr><td>" + esc(a[0]) + "</td><td>" + esc(a[1]) + "</td></tr>"; }).join("");
    var skus = (v.skus_fa || []).map(function (k) {
      return "<tr><td>" + esc(k.name_fa || k.name) + (k.name_fa ? ' <span class="zh">' + esc(k.name) + "</span>" : "") + '</td><td class="num">' +
        (k.price_cny != null ? "¥" + Number(k.price_cny).toFixed(2) : "—") + '</td><td class="num">' + (k.stock != null ? count(k.stock) : "—") + "</td></tr>";
    }).join("");
    var facts = [o.location && esc(o.location), o.years != null && toman(o.years) + " سال در 1688",
      o.is_factory != null && (o.is_factory ? "کارخانه" : "بازرگانی"), o.rating != null && "امتیاز " + o.rating,
      o.repurchase_rate != null && "خرید مجدد " + pct(o.repurchase_rate), o.sales != null && count(o.sales) + " فروش"].filter(Boolean);
    return '<div class="offer">' + gallery +
      '<div class="offer-body">' +
        '<h2 class="section-title">' + esc(v.title_fa || (main && card.title_fa) || o.title) + "</h2>" +
        '<p class="zh">' + esc(o.title) + "</p>" +
        money +
        '<h3 class="sub">تأمین‌کننده ' + levelPill(v.level) + "</h3>" +
        "<p><b>" + esc(o.shop_name || "—") + "</b>" + (facts.length ? " · " + facts.map(function (f) { return "<bdi>" + f + "</bdi>"; }).join(" · ") : "") + "</p>" +
        ((v.badges_fa || []).length ? '<div class="badges">' + v.badges_fa.map(function (b) { return '<span class="pill neutral">' + esc(b) + "</span>"; }).join("") + "</div>" : "") +
        '<h3 class="sub">قیمت و حداقل سفارش</h3><p>حداقل سفارش: <b class="num">' + count(o.moq) + "</b> عدد</p>" + tiersHTML(o) +
        (skus ? '<h3 class="sub">مدل‌ها</h3><div class="scroll"><table class="costs"><thead><tr><td>مدل</td><td>قیمت</td><td>موجودی</td></tr></thead><tbody>' + skus + "</tbody></table></div>" : "") +
        (attrs ? '<h3 class="sub">مشخصات</h3><div class="scroll"><table class="costs specs"><tbody>' + attrs + "</tbody></table></div>" : "") +
        '<div class="links" style="margin-top:12px"><button type="button" class="btn small" data-copy="' + esc(url) + '">کپی لینک برای ایجنت خرید</button></div>' +
      "</div></div>";
  }

  function bindCopy(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll("[data-copy]"), function (b) {
      b.onclick = function () {
        var text = b.dataset.copy;
        var shown = function () { toast("لینک: " + text); };
        if (!navigator.clipboard) { shown(); return; }
        navigator.clipboard.writeText(text).then(function () { toast("لینک کپی شد؛ برای ایجنت خریدت بفرست."); }, shown);
      };
    });
  }
  function bindCards(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll("[data-offer]"), function (b) {
      b.onclick = function () { openOffer(b.dataset.offer, findCard(b.dataset.card)); };
    });
    bindCopy(root);
  }
  function row(k, v) { return "<tr><td>" + esc(k) + "</td><td>" + usd(v) + "</td></tr>"; }

  // --- landing -------------------------------------------------------------------

  function landingHTML() {
    var cfg = state.config || {};
    var teaser = state.hunt && state.hunt.candidates || [];
    var plans = (cfg.plans || []).map(function (p) {
      return '<div class="plan"><div class="label">' + esc(p.name_fa) + '</div><div class="price">' + toman(p.price_toman) +
        ' <small>تومان</small></div><div class="hint" style="color:var(--ink-soft);font-size:13px">' + toman(p.days) + " روز: شکار روزانه، شکارهای اختصاصی و " + toman(p.links) + " تحلیل محصول</div></div>";
    }).join("");
    return (
      '<section class="hero">' +
        "<div>" +
          "<h1>هر روز، محصولی که ارزش آوردن از چین رو داره — با قیمت فروش آماده</h1>" +
          "<p>موتور ما پرفروش‌های Temu و آمازون رو می‌گرده، همون جنس رو با عکس در 1688 پیدا می‌کنه، همه‌ی هزینه‌ها تا انبار دبی و تحویل به مشتری رو حساب می‌کنه و قیمتی پیشنهاد می‌ده که هم از Temu ارزون‌تر باشه هم برای تو سود بمونه. هر محصول فقط به چند فروشنده داده میشه تا با هم رقابت نکنید.</p>" +
          '<ol class="chain"><li>پرفروش Temu</li><li class="arrow">←</li><li>تأمین‌کننده در 1688</li><li class="arrow">←</li><li>هزینه تا انبار دبی</li><li class="arrow">←</li><li>قیمت پیشنهادی</li><li class="arrow">←</li><li>سبز / زرد / قرمز</li></ol>' +
          '<div class="plans">' + plans + "</div>" +
        "</div>" +
        '<div class="panel auth">' + authHTML() + "</div>" +
      "</section>" +
      (teaser.length
        ? '<h2 class="section-title">نمونه‌ی شکارهای امروز</h2><p class="section-sub">جزئیات، قیمت‌ها و لینک تأمین‌کننده بعد از خرید اشتراک باز میشه.</p><div class="grid">' +
          teaser.map(cardHTML).join("") + "</div>"
        : "")
    );
  }
  function authHTML() {
    var signup = state.authMode === "signup";
    return '<div class="auth-tabs"><button type="button" data-mode="signup" aria-pressed="' + signup + '">ثبت‌نام</button>' +
      '<button type="button" data-mode="login" aria-pressed="' + !signup + '">ورود</button></div>' +
      '<form id="auth-form" novalidate>' +
        (signup ? field("name", "نام و نام خانوادگی", "text", "name") + field("phone", "موبایل (برای رسید پرداخت)", "tel", "tel") : "") +
        field("email", "ایمیل", "email", "email") +
        field("password", "رمز عبور" + (signup ? " (حداقل ۸ حرف)" : ""), "password", signup ? "new-password" : "current-password") +
        '<div class="error" id="auth-error"></div>' +
        '<button class="btn" type="submit">' + (signup ? "ساخت حساب" : "ورود") + "</button>" +
      "</form>";
  }
  function field(id, label, type, ac) {
    return '<div class="field"><label for="f-' + id + '">' + label + '</label><input class="input" id="f-' + id + '" name="' + id + '" type="' + type + '" autocomplete="' + ac + '" dir="auto"></div>';
  }
  function bindLanding() {
    Array.prototype.forEach.call(document.querySelectorAll(".auth-tabs button"), function (b) {
      b.onclick = function () { state.authMode = b.dataset.mode; render(); };
    });
    $("auth-form").onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target, body = { email: f.email.value, password: f.password.value };
      if (state.authMode === "signup") { body.name = f.name.value; body.phone = f.phone.value; }
      $("auth-error").textContent = "";
      api("/api/" + state.authMode, { method: "POST", body: body }).then(function (me) {
        state.me = me; state.tab = me.active ? "hunt" : "account";
        return loadHunt();
      }).then(render, function (e) {
        $("auth-error").textContent = e.code === "invalid" ? "همه‌ی خونه‌ها رو درست پر کن (رمز حداقل ۸ حرف)." : errText(e);
      });
    };
  }

  // --- hunt tab ------------------------------------------------------------------

  function huntHTML() {
    var h = state.hunt;
    if (!h) return '<div class="empty">هنوز شکاری انجام نشده. مدیر سایت باید دستور <span class="num">python -m hunter hunt</span> رو اجرا کنه.</div>';
    var counts = h.counts || {};
    var head =
      '<h1 class="section-title">شکارهای امروز</h1>' +
      '<p class="section-sub">آخرین جستجو: ' + esc(faDate(h.started_at)) + ". هر محصول با قیمت واقعی Temu مقایسه شده؛ سبزها رو می‌شه با خیال راحت آورد.</p>" +
      (h.sample ? '<div class="notice"><b>داده‌ی نمونه:</b> ' + esc(h.note || "این اعداد برای نمایش‌ان.") + "</div>" : "") +
      '<div class="summary">' +
        '<span class="pill green"><span class="dot"></span>' + (counts.green || 0) + " شکار خوب</span>" +
        '<span class="pill yellow"><span class="dot"></span>' + (counts.yellow || 0) + " با احتیاط</span>" +
        '<span class="pill red"><span class="dot"></span>' + (counts.red || 0) + " نیار</span>" +
        (h.candidates.some(function (c) { return c.is_new; })
          ? '<span class="pill new">' + toman(h.candidates.filter(function (c) { return c.is_new; }).length) + " محصول جدید امروز</span>" : "") +
      "</div>";
    if (h.locked) {
      return head + '<div class="notice"><b>اشتراک نداری.</b> فقط چند نمونه قفل‌شده می‌بینی. از «حساب من» اشتراک بخر.</div><div class="grid">' +
        h.candidates.map(cardHTML).join("") + "</div>";
    }
    var cats = {};
    h.candidates.forEach(function (c) { cats[c.category] = true; });
    var f = state.filter;
    var list = h.candidates.filter(function (c) {
      return (f.cat === "all" || c.category === f.cat) && (f.verdict === "all" || c.verdict === f.verdict) && (!f.fresh || c.is_new);
    });
    var sorters = {
      score: function (a, b) { return b.score - a.score; },
      margin: function (a, b) { return b.pricing.margin - a.pricing.margin; },
      capital: function (a, b) { return a.starter_capital_usd - b.starter_capital_usd; },
    };
    if (f.sort !== "score") list = list.slice().sort(sorters[f.sort]);
    var filters =
      '<div class="filters">' +
        '<div class="field"><label for="flt-cat">دسته</label><select class="input" id="flt-cat"><option value="all">همه‌ی دسته‌ها</option>' +
          Object.keys(cats).map(function (k) { return '<option value="' + esc(k) + '"' + (f.cat === k ? " selected" : "") + ">" + esc(catName(k)) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label for="flt-sort">مرتب‌سازی</label><select class="input" id="flt-sort">' +
          '<option value="score"' + (f.sort === "score" ? " selected" : "") + ">بهترین‌ها اول</option>" +
          '<option value="margin"' + (f.sort === "margin" ? " selected" : "") + ">بیشترین حاشیه‌ی سود</option>" +
          '<option value="capital"' + (f.sort === "capital" ? " selected" : "") + ">کمترین سرمایه‌ی شروع</option></select></div>" +
        '<div class="field"><span class="label">وضعیت</span><div class="chips" id="flt-verdict">' +
          [["all", "همه"], ["green", "شکار خوب"], ["yellow", "با احتیاط"], ["red", "نیار"]].map(function (v) {
            return '<button type="button" data-v="' + v[0] + '" aria-pressed="' + (f.verdict === v[0]) + '">' + v[1] + "</button>";
          }).join("") + "</div></div>" +
        '<div class="field"><span class="label">فقط جدیدها</span><div class="chips"><button type="button" id="flt-new" aria-pressed="' + f.fresh + '">جدید امروز</button></div></div>' +
      "</div>";
    return head + filters + (list.length ? '<div class="grid">' + list.map(cardHTML).join("") + "</div>" : '<div class="empty">چیزی با این فیلتر پیدا نشد.</div>');
  }
  function bindHunt() {
    var cat = $("flt-cat"), sort = $("flt-sort"), v = $("flt-verdict");
    if (cat) cat.onchange = function () { state.filter.cat = cat.value; render(); };
    if (sort) sort.onchange = function () { state.filter.sort = sort.value; render(); };
    if (v) Array.prototype.forEach.call(v.querySelectorAll("button"), function (b) {
      b.onclick = function () { state.filter.verdict = b.dataset.v; render(); };
    });
    var fresh = $("flt-new");
    if (fresh) fresh.onclick = function () { state.filter.fresh = !state.filter.fresh; render(); };
  }

  // --- picks tab -----------------------------------------------------------------

  function renderPicks() {
    var main = $("main");
    if (!state.me.active) { main.innerHTML = lockedHTML(); bindLocked(); return; }
    if (!state.picks && !DEMO) {
      main.innerHTML = '<p class="loading">در حال انتخاب محصول برای تو…</p>';
      api("/api/picks").then(function (p) { state.picks = p; render(); }, function (e) {
        main.innerHTML = '<div class="empty">' + esc(errText(e)) + "</div>";
      });
      return;
    }
    var p = state.picks || { candidates: [] };
    main.innerHTML =
      '<h1 class="section-title">شکارهای اختصاصی من</h1>' +
      '<p class="section-sub">از بین شکارهای امروز، این‌ها با دسته‌هایی که انتخاب کردی و بودجه‌ات جور درمیان. هر محصول حداکثر به ' +
        toman(p.per_product || 3) + " فروشنده داده میشه تا با هم رقابت نکنید. دسته‌ها و بودجه رو از «حساب من» عوض کن.</p>" +
      '<div class="summary"><span class="pill neutral">بودجه: <span class="num">' + usd(p.budget_usd) + '</span></span><span class="pill neutral">سرمایه‌ی لازم برای همه: <span class="num">' +
        usd(p.capital_usd) + "</span></span></div>" +
      (p.candidates.length ? '<div class="grid">' + p.candidates.map(cardHTML).join("") + "</div>"
        : '<div class="empty">فعلاً محصولی با دسته‌ها و بودجه‌ی تو جور نشد. دسته‌های بیشتری انتخاب کن یا فردا دوباره سر بزن.</div>');
  }

  function lockedHTML() {
    return '<div class="empty">این بخش برای مشترک‌هاست.<br><button type="button" class="btn" id="go-account" style="margin-top:12px">خرید اشتراک</button></div>';
  }
  function bindLocked() { var b = $("go-account"); if (b) b.onclick = function () { go("account"); }; }

  // --- analyze tab ---------------------------------------------------------------

  var LINK_ERRORS = {
    unsupported_link: "فقط لینک محصول Temu یا آمازون قبول میشه.",
    listing_not_found: "محصولی با این لینک پیدا نشد.",
    listing_error: "صفحه‌ی محصول خونده نشد؛ دوباره امتحان کن.",
    amazon_site_not_supported: "این نسخه‌ی آمازون پشتیبانی نمیشه؛ لینک amazon.com بده.",
    temu_links_not_configured: "تحلیل لینک Temu هنوز روی سایت فعال نشده.",
    no_supplier: "همین محصول در 1688 پیدا نشد.",
    supplier_error: "جستجو در 1688 جواب نداد؛ دوباره امتحان کن.",
    unprofitable_settings: "با تنظیمات فعلی هیچ قیمتی سود نمیده.",
    interrupted: "سرور وسط کار راه‌اندازی مجدد شد؛ لینک رو دوباره بفرست.",
    analysis_error: "تحلیل با خطا روبه‌رو شد.",
  };
  var STATUS = { queued: ["neutral", "در صف"], running: ["yellow", "در حال تحلیل…"], done: ["green", "انجام شد"], failed: ["red", "ناموفق"] };

  function analyzeHTML() {
    if (!state.me.active) return lockedHTML();
    var cfg = state.config, a = state.analysis, jobs = state.jobs;
    var examples = (cfg.example_links || []).length
      ? '<div class="field"><span class="label">لینک‌های نمونه برای امتحان:</span><div class="examples">' +
          cfg.example_links.map(function (u) { return '<button type="button" data-link="' + esc(u) + '">' + esc(u) + "</button>"; }).join("") +
        "</div></div>" : "";
    var linksPart = cfg.links
      ? '<form class="panel links-form stack" id="links-form" novalidate>' +
          '<div class="field"><label for="links">لینک محصول‌های Temu یا آمازون (هر خط یه لینک، حداکثر ' + toman(cfg.links_per_request) + " تا)</label>" +
          '<textarea class="input" id="links" placeholder="https://www.temu.com/...&#10;https://www.amazon.com/dp/..."></textarea>' +
          '<span class="hint">برای هر لینک، موتور همون محصول رو در 1688 پیدا می‌کنه، تأمین‌کننده رو مشخص می‌کنه، با Temu و آمازون مقایسه می‌کنه و قیمت فروش پیشنهاد می‌ده. ' +
          (jobs ? "این ماه " + toman(jobs.left) + " تحلیل دیگه داری (از " + toman(jobs.quota || cfg.monthly_links) + " تا). محصولی که قبلاً تحلیل شده فوری و بدون هزینه جواب می‌گیره." : "") + "</span></div>" +
          examples +
          '<div class="error" id="links-error"></div><button class="btn" type="submit">تحلیل کن</button>' +
        "</form>" +
        '<div class="jobs" id="jobs">' + jobsHTML() + "</div>"
      : '<div class="notice"><b>تحلیل با لینک هنوز فعال نشده.</b> مدیر سایت باید کلید Keepa یا Apify رو تنظیم کنه. فعلاً از تحلیل دستی پایین استفاده کن.</div>';
    return '<h1 class="section-title">تحلیل محصول‌های خودم</h1>' +
      '<p class="section-sub">محصولی که خودت پیدا کردی رو بفرست تا کامل تحلیل بشه: تأمین‌کننده در 1688، مقایسه با Temu و آمازون، همه‌ی هزینه‌ها و قیمت فروش.</p>' +
      linksPart +
      '<details class="manual"' + (cfg.links ? "" : " open") + "><summary>تحلیل دستی (اگه لینک نداری و قیمت‌ها رو خودت می‌دونی)</summary>" +
      '<form class="panel" id="an-form" novalidate><div class="form-grid">' +
        '<div class="field" style="grid-column:1/-1"><label for="an-title">اسم یا عنوان آگهی (برای تشخیص دسته و محدودیت‌ها)</label><input class="input" id="an-title" dir="auto" placeholder="مثلاً: Car Seat Gap Filler 2 Pack"></div>' +
        num("an-cny", "قیمت هر عدد در 1688 (یوان)", "12", "0.1") +
        num("an-weight", "وزن هر آگهی با بسته‌بندی (کیلو)", "0.4", "0.01") +
        num("an-temu", "قیمت همین محصول در Temu (دلار)", "11.99", "0.01") +
        num("an-amazon", "قیمت همین محصول در آمازون (دلار)", "", "0.01") +
        num("an-lpack", "چند عدد در هر آگهی؟", "1", "1") +
        num("an-moq", "حداقل سفارش در 1688", "10", "1") +
        num("an-sold", "فروش ماهانه (اختیاری)", "", "1") +
        num("an-reviews", "تعداد نظرهای رقیب اصلی (اختیاری)", "", "1") +
        num("an-cart", "معمولاً چند قلم در هر سفارش؟", "3", "1") +
        '<div class="field"><label for="an-market">مشتری چطور پول می‌ده؟</label><select class="input" id="an-market"><option value="prepaid">آنلاین (مثل Temu)</option><option value="cod">پرداخت در محل</option></select></div>' +
      '</div><div class="error" id="an-error"></div><button class="btn" type="submit">تحلیل کن</button></form>' +
      (a ? '<div style="margin-top:18px" class="grid">' + cardHTML(a) + "</div>" : "") +
      "</details>";
  }

  function jobsHTML() {
    var items = state.jobs && state.jobs.items || [];
    if (!items.length) return "";
    return '<h2 class="section-title" style="font-size:16px">تحلیل‌های من</h2>' + items.map(function (j) {
      var st = STATUS[j.status] || STATUS.queued;
      var cached = j.result && j.result.from_cache ? '<span class="pill neutral">از قبل تحلیل شده بود</span>' : "";
      var head = '<div class="job"><span class="url">' + esc(j.url) + "</span>" + cached + '<span class="pill ' + st[0] + '"><span class="dot"></span>' + st[1] + "</span></div>";
      if (j.status === "done" && j.result) return '<div>' + head + '<div class="job-result grid">' + cardHTML(j.result) + "</div></div>";
      if (j.status === "failed") return '<div>' + head + '<p class="error" style="margin:4px 4px 0">' + esc(LINK_ERRORS[j.error] || j.error || "") + "</p></div>";
      return head;
    }).join("");
  }

  function loadJobs() {
    if (DEMO) return Promise.resolve();
    return api("/api/analyses").then(function (j) { state.jobs = j; }, function () {});
  }
  function pollJobs() {
    clearTimeout(pollJobs.timer);
    var pending = (state.jobs && state.jobs.items || []).some(function (j) { return j.status === "queued" || j.status === "running"; });
    if (!pending || state.tab !== "analyze") return;
    pollJobs.timer = setTimeout(function () {
      loadJobs().then(function () { var box = $("jobs"); if (box && state.tab === "analyze") { box.innerHTML = jobsHTML(); bindCards(box); } pollJobs(); });
    }, 4000);
  }

  function num(id, label, value, step) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input num" id="' + id + '" type="number" min="0" step="' + step + '" value="' + value + '"></div>';
  }
  function bindAnalyze() {
    var form = $("an-form");
    if (!form) { bindLocked(); return; }
    if (state.jobs === undefined && !DEMO && state.config.links) {
      state.jobs = null;
      loadJobs().then(function () { if (state.tab === "analyze") { $("jobs").innerHTML = jobsHTML(); pollJobs(); } });
    } else {
      pollJobs();
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-link]"), function (b) {
      b.onclick = function () { var t = $("links"); t.value = (t.value.trim() ? t.value.trim() + "\n" : "") + b.dataset.link; };
    });
    var lf = $("links-form");
    if (lf) lf.onsubmit = function (ev) {
      ev.preventDefault();
      var urls = $("links").value.split(/\s+/).filter(function (u) { return /^https?:\/\//i.test(u); });
      $("links-error").textContent = "";
      if (!urls.length) { $("links-error").textContent = "حداقل یه لینک درست (با https://) بذار."; return; }
      if (DEMO) { state.jobs = demoLinks(urls); render(); return; }
      api("/api/analyses", { method: "POST", body: { urls: urls } }).then(function () {
        $("links").value = "";
        return loadJobs();
      }).then(function () { render(); }, function (e) {
        $("links-error").textContent = e.code === "monthly_limit" ? "سهمیه‌ی تحلیل این ماهت کافی نیست؛ لینک کمتری بفرست یا بعداً امتحان کن."
          : e.code === "too_many_links" ? "حداکثر " + toman(state.config.links_per_request) + " لینک در هر بار." : errText(e);
      });
    };
    form.onsubmit = function (ev) {
      ev.preventDefault();
      var v = function (id) { var x = $(id).value; return x === "" ? null : Number(x); };
      var body = {
        title: $("an-title").value, price_cny: v("an-cny"), weight_kg: v("an-weight"),
        temu_price_usd: v("an-temu"), amazon_price_usd: v("an-amazon"), listing_pack: v("an-lpack") || 1, moq: v("an-moq") || 1,
        monthly_sold: v("an-sold"), reviews: v("an-reviews"), items_per_cart: v("an-cart") || 3,
        market: $("an-market").value,
      };
      $("an-error").textContent = "";
      if (!body.price_cny || !body.weight_kg) { $("an-error").textContent = "قیمت 1688 و وزن لازمه."; return; }
      var ids = ["an-title", "an-cny", "an-weight", "an-temu", "an-amazon", "an-lpack", "an-moq", "an-sold", "an-reviews", "an-cart", "an-market"];
      var done = function (res) {
        var typed = {};
        ids.forEach(function (id) { typed[id] = $(id).value; });
        state.analysis = res; render();
        document.querySelector(".manual").open = true;
        ids.forEach(function (id) { $(id).value = typed[id]; });  // keep what was typed
      };
      if (DEMO) { done(demoAnalyze(body)); return; }
      api("/api/analyze", { method: "POST", body: body }).then(done, function (e) { $("an-error").textContent = errText(e); });
    };
  }

  // In the demo there's no server: links are looked up in the sample hunt.
  function demoLinks(urls) {
    var known = {};
    state.hunt.candidates.forEach(function (c) {
      [c.listing].concat(c.matches || []).forEach(function (x) { known[x.url] = c; });
    });
    var items = urls.map(function (u) {
      var c = known[u];
      return c ? { url: u, status: "done", result: c } : { url: u, status: "failed", error: /temu\.com|amazon\./.test(u) ? "listing_not_found" : "unsupported_link" };
    });
    var prev = (state.jobs && state.jobs.items) || [];
    var quota = (state.config.plans.find(function (p) { return p.id === state.me.plan; }) || {}).links || state.config.monthly_links;
    return { items: items.concat(prev), quota: quota, left: Math.max(0, quota - items.length - prev.length) };
  }

  // --- account tab ---------------------------------------------------------------

  function accountHTML() {
    var me = state.me, cfg = state.config;
    var cats = cfg.categories.map(function (c) {
      var on = me.categories.indexOf(c.key) >= 0;
      return c.restricted
        ? '<label class="check off" title="' + esc(c.note_fa) + '"><input type="checkbox" disabled> ' + esc(c.fa) + " (محدود)</label>"
        : '<label class="check"><input type="checkbox" name="cat" value="' + esc(c.key) + '"' + (on ? " checked" : "") + "> " + esc(c.fa) + "</label>";
    }).join("");
    var current = cfg.plans.find(function (p) { return p.id === me.plan; });
    var status = me.active
      ? (me.is_admin ? "مدیر سایت: دسترسی کامل." : "اشتراک" + (current ? " «" + esc(current.name_fa) + "»" : "") + " تا " + esc(faDate(me.paid_until)) + " فعاله.")
      : "اشتراک فعالی نداری.";
    var plans = cfg.plans.map(function (p) {
      return '<div class="plan' + (current && current.id === p.id ? " current" : "") + '"><div class="label">' + esc(p.name_fa) + '</div><div class="price">' + toman(p.price_toman) + ' <small>تومان در ماه</small></div>' +
        '<div class="hint" style="color:var(--ink-soft);font-size:13px">' + toman(p.links) + " تحلیل محصول در ماه، به‌علاوه‌ی شکار روزانه و شکارهای اختصاصی</div>" +
        '<button type="button" class="btn" data-plan="' + esc(p.id) + '"' + (cfg.online_payment ? "" : " disabled") + ">" + (current && current.id === p.id ? "تمدید" : "خرید") + " با درگاه</button></div>";
    }).join("");
    return '<div class="stack">' +
      '<section class="panel"><h2 class="section-title">اشتراک</h2><p class="section-sub">' + status + "</p>" +
        '<div class="plans">' + plans + "</div>" +
        (cfg.online_payment ? "" : '<p class="hint" style="color:var(--ink-soft);font-size:13px">پرداخت آنلاین هنوز فعال نشده؛ بعد از کارت‌به‌کارت، پشتیبانی اشتراکت رو فعال می‌کنه.</p>') +
        '<div class="error" id="pay-error"></div></section>' +
      '<form class="panel" id="profile-form"><h2 class="section-title">مشخصات و علاقه‌مندی</h2>' +
        '<p class="section-sub">شکارهای اختصاصی از روی این دسته‌ها و بودجه‌ات انتخاب میشن. هیچ دسته‌ای نزنی یعنی همه.</p>' +
        '<div class="form-grid" style="margin-bottom:14px">' +
          '<div class="field"><label for="p-name">نام</label><input class="input" id="p-name" value="' + esc(me.name) + '"></div>' +
          '<div class="field"><label for="p-phone">موبایل</label><input class="input num" id="p-phone" value="' + esc(me.phone) + '"></div>' +
          '<div class="field"><label for="p-budget">بودجه‌ی شروع (دلار)</label><input class="input num" id="p-budget" type="number" min="0" step="50" value="' + esc(me.budget_usd) + '"><span class="hint">هزینه‌ی اولین محموله‌ی همه‌ی محصولات با هم</span></div>' +
        "</div>" +
        '<div class="label" style="margin-bottom:6px">دسته‌هایی که کار می‌کنی</div><div class="cats">' + cats + "</div>" +
        '<div class="error" id="profile-error"></div><button class="btn" type="submit">ذخیره</button></form>' +
    "</div>";
  }
  function bindAccount() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-plan]"), function (b) {
      b.onclick = function () {
        if (DEMO) { toast("در نسخه‌ی واقعی اینجا به درگاه زرین‌پال می‌ری."); return; }
        b.disabled = true;
        api("/api/pay", { method: "POST", body: { plan: b.dataset.plan } }).then(function (r) {
          window.location.href = r.redirect_url;
        }, function (e) { b.disabled = false; $("pay-error").textContent = errText(e); });
      };
    });
    $("profile-form").onsubmit = function (ev) {
      ev.preventDefault();
      var cats = Array.prototype.map.call(document.querySelectorAll('input[name="cat"]:checked'), function (x) { return x.value; });
      var body = { name: $("p-name").value, phone: $("p-phone").value, categories: cats, budget_usd: Number($("p-budget").value || 0) };
      if (DEMO) { Object.assign(state.me, body); toast("ذخیره شد (نسخه‌ی نمایشی)."); return; }
      api("/api/me", { method: "PUT", body: body }).then(function (me) {
        state.me = me; state.picks = null; toast("ذخیره شد.");
      }, function (e) { $("profile-error").textContent = errText(e); });
    };
  }

  // --- demo-only analysis (mirrors hunter/pricing.py and hunter/scoring.py) --------

  function demoAnalyze(b) {
    var cfg = state.config.pricing;
    var returns = b.market === "cod" ? 0.22 : cfg.returns_pct;
    var cuts = cfg.platform_pct + cfg.gateway_pct + cfg.marketing_pct + returns;
    var keep = 1 - cuts;
    var units = Math.max(1, b.listing_pack || 1);
    var factory = b.price_cny * units / cfg.cny_per_usd;
    var china = factory * cfg.china_side_pct, freight = b.weight_kg * cfg.freight_usd_per_kg;
    var landed = factory + china + freight + cfg.packaging_usd;
    var tier = cfg.last_mile_usd.find(function (t) { return t[0] === null || b.weight_kg <= t[0]; });
    var lastMile = tier[1] / Math.max(1, b.items_per_cart);
    var unit = landed + lastMile;
    var floor = unit / (keep - cfg.target_margin);
    var charm = function (x) { return Math.ceil((x + 0.01) * 2) / 2 - 0.01; };
    var charmDown = function (x) { return Math.floor((x + 0.01) * 2) / 2 - 0.01; };
    var price = charm(floor);
    if (b.temu_price_usd) { var under = charmDown(b.temu_price_usd * (1 - cfg.undercut)); if (under >= floor) price = under; }
    var profit = price * keep - unit, margin = profit / price;
    var ratio = b.temu_price_usd ? price / b.temu_price_usd : null;
    var vsAmazon = b.amazon_price_usd ? price / b.amazon_price_usd : null;
    var score = 0, pros = [], cons = [];
    var d = b.monthly_sold;
    if (d == null) { score += 10; cons.push("آمار فروش ماهانه وارد نشده"); }
    else if (d >= 3000) { score += 25; pros.push("تقاضای خیلی بالا"); }
    else if (d >= 1000) { score += 20; pros.push("تقاضای خوب"); }
    else if (d >= 300) { score += 14; pros.push("تقاضای متوسط"); }
    else { score += 4; cons.push("تقاضای کم"); }
    if (margin >= 0.30) score += 25; else if (margin >= 0.22) score += 20; else if (margin >= 0.15) score += 14; else if (margin >= 0.08) score += 6;
    (margin >= 0.15 ? pros : cons).push("حاشیه‌ی سود " + Math.round(margin * 100) + "%");
    if (ratio == null) { score += 8; cons.push("قیمت Temu وارد نشده"); }
    else if (ratio <= 0.97) { score += 20; pros.push("ارزان‌تر از Temu"); }
    else if (ratio <= 1.03) { score += 15; pros.push("هم‌قیمت Temu"); }
    else if (ratio <= 1 + cfg.max_premium) { score += 8; cons.push(Math.round((ratio - 1) * 100) + "% گران‌تر از Temu"); }
    else cons.push("کمترین قیمتی که سود می‌ده " + Math.round((ratio - 1) * 100) + "% بالاتر از Temuه؛ رقابتی نیست");
    if (vsAmazon != null && vsAmazon <= 0.7) { score += 5; pros.push(Math.round((1 - vsAmazon) * 100) + "% ارزان‌تر از آمازون"); }
    else if (vsAmazon != null && vsAmazon > 1) { score -= 5; cons.push("از آمازون هم گران‌تره"); }
    score += b.reviews == null ? 5 : b.reviews < 500 ? 10 : b.reviews < 3000 ? 6 : 2;
    score += b.weight_kg <= 0.5 ? 10 : b.weight_kg <= 2 ? 6 : 2;
    score += 4;
    var tooDear = ratio != null && ratio > 1 + cfg.max_premium;
    var verdict = tooDear || margin < 0.08 ? "red"
      : score >= 70 && margin >= 0.15 && (ratio == null || ratio <= 1.03) ? "green" : score >= 50 ? "yellow" : "red";
    var starter = Math.max(b.moq || 1, cfg.min_starter_qty);
    var r2 = function (x) { return Math.round(x * 100) / 100; };
    return {
      id: "analyze", category: "manual", title_fa: b.title || "محصول من", pack_qty: units, weight_kg: b.weight_kg,
      listing: { source: "temu", title: "", url: "", image_url: "", monthly_sold: b.monthly_sold },
      offer: { price_cny: b.price_cny, moq: b.moq || 1, url: "", shop_name: "", price_tiers: [] }, matches: [], alternatives: [],
      pricing: {
        factory_usd: r2(factory), china_side_usd: r2(china), freight_usd: r2(freight), packaging_usd: cfg.packaging_usd,
        landed_usd: r2(landed), last_mile_usd: r2(lastMile), price_usd: r2(price), floor_usd: r2(floor),
        breakeven_usd: r2(unit / keep), platform_fee_usd: r2(price * cfg.platform_pct), gateway_usd: r2(price * cfg.gateway_pct),
        marketing_usd: r2(price * cfg.marketing_pct), returns_reserve_usd: r2(price * returns), profit_usd: r2(profit),
        margin: margin, roi: profit / landed, multiplier: r2(price / factory), benchmark_usd: b.temu_price_usd,
        benchmark_estimated: false, vs_benchmark: ratio, amazon_usd: b.amazon_price_usd, vs_amazon: vsAmazon,
      },
      score: Math.max(0, Math.min(score, 100)), verdict: verdict, pros: pros, cons: cons, flags: [],
      starter_qty: starter, starter_capital_usd: r2(starter * landed),
    };
  }

  // --- navigation ----------------------------------------------------------------

  function go(tab) { state.tab = tab; render(); window.scrollTo(0, 0); }
  function logout() {
    api("/api/logout", { method: "POST" }).then(function () {
      state.me = null; state.picks = null; state.analysis = null; state.jobs = undefined; return loadHunt();
    }).then(render);
  }

  Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) {
    b.onclick = function () { go(b.dataset.tab); };
  });
  $("brand-link").onclick = function (ev) { ev.preventDefault(); go("hunt"); };

  var hash = (location.hash || "").slice(1);
  load().then(function () {
    if (HASH_MESSAGES[hash]) {
      toast(HASH_MESSAGES[hash]);
      if (hash !== "paid" && state.me) state.tab = "account";
      try { history.replaceState(null, "", location.pathname); } catch (e) { /* sandboxed */ }
    }
    render();
  }, function (e) { $("main").innerHTML = '<div class="empty">' + esc(errText(e)) + "</div>"; });
})();
