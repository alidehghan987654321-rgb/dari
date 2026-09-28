/* The sellers' site. Talks to hunter/app.py; with window.HUNTER_DEMO set (the preview
   page) it runs on bundled sample data instead and never calls the server. The
   calculator's arithmetic lives in calc.js (window.HunterCalc). */
(function () {
  "use strict";

  var DEMO = window.HUNTER_DEMO || null;
  var Calc = window.HunterCalc;
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    config: null, me: null, hunt: null, picks: null, tab: "home", calc: null,
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
    unprofitable_settings: "با این تنظیمات هیچ قیمتی سود نمی‌ده.",
    no_such_seller: "فروشنده‌ای با این ایمیل ثبت‌نام نکرده.",
    admins_only: "این کار فقط برای مدیر سایته.",
    network: "ارتباط با سرور برقرار نشد.",
  };
  var HASH_MESSAGES = {
    paid: "پرداخت انجام شد و اشتراکت فعاله. 🎉",
    "pay-cancelled": "پرداخت لغو شد.",
    "pay-failed": "پرداخت تأیید نشد. اگه پولی کم شده، ظرف ۷۲ ساعت برمی‌گرده.",
  };
  var VERDICT = { green: "شکار خوب", yellow: "با احتیاط", red: "نیار" };
  var TITLES = { dash: "میز کار", media: "عکس و ویدیو", hunt: "شکارهای امروز", picks: "شکارهای اختصاصی من", analyze: "تحلیل لینک", calc: "ماشین‌حساب واردات", account: "حساب من" };
  var PUBLIC = { home: true, calc: true };  // what visitors can open; "home" is the landing

  // --- helpers ----------------------------------------------------------------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(name) { return '<svg class="i" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : ""; }
  function usd(n) { return n == null || isNaN(n) ? "—" : (n < 0 ? "−$" : "$") + Math.abs(Number(n)).toFixed(2); }
  function cny(n) { return n == null ? "—" : "¥" + Number(n).toFixed(2); }
  function pct(n) { return n == null || isNaN(n) ? "—" : Math.round(n * 100) + "%"; }
  function signed(ratio) { var d = Math.round((ratio - 1) * 100); return (d > 0 ? "+" : "") + d + "%"; }
  function ltr(x) { return "\u2066" + x + "\u2069"; }  // a figure inside Persian text, kept in order
  function count(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
  function toman(n) { return Number(n).toLocaleString("fa-IR"); }
  function round1000(n) { return Math.round(n / 1000) * 1000; }
  function faDate(iso) {
    try { return new Date(iso).toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" }); }
    catch (e) { return iso; }
  }
  function catName(key) {
    if (key === "manual") return "تحلیل دستی";
    var c = (state.config && state.config.categories || []).find(function (x) { return x.key === key; });
    return c ? c.fa : key;
  }
  function currentPlan() {
    return state.me && (state.config.plans || []).find(function (p) { return p.id === state.me.plan; });
  }
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 4500);
  }
  function errText(e) { return ERRORS[e && e.code] || (e && e.message) || ERRORS.network; }
  function each(root, sel, fn) { Array.prototype.forEach.call((root || document).querySelectorAll(sel), fn); }

  // Support and the project's manager (/api/config "support").
  function support() { return (state.config && state.config.support) || {}; }
  function phoneText(p) { var d = String(p || "").replace(/\D/g, ""); return d.length === 11 ? d.slice(0, 4) + " " + d.slice(4, 7) + " " + d.slice(7) : p; }
  function supportLine() {
    var s = support();
    if (!s.name && !s.phone && !s.email) return "";
    return "پشتیبانی و مدیر پروژه: <b>" + esc(s.name) + "</b>" +
      (s.phone ? ' · <a href="tel:' + esc(s.phone) + '" dir="ltr">' + esc(phoneText(s.phone)) + "</a>" : "") +
      (s.email ? ' · <a href="mailto:' + esc(s.email) + '" dir="ltr">' + esc(s.email) + "</a>" : "");
  }
  function supportHTML() {
    var s = support();
    if (!s.name) return "";
    return '<section class="panel"><h2 class="section-title">پشتیبانی</h2><div class="support-card">' +
      '<span class="av">' + ic("support") + '</span><div><b>'  + esc(s.name) + '</b><div class="role">پشتیبانی و مدیر پروژه · فعال‌سازی کارت‌به‌کارت، سؤال‌ها و مشکل‌ها</div>' +
      '<div class="ways">' + (s.phone ? '<a class="btn ghost small" href="tel:' + esc(s.phone) + '">' + ic("phone") + '<span dir="ltr">' + esc(phoneText(s.phone)) + "</span></a>" : "") +
      (s.email ? '<a class="btn ghost small" href="mailto:' + esc(s.email) + '">' + ic("mail") + '<span dir="ltr">' + esc(s.email) + "</span></a>" : "") +
      "</div></div></div></section>";
  }

  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? done : "کپی نشد؛ مرورگر اجازه نداد.");
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { toast(done); }, fallback);
    else fallback();
  }

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
      state.config = DEMO.config; state.me = null; state.hunt = DEMO.hunt;  // starts as a visitor; signing up opens the workspace
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

  // --- the shell ---------------------------------------------------------------

  function render() {
    stopDemo();
    var loggedIn = !!state.me;
    if (!loggedIn && !PUBLIC[state.tab]) state.tab = "home";
    if (loggedIn && state.tab === "home") state.tab = "dash";
    var app = $("app");
    app.classList.toggle("member", loggedIn);
    app.classList.toggle("guest", !loggedIn);
    app.classList.toggle("landing", state.tab === "home");
    var brand = (state.config && state.config.brand) || "شکارچی";
    $("brand-name").textContent = brand;
    document.title = (state.tab !== "home" ? TITLES[state.tab] + " · " : "") + brand;
    each($("tabs"), "button", function (b) {
      b.setAttribute("aria-current", b.dataset.tab === state.tab ? "page" : "false");
    });
    topbar(brand, loggedIn);
    sideFoot(loggedIn);
    $("foot").innerHTML = '<div class="foot-in"><span>© ' + esc(brand) +
      " — ابزار فروشنده‌های راینومال؛ اعداد تخمینی‌اند و جای خرید نمونه رو نمی‌گیرن.</span>" +
      '<span class="support">' + supportLine() + "</span></div>";
    var main = $("main");
    if (state.tab === "calc") renderCalc();
    else if (!loggedIn) { main.innerHTML = landingHTML(); bindLanding(); }
    else if (state.tab === "dash") renderDash();
    else if (state.tab === "media") renderMedia();
    else if (state.tab === "picks") renderPicks();
    else if (state.tab === "analyze") { main.innerHTML = analyzeHTML(); bindAnalyze(); }
    else if (state.tab === "account") { main.innerHTML = accountHTML(); bindAccount(); }
    else { main.innerHTML = huntHTML(); bindHunt(); }
    bindCards(main);
  }

  function topbar(brand, loggedIn) {
    var mark = '<a class="brand" href="#" data-go="home"><img class="brand-logo" src="/static/brand/logo-64.png" alt=""><span>' + esc(brand) + "</span></a>";
    if (!loggedIn) {
      var link = function (go, label) {
        return '<button type="button" data-go="' + go + '" aria-current="' + (state.tab === go ? "page" : "false") + '">' + label + "</button>";
      };
      $("topbar").innerHTML = mark +
        '<nav class="guest-links" aria-label="بخش‌ها">' + link("home", "معرفی") + '<button type="button" data-go="demo">دمو</button>' +
          link("calc", "ماشین‌حساب") + '<button type="button" data-go="plans">تعرفه‌ها</button></nav>' +
        '<div class="topbar-end"><button type="button" class="nav-login" data-go="login">ورود</button>' +
          '<button type="button" class="btn small" data-go="signup">شروع کن</button></div>';
      return;
    }
    var plan = currentPlan();
    $("topbar").innerHTML = mark +
      '<div class="crumb"><span>' + esc(brand) + "</span><span>/</span><b>" + TITLES[state.tab] + "</b></div>" +
      '<div class="topbar-end">' +
        (state.me.active
          ? '<span class="pill green"><span class="dot"></span>' + (plan ? "پلن " + esc(plan.name_fa) : "اشتراک فعال") + "</span>"
          : '<button type="button" class="pill neutral" data-go="account" style="border:0;cursor:pointer">بدون اشتراک · خرید</button>') +
        (DEMO ? '<span class="pill yellow">نسخه‌ی نمایشی</span>' : "") +
      "</div>";
  }

  function sideFoot(loggedIn) {
    var f = $("side-foot");
    if (!loggedIn) { f.innerHTML = ""; return; }
    var me = state.me;
    f.innerHTML = '<div class="who" title="' + esc(me.email) + '">' + esc(me.name || me.email) + "</div>" +
      (me.active && me.paid_until && !me.is_admin ? "<div>اشتراک تا " + esc(faDate(me.paid_until)) + "</div>" : "") +
      (DEMO ? '<span class="pill yellow">نسخه‌ی نمایشی</span>' : "") +
      '<button type="button" class="btn ghost small" data-logout>خروج' + ic("logout") + "</button>";
  }

  // --- product cards ----------------------------------------------------------------

  function cardHTML(c) {
    var title = esc(c.title_fa || (c.listing && c.listing.title) || "");
    var initial = esc((c.title_fa || "?").trim().charAt(0));
    var head =
      '<div class="card-head">' +
        '<div class="thumb">' + (c.listing && imgSrc(c.listing.image_url)
          ? '<img src="' + esc(imgSrc(c.listing.image_url)) + '" alt="" loading="lazy">' : "") + initial + "</div>" +
        "<div><div class=\"card-title\">" + title + "</div>" +
          (c.listing && c.listing.title && c.title_fa ? '<div class="card-sub">' + esc(c.listing.title) + "</div>" : "") +
          '<div class="card-cat"><span>' + esc(catName(c.category)) + '</span><span class="pill ' + c.verdict + '"><span class="dot"></span>' + VERDICT[c.verdict] + "</span>" +
            (c.is_new ? '<span class="pill new">جدید امروز</span>' : "") + "</div></div>" +
        '<div class="score ' + c.verdict + '" title="امتیاز از ۱۰۰">' + c.score + "<small>امتیاز</small></div>" +
      "</div>";
    if (c.locked) {
      return '<article class="card locked v-' + c.verdict + '">' + head +
        '<div class="ladder"><div class="rung"><div class="k">1688</div><div class="v">¥00.00</div></div><div class="rung"><div class="k">تا انبار</div><div class="v">$0.00</div></div><div class="rung ours"><div class="k">قیمت پیشنهادی</div><div class="v">$00.00</div></div></div>' +
        '<div class="compare"><div class="market"><div class="k">Temu</div><div class="v">$00.00</div></div><div class="market"><div class="k">آمازون</div><div class="v">$00.00</div></div></div>' +
        '<p class="lock-note">' + ic("lock") + "<span>قیمت‌ها، مقایسه با Temu و آمازون، تأمین‌کننده و لینک خرید برای مشترک‌ها باز میشه.</span></p></article>";
    }
    var p = c.pricing, o = c.offer;
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
      "<details><summary>ریز هزینه‌ها و قیمت</summary>" + costTable(p, c.pack_qty, c.weight_kg) +
      '<p class="hint" style="margin:6px 0 0">کمترین قیمت با سود مطلوب: ' + usd(p.floor_usd) +
      " · سربه‌سر: " + usd(p.breakeven_usd) + "</p></details>";
    return '<article class="card v-' + c.verdict + '">' + head + ladder + compareHTML(c) + stats + reasons + flags +
      supplierHTML(c) + costs +
      '<div class="card-foot"><button type="button" class="btn ghost small" data-calc="' + esc(c.id) + '">حساب‌وکتاب در ماشین‌حساب' + ic("calc") + "</button>" +
        (c.offer && c.offer.url ? '<button type="button" class="btn ghost small" data-media="' + esc(c.id) + '">عکس و ویدیو' + ic("media") + "</button>" : "") + "</div>" +
      "</article>";
  }

  // Every cost of one sale. The store's share is split the way the contract says (clause 5);
  // cuts the contract doesn't have show only when set (another store's settings).
  function costTable(p, packQty, weightKg) {
    var cfg = state.config.pricing || {}, share = Math.round((cfg.platform_pct || 0) * 100);
    var split = (cfg.platform_split || []).map(function (x) {
      return '<tr class="sub"><td>' + (SPLIT_FA[x[0]] || x[0]) + " (" + toman(Math.round(x[1] * 100)) + "٪)</td><td>" + usd(p.price_usd * x[1]) + "</td></tr>";
    }).join("");
    var opt = function (label, v) { return v ? row(label, v) : ""; };
    return '<table class="costs"><tbody>' +
      row("قیمت کارخونه" + (packQty > 1 ? " (" + packQty + " عدد)" : ""), p.factory_usd) +
      row("ایجنت و حمل داخل چین", p.china_side_usd) +
      row("حمل تا انبار دبی (" + Number(weightKg).toFixed(2) + " کیلو)", p.freight_usd) +
      opt("بسته‌بندی", p.packaging_usd) +
      '<tr class="total"><td>تمام‌شده تا انبار دبی</td><td>' + usd(p.landed_usd) + "</td></tr>" +
      row("سهم راینومال (" + toman(share) + "٪ از قیمت فروش)", p.platform_fee_usd) + split +
      opt("سهم ارسال به مشتری", p.last_mile_usd) +
      opt("درگاه پرداخت", p.gateway_usd) +
      opt("تبلیغات خودت", p.marketing_usd) +
      opt("ذخیره‌ی مرجوعی", p.returns_reserve_usd) +
      '<tr class="total"><td>سود فروشنده در قیمت ' + usd(p.price_usd) + "</td><td>" + usd(p.profit_usd) + "</td></tr>" +
      "</tbody></table>";
  }
  function row(k, v) { return "<tr><td>" + esc(k) + "</td><td>" + usd(v) + "</td></tr>"; }

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
    var cls = ratio <= 1.0 ? "good" : ratio <= 1.1 ? "warn" : "bad";
    return '<span class="vs-chip ' + cls + '" title="قیمت ما نسبت به این بازار">' + signed(ratio) + "</span>";
  }

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
      '<div class="shop">' + ic("factory") + esc(o.shop_name || "نام فروشگاه در دسترس نیست") + "</div>" +
      (facts.length ? '<div class="facts">' + facts.map(function (f) { return "<bdi>" + f + "</bdi>"; }).join(" · ") + "</div>" : "") +
      (o.title ? '<div class="offer-title" title="اسم محصول در 1688">' + esc(o.title) + "</div>" : "") +
      tiersHTML(o) +
      '<div class="links">' +
        (o.url ? '<button type="button" class="btn small" data-offer="' + esc(o.url) + '" data-card="' + esc(c.id) + '">نمایش کامل محصول و تأمین‌کننده' + ic("ext") + "</button>" : "") +
        (o.url ? '<button type="button" class="btn ghost small" data-copy="' + esc(o.url) + '">کپی لینک برای ایجنت' + ic("copy") + "</button>" : "") +
      "</div>" +
      (alts ? '<details class="alts"><summary>' + toman(c.alternatives.length) + " تأمین‌کننده‌ی جایگزین</summary><ul>" + alts + "</ul></details>" : "") +
      '<details class="howto"><summary>چطور بخرم؟</summary><ol>' +
        "<li>«کپی لینک برای ایجنت» رو بزن و لینک رو برای ایجنت خریدت بفرست؛ اسم چینی محصول هم بالا هست تا اشتباه نشه.</li>" +
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
      box.addEventListener("click", function (ev) { if (ev.target === box || ev.target.closest("[data-close]")) box.hidden = true; });
      document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") box.hidden = true; });
    }
    box.hidden = false;
    var close = '<button type="button" class="btn ghost small close" data-close="1">بستن' + ic("x") + "</button>";
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
        '<div class="links" style="margin-top:12px"><button type="button" class="btn small" data-copy="' + esc(url) + '">کپی لینک برای ایجنت خرید' + ic("copy") + "</button></div>" +
      "</div></div>";
  }

  function bindCopy(root) {
    each(root, "[data-copy]", function (b) {
      b.onclick = function () { copyText(b.dataset.copy, "لینک کپی شد؛ برای ایجنت خریدت بفرست."); };
    });
  }
  function bindCards(root) {
    each(root, "[data-offer]", function (b) {
      b.onclick = function () { openOffer(b.dataset.offer, findCard(b.dataset.card)); };
    });
    each(root, "[data-calc]", function (b) {
      b.onclick = function () { openInCalc(findCard(b.dataset.calc)); };
    });
    each(root, "[data-media]", function (b) {
      b.onclick = function () { openMedia(b.dataset.media); };
    });
    bindCopy(root);
  }

  // --- landing (logged out): what the hunter does, a live demo, then sign-up ---------------

  // One product through the whole pipeline, for the demo. The listing and supplier are
  // sample data; every price below them is worked out live by calc.js with the site's settings.
  var EXAMPLE = {
    title_fa: "پرکننده‌ی شکاف صندلی خودرو، چرمی با جیب (۲ عددی)",
    temu: { title: "2 Pack Car Seat Gap Filler, PU Leather Organizer with Storage Pocket", price: 11.99 },
    amazon: { price: 16.99, sold: 5000 },
    offer: {
      title: "座椅缝隙收纳盒 皮革 悬挂式", shop: "کارخانه‌ی نمونه در ییوو", location: "浙江 义乌", years: 8,
      rating: 4.8, repurchase: 0.32, moq: 10, price: 6.65, tiers: [[10, 6.65], [100, 6.12], [1000, 5.65]],
    },
    units: 2, weight_kg: 0.4,
  };
  var STEPS = ["پرفروش", "تأمین‌کننده", "هزینه‌ها", "قیمت و حکم"];
  var FREIGHTS = [["sea", "دریایی"], ["site", "معمول"], ["air", "هوایی"]];
  var landing = { step: 0, timer: null, io: null, stopped: false, trial: null };

  function quote(input) {
    var p = state.config.pricing;
    var res = Calc.compute(Object.assign({ market: "prepaid", items_per_cart: p.items_per_cart }, input), p);
    return res && res.ok ? res : null;
  }
  function example() {
    var e = EXAMPLE;
    return quote({ price: e.offer.price, units: e.units, weight_kg: e.weight_kg, temu_usd: e.temu.price, amazon_usd: e.amazon.price });
  }
  function motionOK() {
    return !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function sharePct() { return Math.round(((state.config.pricing || {}).platform_pct || 0.2) * 100); }

  function landingHTML() {
    var cfg = state.config || {}, ex = example(), share = sharePct();
    var faq = [
      ["داده‌ها از کجا میان؟", "قیمت و فروش Temu و آمازون از سرویس‌های داده‌ی بازار (Keepa و Apify) خونده میشه و تأمین‌کننده با جستجوی تصویری در 1688 پیدا میشه. هر محصول کنار لینکش نشون داده میشه تا خودت هم ببینی."],
      ["سهم راینومال چقدره و چی رو پوشش می‌ده؟", toman(share) + "٪ از قیمت نهایی. ارسال به مشتری، بسته‌بندی نهایی، انبارداری در دبی، تبلیغات، تخفیف‌ها و حتی مرجوعی‌ها همه از همین سهمه. پس قیمت فروش همون فرمول قرارداده: (بهای تمام‌شده + سود تو) ÷ " + toman(1 - share / 100) + ". ماشین‌حساب هم دقیقاً همین رو حساب می‌کنه."],
      ["امتیاز پنل هم در حساب‌وکتاب هست؟", "آره. در ماشین‌حساب مشخص می‌کنی امتیاز پنل (" + ltr(usd((cfg.pricing || {}).license_usd || 10000)) + " در " + toman((cfg.pricing || {}).license_installments || 10) + " قسط) رو می‌دی یا معافی؛ بعد می‌بینی چند ماه سود لازمه تا برگرده و سود خالص سال اولت چقدره."],
      ["اعداد چقدر دقیقن؟", "هزینه‌ها با فرض‌های رایج حساب میشن (کرایه‌ی هر کیلو، ایجنت) و همه‌شون در ماشین‌حساب قابل تغییرن. قبل از سفارش اصلی حتماً نمونه بخر و نرخ حمل رو از پلتفرم واسطت بپرس."],
      ["عکس و ویدیوی محصول رو از کجا بیارم؟", "از بخش «عکس و ویدیو». عکس‌ها و ویدیوهای هر محصول از 1688، Temu و آمازون از طریق سرور ما دانلود میشن (از داخل ایران هم باز میشه)، هم اصلی و هم نسخه‌ی مربعی آماده‌ی آگهی."],
      ["چرا هر محصول فقط به چند فروشنده داده میشه؟", "اگه همه یه محصول رو بیارن، قیمت‌ها می‌شکنه. شکارهای اختصاصی بین فروشنده‌ها پخش میشن تا هر کس بازار خودش رو داشته باشه."],
      ["پشتیبانی با کیه؟", supportLine()],
    ];
    return '<div class="lp">' + demoBarHTML() +
      '<section class="lp-hero">' +
        "<div>" +
          '<span class="lp-eyebrow" dir="ltr">1688 → DUBAI → RHINOMALL</span>' +
          "<h1>محصول درست،<br><em>قیمت درست.</em></h1>" +
          '<p class="lp-lead">شکارچی هر روز پرفروش‌های Temu و آمازون رو پیدا می‌کنه، همون جنس رو در 1688 نشونت می‌ده و قیمت فروشی پیشنهاد می‌کنه که هم از Temu ارزون‌تره هم با سهم راینومال برات سود داره.</p>' +
          '<div class="lp-ctas"><button type="button" class="btn shine" data-go="signup">شروع رایگان' + ic("back") + "</button>" +
            '<button type="button" class="btn ghost" data-go="demo">' + ic("play") + "دیدن دمو</button></div>" +
          '<div class="lp-stats"><div><b>3</b><span>بازار زیر نظر</span></div><div><b>' + share + '%</b><span>سهم راینومال، همه‌چیز با خودش</span></div>' +
            "<div><b>" + (cfg.per_product || 3) + "</b><span>فروشنده برای هر محصول</span></div></div>" +
        "</div>" +
        scannerHTML(ex) +
      "</section>" +
      '<section class="lp-sec band" id="demo"><div class="lp-in">' +
        head("DEMO", "یه محصول، از Temu تا <em>قیمت فروش تو.</em>",
          "موتور شکار با هر محصول همین چهار کار رو می‌کنه. این یه نمونه‌ست و عددهاش همین الان با فرمول‌های سایت و قرارداد راینومال حساب شدن.") +
        '<div class="lp-seg" role="tablist" aria-label="مرحله‌های دمو" id="demo-seg">' + STEPS.map(function (s, n) {
          return '<button type="button" role="tab" data-step="' + n + '" aria-selected="' + (n === landing.step) + '"><span class="n">0' + (n + 1) + "</span>" + s + "</button>";
        }).join("") + "</div>" +
        '<div class="lp-stage glass bk" id="demo-stage" role="tabpanel">' + stepHTML(landing.step) + "</div>" +
      "</div></section>" +
      trialHTML() +
      toolsHTML() +
      '<section class="lp-sec band" id="plans"><div class="lp-in">' +
        head("PLANS", "یه پلن برای هر اندازه.", "اشتراک ماهانه با کارت بانکی، از درگاه زرین‌پال. ماشین‌حساب همیشه رایگانه.") +
        '<div class="plans">' + plansHTML(false) + "</div>" +
      "</div></section>" +
      '<section class="lp-sec" id="signup"><div class="lp-in lp-signup">' +
        '<div>' + head("SIGN UP", "میز کارت <em>آماده‌ست.</em>", "یه حساب بساز؛ همون لحظه میز کار با همه‌ی ابزارها برات باز میشه.") +
          '<ul class="lp-checks">' + [
            "میز کار با شکارهای امروز، ماشین‌حساب و تحلیل لینک",
            "عکس و ویدیوی هر محصول، آماده‌ی دانلود برای آگهی",
            "حساب‌وکتاب دقیق با سهم و قوانین قرارداد راینومال",
            "پشتیبانی: " + esc((cfg.support || {}).name || ""),
          ].map(function (t) { return "<li>" + ic("check") + "<span>" + t + "</span></li>"; }).join("") + "</ul></div>" +
        '<div class="glass bk auth" id="auth">' + authHTML() + "</div>" +
      "</div></section>" +
      '<section class="lp-sec band" id="faq"><div class="lp-in lp-narrow">' + head("FAQ", "سؤال‌های رایج.", "") +
        '<div class="lp-faq">' + faq.map(function (q) { return "<details><summary>" + q[0] + "</summary><p>" + q[1] + "</p></details>"; }).join("") + "</div>" +
      "</div></section>" +
    "</div>";
  }
  function head(eyebrow, title, sub) {
    return '<div class="lp-head"><p class="lp-eyebrow" dir="ltr">' + eyebrow + '</p><h2 class="lp-title">' + title + "</h2>" +
      (sub ? '<p class="lp-sub">' + sub + "</p>" : "") + "</div>";
  }
  // In the demo there's no server: this jumps straight to what a seller sees after signing up.
  function demoBarHTML() {
    return DEMO ? '<div class="lp-demo-bar"><span>نسخه‌ی نمایشی: برای دیدن صفحه‌ی بعد از ثبت‌نام، هر اسم و ایمیلی قبوله.</span>' +
      '<button type="button" class="btn" data-demo-enter>ورود مستقیم به میز کار' + ic("back") + "</button></div>" : "";
  }

  // The logo under a sweeping scan line, with the sample product's figures around it.
  function scannerHTML(r) {
    var e = EXAMPLE, logo = "/static/brand/logo-512.webp";
    var hud = function (pos, label, value, cls, extra) {
      return '<div class="hud' + (cls ? " " + cls : "") + '" style="' + pos + '"><small>' + label + "</small><b>" + value + (extra || "") + "</b></div>";
    };
    return '<div class="scanner glass bk beam" aria-label="نمونه: ' + esc(e.title_fa) + '">' +
      '<div class="grid"></div><img class="mark" src="' + logo + '" alt=""><div class="scan-line"></div>' +
      (r ? hud("top:9%;right:6%", "خرید از 1688", "¥" + (e.offer.price * e.units).toFixed(2)) +
        hud("top:9%;left:6%", "تمام‌شده تا دبی", usd(r.landed_usd)) +
        hud("top:36%;left:4%", "Temu", usd(e.temu.price), "", '<span class="d">' + signed(r.vs_benchmark) + "</span>") +
        hud("top:52%;right:5%", "قیمت پیشنهادی", usd(r.price_usd), "y") : "") +
      '<div class="readout"><div><div class="t">' + esc(e.title_fa) + '</div><div class="s">' +
        (r ? "سود هر عدد " + ltr(usd(r.profit_usd)) + " · حاشیه " + ltr(pct(r.margin)) + " · نمونه" : "نمونه") + "</div></div>" +
        (r ? '<span class="pill ' + r.verdict + '"><span class="dot"></span>' + VERDICT[r.verdict] + "</span>" : "") + "</div>" +
    "</div>";
  }

  function stepHTML(n) {
    var e = EXAMPLE, o = e.offer, r = example(), share = sharePct();
    var copy, visual;
    if (n === 0) {
      copy = ["پیدا کردن پرفروش", "هر روز پرفروش‌های Temu و آمازون در دسته‌های مجاز بررسی میشن. این یکی در آمازون ماهی حدود " +
        toman(e.amazon.sold) + " تا فروش داره و وزنش سبکه؛ یعنی حمل ارزون."];
      visual = '<div class="ex-box ex-listing"><div class="ex-img">' + ic("box") + '<span class="ex-badge">Temu</span></div><div>' +
        '<p class="ex-en" dir="ltr">' + esc(e.temu.title) + '</p><p class="ex-fa">' + esc(e.title_fa) + "</p>" +
        '<div class="ex-cells"><div><span>Temu</span><b>' + usd(e.temu.price) + "</b></div>" +
        "<div><span>آمازون</span><b>" + usd(e.amazon.price) + "</b><small>~" + count(e.amazon.sold) + " فروش در ماه</small></div></div></div></div>";
    } else if (n === 1) {
      copy = ["همون جنس در 1688", "با جستجوی تصویری، همون محصول در 1688 پیدا میشه: تأمین‌کننده، سابقه، امتیاز و قیمت پلکانی. به فارسی و بدون نیاز به حساب 1688."];
      var facts = ["کارخانه", o.location, toman(o.years) + " سال در 1688", "امتیاز " + o.rating, "خرید مجدد " + pct(o.repurchase), "حداقل سفارش " + toman(o.moq)];
      visual = '<div class="ex-box"><div class="ex-shop">' + ic("factory") + "<span>" + esc(o.shop) + "</span></div>" +
        '<p class="ex-zh" lang="zh">' + esc(o.title) + "</p>" +
        '<div class="ex-facts">' + facts.map(function (f) { return "<bdi>" + esc(f) + "</bdi>"; }).join("") + "</div>" +
        '<div class="ex-cells">' + o.tiers.map(function (t) {
          return "<div><span>از " + toman(t[0]) + " عدد</span><b>¥" + t[1].toFixed(2) + "</b></div>";
        }).join("") + "</div></div>";
    } else if (n === 2) {
      copy = ["همه‌ی هزینه‌ها", r ? "تو فقط هزینه‌ی رسوندن جنس تا انبار دبی رو می‌دی؛ ارسال به مشتری، بسته‌بندی، انبار و تبلیغات از سهم " +
        toman(share) + "٪ راینومال پرداخت میشه. این محصول تا انبار دبی " + ltr(usd(r.landed_usd)) + " تموم میشه." : ERRORS.unprofitable_settings];
      var rows = r ? [
        ["خرید از کارخونه (" + toman(e.units) + " عدد)", r.factory_usd], ["ایجنت و حمل داخل چین", r.china_side_usd],
        ["حمل تا انبار دبی", r.freight_usd], ["سهم راینومال (" + toman(share) + "٪ از قیمت)", r.platform_fee_usd, "share"],
      ] : [];
      if (r && r.packaging_usd) rows.splice(3, 0, ["بسته‌بندی", r.packaging_usd]);
      var max = Math.max.apply(null, rows.map(function (x) { return x[1]; }).concat([0.01]));
      visual = '<div class="ex-box ex-costs">' + rows.map(function (x) {
        return '<div class="ex-row"><span>' + x[0] + '</span><i><s class="' + (x[2] || "") + '" style="width:' + Math.max(2, Math.round(x[1] / max * 100)) + '%"></s></i><b>' + usd(x[1]) + "</b></div>";
      }).join("") + (r ? '<div class="ex-row total"><span>تمام‌شده تا انبار دبی</span><b>' + usd(r.landed_usd) + "</b></div>" : "") + "</div>";
    } else {
      copy = ["قیمت و حکم", "قیمتی کمی زیر Temu که بعد از سهم راینومال هنوز سود تو بمونه، با حکم سبز، زرد یا قرمز و دلیل‌هاش؛ برای همه‌ی شکارهای هر روز."];
      visual = r ? '<div class="ex-box ex-verdict"><span class="pill ' + r.verdict + '"><span class="dot"></span>' + VERDICT[r.verdict] + "</span>" +
        '<div class="ex-big">' + usd(r.price_usd) + "</div><p>قیمت فروش پیشنهادی در راینومال</p>" +
        '<div class="ex-cells"><div><span>Temu</span><b>' + usd(e.temu.price) + "</b><small>" + ltr(signed(r.vs_benchmark)) + "</small></div>" +
          "<div><span>سود هر عدد</span><b class=\"y\">" + usd(r.profit_usd) + "</b><small>بعد از سهم راینومال</small></div>" +
          "<div><span>بازده سرمایه</span><b>" + pct(r.roi) + "</b><small>حاشیه " + ltr(pct(r.margin)) + "</small></div></div></div>" : "";
    }
    return '<div class="ex-copy"><span class="ex-n" dir="ltr">STEP 0' + (n + 1) + " / 0" + STEPS.length + "</span><h3>" + copy[0] + "</h3><p>" + copy[1] + "</p>" +
      (n === STEPS.length - 1
        ? '<button type="button" class="btn" data-go="signup">شکارهای امروز رو ببین' + ic("back") + "</button>"
        : '<button type="button" class="lp-link" data-step-next>مرحله‌ی بعد' + ic("chev") + "</button>") +
      '</div><div class="ex-vis">' + visual + "</div>";
  }

  // The live mini calculator.
  function trial() {
    if (!landing.trial) {
      var d = calcDefaults();
      landing.trial = { price: d.price, weight_kg: d.weight_kg, temu_usd: d.temu_usd, freight: "site" };
    }
    return landing.trial;
  }
  var TRIAL = [
    ["price", "قیمت در 1688 (هر عدد)", 1, 150, 0.5, function (v) { return "¥" + v.toFixed(2); }],
    ["weight_kg", "وزن با بسته‌بندی", 0.05, 3, 0.05, function (v) { return v.toFixed(2) + " kg"; }],
    ["temu_usd", "قیمت همین جنس در Temu", 2, 60, 0.5, function (v) { return usd(v); }],
  ];
  function trialHTML() {
    var t = trial();
    return '<section class="lp-sec" id="try"><div class="lp-in">' +
      head("LIVE CALCULATOR", "عددهای خودت رو <em>امتحان کن.</em>", "قیمت 1688، وزن و قیمت Temu رو تغییر بده؛ قیمت فروش، سهم راینومال، سود و حکم همون لحظه حساب میشه.") +
      '<div class="lp-try"><div class="glass bk lp-controls">' +
        TRIAL.map(function (s) {
          return '<div class="lp-slider"><div class="row"><label for="t-' + s[0] + '">' + s[1] + '</label><output id="o-' + s[0] + '" dir="ltr">' + s[5](t[s[0]]) + "</output></div>" +
            '<input type="range" id="t-' + s[0] + '" data-t="' + s[0] + '" min="' + s[2] + '" max="' + s[3] + '" step="' + s[4] + '" value="' + t[s[0]] + '"></div>';
        }).join("") +
        '<div class="lp-slider"><div class="row"><span class="label">حمل تا دبی</span></div><div class="lp-seg small" role="group" aria-label="حمل تا دبی">' +
          FREIGHTS.map(function (f) { return '<button type="button" data-f="' + f[0] + '" aria-pressed="' + (t.freight === f[0]) + '">' + f[1] + "</button>"; }).join("") +
        "</div></div>" +
      '</div><div class="glass bk lp-result" id="try-out">' + trialOutHTML() + "</div></div>" +
    "</div></section>";
  }
  function trialOutHTML() {
    var t = trial();
    var r = quote({ price: t.price, units: 1, weight_kg: t.weight_kg, temu_usd: t.temu_usd, freight: t.freight === "site" ? null : t.freight });
    if (!r) return '<p class="hint">' + ERRORS.unprofitable_settings + "</p>";
    var parts = visibleParts(Calc.split(r)), total = parts.reduce(function (a, p) { return a + Math.max(0, p.value); }, 0) || 1;
    return '<div class="tr-top"><span class="pill ' + r.verdict + '"><span class="dot"></span>' + VERDICT[r.verdict] + '</span><span>قیمت فروش پیشنهادی</span></div>' +
      '<div class="tr-big" dir="ltr">' + usd(r.price_usd) + "</div>" +
      '<div class="tr-figs">' +
        "<div><span>تمام‌شده تا دبی</span><b>" + usd(r.landed_usd) + "</b></div>" +
        '<div><span>سود هر عدد</span><b class="' + (r.profit_usd >= 0 ? "good" : "bad") + '">' + usd(r.profit_usd) + "</b></div>" +
        "<div><span>حاشیه‌ی سود</span><b>" + pct(r.margin) + "</b></div>" +
        "<div><span>نسبت به Temu</span><b>" + signed(r.vs_benchmark) + "</b></div>" +
      "</div>" +
      '<div class="tr-split" role="img" aria-label="سهم سود و هزینه‌ها از قیمت فروش؛ فهرستش زیرش هست">' + parts.map(function (p) {
        return '<i class="c' + partIndex(p.key) + '" style="flex:' + (Math.max(0, p.value) / total).toFixed(4) + ' 1 0"></i>';
      }).join("") + "</div>" +
      '<ul class="tr-legend">' + parts.map(function (p) {
        return '<li><span class="sw c' + partIndex(p.key) + '"></span><span>' + partName(p.key) + '</span><b dir="ltr">' + usd(p.value) + "</b></li>";
      }).join("") + "</ul>" +
      '<button type="button" class="btn ghost" data-open-calc>باز کردن در ماشین‌حساب کامل' + ic("calc") + "</button>";
  }

  var TOOL_LIST = [
    ["hunt", "hunt", "شکار روزانه", "هر روز محصول‌های تازه با حکم سبز، زرد یا قرمز و برچسب «جدید امروز».", false],
    ["picks", "picks", "شکار اختصاصی", "بر اساس دسته‌ها و بودجه‌ات؛ هر محصول فقط برای چند فروشنده.", true],
    ["analyze", "analyze", "تحلیل لینک", "لینک Temu یا آمازون بده؛ تأمین‌کننده، هزینه‌ها و قیمت آماده میشه.", true],
    ["media", "media", "عکس و ویدیوی محصول", "عکس‌ها و ویدیوهای هر محصول از 1688، Temu و آمازون؛ اصلی و مربعی آماده‌ی آگهی.", true],
    ["calc", "calc", "ماشین‌حساب واردات", "قیمت با فرمول قرارداد راینومال، امتیاز پنل، و برنامه‌ی اولین محموله به تومان.", false],
    ["account", "factory", "1688 به فارسی", "عکس، مشخصات، مدل‌ها و قیمت پلکانی تأمین‌کننده؛ بدون نیاز به حساب 1688.", true],
  ];
  function toolsHTML() {
    return '<section class="lp-sec" id="tools"><div class="lp-in">' +
      head("TOOLS", "همه‌ی ابزارها، <em>یه میز کار.</em>", "بعد از ثبت‌نام همه‌ی این‌ها روی میز کارت منتظرن.") +
      '<div class="lp-tools">' + TOOL_LIST.map(function (t) {
        return '<article class="glass bk tool-card">' + (t[0] === "media" ? '<span class="new">جدید</span>' : "") +
          '<span class="ib">' + ic(t[1]) + "</span><h3>" + t[2] + "</h3><p>" + t[3] + "</p></article>";
      }).join("") + "</div></div></section>";
  }

  function plansHTML(buying) {
    var cfg = state.config, current = currentPlan();
    return (cfg.plans || []).map(function (p, n) {
      var mine = current && current.id === p.id;
      var button = buying
        ? '<button type="button" class="btn block" data-plan="' + esc(p.id) + '"' + (cfg.online_payment ? "" : " disabled") + ">" + (mine ? "تمدید" : "خرید") + " با درگاه" + ic("coin") + "</button>"
        : '<button type="button" class="btn ' + (n === 1 ? "" : "ghost ") + 'block" data-go="signup">انتخاب' + ic("back") + "</button>";
      return '<div class="plan' + (mine ? " current" : !buying && n === 1 ? " best" : "") + '">' +
        '<div class="label">' + esc(p.name_fa) + (mine ? ' <span class="pill blue">پلن فعلی</span>' : !buying && n === 1 ? ' <span class="pill blue">پیشنهاد ما</span>' : "") + "</div>" +
        '<div class="price">' + toman(p.price_toman) + " <small>تومان در ماه</small></div>" +
        "<ul>" +
          "<li>" + ic("check") + "<span>" + toman(p.links) + " تحلیل لینک در ماه</span></li>" +
          "<li>" + ic("check") + "<span>شکار روزانه و شکارهای اختصاصی</span></li>" +
          "<li>" + ic("check") + "<span>عکس و ویدیوی محصول‌ها برای دانلود</span></li>" +
          "<li>" + ic("check") + "<span>ماشین‌حساب با قوانین قرارداد راینومال</span></li>" +
        "</ul>" + button + "</div>";
    }).join("");
  }

  function authHTML() {
    var signup = state.authMode === "signup";
    return '<div class="auth-tabs" role="group" aria-label="ثبت‌نام یا ورود"><button type="button" data-mode="signup" aria-pressed="' + signup + '">ثبت‌نام</button>' +
      '<button type="button" data-mode="login" aria-pressed="' + !signup + '">ورود</button></div>' +
      '<form id="auth-form" novalidate>' +
        (signup ? field("name", "نام و نام خانوادگی", "text", "name") + field("phone", "موبایل (برای رسید پرداخت)", "tel", "tel") : "") +
        field("email", "ایمیل", "email", "email") +
        field("password", "رمز عبور" + (signup ? " (حداقل ۸ حرف)" : ""), "password", signup ? "new-password" : "current-password") +
        (DEMO ? '<p class="hint" style="margin:0">نسخه‌ی نمایشی: هر اسم، ایمیل و رمزی قبوله.</p>' : "") +
        '<div class="error" id="auth-error"></div>' +
        '<button class="btn block" type="submit">' + (signup ? "ساخت حساب و رفتن به میز کار" : "ورود به میز کار") + ic("back") + "</button>" +
      "</form>";
  }
  function field(id, label, type, ac) {
    return '<div class="field"><label for="f-' + id + '">' + label + '</label><input class="input" id="f-' + id + '" name="' + id + '" type="' + type + '" autocomplete="' + ac + '" dir="auto"></div>';
  }

  function bindLanding() {
    bindAuth();
    bindDemo();
    bindTrial();
  }
  function enterDemo(body) {
    body = body || {};
    state.me = Object.assign({}, DEMO.me, body.name && body.name.trim() ? { name: body.name.trim() } : {}, /@/.test(body.email || "") ? { email: body.email.trim() } : {});
    state.tab = "dash"; render(); window.scrollTo(0, 0);
  }
  function bindAuth() {
    each(document, ".auth-tabs button", function (b) {
      b.onclick = function () { state.authMode = b.dataset.mode; $("auth").innerHTML = authHTML(); bindAuth(); };
    });
    $("auth-form").onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target, body = { email: f.email.value, password: f.password.value }, signup = state.authMode === "signup";
      if (signup) { body.name = f.name.value; body.phone = f.phone.value; }
      $("auth-error").textContent = "";
      var welcome = signup ? "حسابت ساخته شد. به میز کار خوش اومدی!" : "خوش برگشتی!";
      if (DEMO) { enterDemo(body); toast(welcome); return; }  // any details will do
      api("/api/" + state.authMode, { method: "POST", body: body }).then(function (me) {
        state.me = me; state.tab = "dash";
        return loadHunt();
      }).then(function () { render(); window.scrollTo(0, 0); toast(welcome); }, function (e) {
        $("auth-error").textContent = e.code === "invalid" ? "همه‌ی خونه‌ها رو درست پر کن (رمز حداقل ۸ حرف)." : errText(e);
      });
    };
  }

  // The demo walks through its steps by itself while it's on screen, until someone picks one.
  function bindDemo() {
    var seg = $("demo-seg"), stage = $("demo-stage");
    if (!seg) return;
    function show(n, auto) {
      landing.step = n;
      each(seg, "button", function (b) {
        var on = Number(b.dataset.step) === n;
        b.setAttribute("aria-selected", String(on));
        b.classList.toggle("playing", on && auto);
      });
      stage.innerHTML = stepHTML(n);
    }
    function pick(n) { stopDemo(); landing.stopped = true; show(n, false); }
    each(seg, "button", function (b) { b.onclick = function () { pick(Number(b.dataset.step)); }; });
    stage.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-step-next]")) pick((landing.step + 1) % STEPS.length);
    });
    if (landing.stopped || !motionOK() || !window.IntersectionObserver) return;
    landing.io = new IntersectionObserver(function (entries) {
      var seen = entries[entries.length - 1].isIntersecting;
      clearInterval(landing.timer); landing.timer = null;
      each(seg, "button", function (b) { b.classList.toggle("playing", seen && Number(b.dataset.step) === landing.step); });
      if (seen) landing.timer = setInterval(function () { show((landing.step + 1) % STEPS.length, true); }, 5000);
    }, { threshold: 0.35 });
    landing.io.observe(stage);
  }
  function stopDemo() {
    clearInterval(landing.timer); landing.timer = null;
    if (landing.io) { landing.io.disconnect(); landing.io = null; }
    each($("demo-seg"), "button", function (b) { b.classList.remove("playing"); });
  }

  function bindTrial() {
    var box = $("try");
    if (!box) return;
    var t = trial();
    each(box, "[data-t]", function (input) {
      var s = TRIAL.find(function (x) { return x[0] === input.dataset.t; });
      input.oninput = function () {
        t[s[0]] = Number(input.value);
        $("o-" + s[0]).textContent = s[5](t[s[0]]);
        $("try-out").innerHTML = trialOutHTML();
      };
    });
    each(box, "[data-f]", function (b) {
      b.onclick = function () {
        t.freight = b.dataset.f;
        each(box, "[data-f]", function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        $("try-out").innerHTML = trialOutHTML();
      };
    });
    box.addEventListener("click", function (ev) {
      if (!ev.target.closest("[data-open-calc]")) return;
      var cs = calcState();
      Object.assign(cs.input, { title: "", price: t.price, currency: "cny", units: 1, weight_kg: t.weight_kg, dims: { l: null, w: null, h: null }, temu_usd: t.temu_usd, freight: t.freight });
      cs.custom = null; cs.res = null;
      go("calc");
    });
  }

  // --- the workspace: members' home, every tool one click away ------------------------------

  var TOOLS = [
    ["hunt", "hunt", "شکارهای امروز", "پرفروش‌های Temu و آمازون با تأمین‌کننده‌ی 1688 و قیمت فروش پیشنهادی.", false],
    ["media", "media", "عکس و ویدیوی محصول", "عکس‌ها و ویدیوهای هر محصول، آماده‌ی دانلود برای آگهی‌ت در راینومال.", true],
    ["analyze", "analyze", "تحلیل لینک", "لینک Temu یا آمازون بده؛ تأمین‌کننده، هزینه‌ها و قیمت آماده میشه.", true],
    ["calc", "calc", "ماشین‌حساب واردات", "با فرمول قرارداد راینومال، امتیاز پنل و برنامه‌ی اولین محموله.", false],
  ];

  function renderDash() {
    var me = state.me, h = state.hunt, plan = currentPlan();
    var counts = h && h.counts || {}, total = (counts.green || 0) + (counts.yellow || 0) + (counts.red || 0);
    var open = h && !h.locked ? h.candidates : null;
    var fresh = open ? open.filter(function (c) { return c.is_new; }).length : null;
    var first = (me.name || "").trim().split(/\s+/)[0];
    var status = me.is_admin ? "مدیر سایت: دسترسی کامل به همه‌ی ابزارها."
      : me.active ? "اشتراک" + (plan ? " «" + esc(plan.name_fa) + "»" : "") + " تا " + esc(faDate(me.paid_until)) + " فعاله. همه‌ی ابزارها باز هستن."
      : "حسابت آماده‌ست. ماشین‌حساب همین حالا باز و رایگانه؛ شکارها، عکس و ویدیوها و تحلیل لینک با اشتراک باز میشن.";
    var kpi = function (k, v, s, meter, goTo, hot, id) {
      return '<button type="button" class="glass bk kpi-card' + (hot ? " hot" : "") + '" data-go="' + goTo + '"' + (id ? ' id="' + id + '"' : "") + ">" +
        '<span class="dash-label">' + k + '</span><span class="v">' + v + '</span><span class="s">' + s + "</span>" +
        (meter != null ? '<span class="meter"><i style="width:' + Math.round(meter * 100) + '%"></i></span>' : "") + "</button>";
    };
    var tools = TOOLS.map(function (t) {
      var locked = t[4] && !me.active;
      return '<button type="button" class="glass bk tool-card link' + (locked ? " locked" : "") + '" data-go="' + t[0] + '">' +
        '<span class="ib">' + ic(t[1]) + "</span><h3>" + t[2] + (locked ? " " + ic("lock") : "") + "</h3><p>" + t[3] + "</p>" +
        '<span class="go">' + (locked ? "نیاز به اشتراک" : "باز کن") + ic("back") + "</span></button>";
    }).join("");
    var colors = { green: "var(--good)", yellow: "var(--warn)", red: "var(--bad)" };
    var verdicts = [["green", counts.green || 0], ["yellow", counts.yellow || 0], ["red", counts.red || 0]];
    $("main").innerHTML =
      '<div class="dash-head"><div><span class="dash-label">' + (h ? "آخرین شکار: " + esc(faDate(h.started_at)) + (h.sample ? " · داده‌ی نمونه" : "") : "هنوز شکاری انجام نشده") + "</span>" +
        "<h1>" + (first ? "سلام " + esc(first) + "، " : "") + "میز کارت آماده‌ست</h1><p>" + status + "</p></div>" +
        '<div class="actions"><button type="button" class="btn ghost" data-go="calc">' + ic("calc") + "ماشین‌حساب</button>" +
          (me.active ? '<button type="button" class="btn" data-go="hunt">' + ic("hunt") + "شکارهای امروز</button>"
            : '<button type="button" class="btn" data-go="account">' + ic("coin") + "خرید اشتراک</button>") + "</div></div>" +
      '<div class="kpis4">' +
        kpi("شکار خوب امروز", total ? count(counts.green || 0) : "—", total ? "از " + count(total) + " محصول بررسی‌شده" : "منتظر اولین شکار", total ? (counts.green || 0) / total : null, "hunt", true) +
        kpi("جدید امروز", fresh != null ? count(fresh) : "—", fresh != null ? "محصولی که دیروز نبود" : "با اشتراک باز میشه", null, "hunt") +
        kpi("تحلیل لینک", me.active ? linksLeft() : "—", me.active ? "سهمیه‌ی باقی‌مونده‌ی این ماه" : "با اشتراک باز میشه", null, "analyze", false, "p-links") +
        kpi("بودجه‌ی شروع", "$" + count(Math.round(me.budget_usd || 0)), "برای شکارهای اختصاصی · تغییر", null, "account") +
      "</div>" +
      '<div class="dash-row">' + findsHTML() +
        '<section class="glass bk panel-lite" style="padding:16px 18px"><div class="panel-h"><h2>' + ic("chart") + "حکم شکار امروز</h2></div>" +
          '<div class="hint">' + (total ? toman(total) + " پرفروش بررسی‌شده" : "هنوز شکاری نیست") + "</div>" +
          '<div class="vsplit">' + verdicts.map(function (v) { return v[1] ? '<i style="flex:' + v[1] + ";background:" + colors[v[0]] + '"></i>' : ""; }).join("") + "</div>" +
          verdicts.map(function (v) { return '<div class="vrow"><span class="pill ' + v[0] + '"><span class="dot"></span>' + VERDICT[v[0]] + '</span><span class="num">' + count(v[1]) + "</span></div>"; }).join("") +
        "</section>" +
      "</div>" +
      '<div class="tools4">' + tools + "</div>" +
      quickHTML();
    bindDash();
  }

  function linksLeft() {
    var j = state.jobs, plan = currentPlan();
    if (j && j.quota != null) return count(j.left);
    return plan ? count(plan.links) : state.config.monthly_links ? count(state.config.monthly_links) : "—";
  }

  function quickHTML() {
    var me = state.me, calcUsed = !!memo().last, analysed = !!(state.analysis || state.jobs && state.jobs.items && state.jobs.items.length);
    var steps = [
      [true, "حساب ساختی", "خوش اومدی به شکارچی.", null],
      [me.categories && me.categories.length > 0, "دسته‌ها و بودجه‌ات رو مشخص کن", "تا شکارهای اختصاصی برای خودت انتخاب بشن.", "account"],
      [calcUsed, "یه محصول رو در ماشین‌حساب بسنج", "قیمت 1688 و وزن کافیه؛ سهم راینومال خودش حساب میشه.", "calc"],
      [!!me.active, "اشتراک بگیر", "شکارها، عکس و ویدیوها و تحلیل لینک باز میشن.", "account"],
      [analysed, "اولین لینکت رو تحلیل کن", "محصولی که خودت پیدا کردی.", "analyze"],
    ];
    var done = steps.filter(function (s) { return s[0]; }).length;
    return '<section class="glass bk quick" style="padding:16px 18px"><div class="panel-h"><h2>' + ic("rocket") + "شروع سریع</h2>" +
      '<span class="num hint">' + done + "/" + steps.length + "</span></div>" +
      '<div class="groove" role="progressbar" aria-valuemin="0" aria-valuemax="' + steps.length + '" aria-valuenow="' + done + '" aria-label="پیشرفت شروع"><i style="width:' + Math.round(done / steps.length * 100) + '%"></i></div>' +
      '<ol class="checklist">' + steps.map(function (s) {
        return '<li class="' + (s[0] ? "done" : "") + '"><span class="tick">' + ic(s[0] ? "check" : "chev") + "</span><div><b>" + s[1] + "</b><span>" + s[2] + "</span></div>" +
          (!s[0] && s[3] ? '<button type="button" class="btn ghost small" data-go="' + s[3] + '">برو</button>' : "") + "</li>";
      }).join("") + "</ol></section>";
  }

  function findsHTML() {
    var h = state.hunt;
    var list = (h && h.candidates || []).slice().sort(function (a, b) {
      var rank = { green: 0, yellow: 1, red: 2 };
      return rank[a.verdict] - rank[b.verdict] || b.score - a.score;
    }).slice(0, 5);
    var rows = list.map(function (c) {
      var p = c.pricing;
      return '<tr class="go" data-go="hunt"><td><div class="pt"><span class="sq">' + esc((c.title_fa || "?").trim().charAt(0)) + '</span><div class="pn">' +
          esc(c.title_fa || c.listing && c.listing.title || "") + "<small>" + esc(catName(c.category)) + "</small></div></div></td>" +
        '<td><span class="pill ' + c.verdict + '"><span class="dot"></span>' + VERDICT[c.verdict] + "</span>" + (c.is_new ? ' <span class="pill new">جدید</span>' : "") + "</td>" +
        (p ? '<td class="num">' + usd(p.price_usd) + '</td><td class="num" style="color:var(--good)">' + usd(p.profit_usd) + "</td>"
          : '<td colspan="2" class="hint">' + ic("lock") + " با اشتراک</td>") +
        '<td><div class="scorebar"><i><s style="width:' + c.score + '%"></s></i><span class="num">' + c.score + "</span></div></td></tr>";
    }).join("");
    return '<section class="glass bk" style="padding:16px 18px;min-width:0"><div class="panel-h"><h2>' + ic("spark") + "بهترین‌های امروز</h2>" +
      '<button type="button" class="btn ghost small" data-go="hunt">همه‌ی شکارها' + ic("back") + "</button></div>" +
      (rows ? '<div class="scroll"><table class="finds-table"><thead><tr><th>محصول</th><th>وضعیت</th><th>قیمت فروش</th><th>سود هر عدد</th><th>امتیاز</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
          (h.locked ? '<p class="hint" style="margin:10px 0 0">قیمت‌ها و تأمین‌کننده با اشتراک باز میشه.</p>' : "")
        : '<div class="empty">هنوز شکاری انجام نشده.</div>') + "</section>";
  }

  function bindDash() {
    if (state.jobs === undefined && !DEMO && state.config.links && state.me.active) {
      state.jobs = null;
      loadJobs().then(function () {
        var box = $("p-links");
        if (state.tab === "dash" && box) box.querySelector(".v").textContent = linksLeft();
      });
    }
  }

  // --- pictures and videos of each product, to download for the seller's own listing ----------

  function mediaProducts() {
    var seen = {}, out = [];
    [].concat(state.hunt && !state.hunt.locked && state.hunt.candidates || [],
      (state.jobs && state.jobs.items || []).map(function (j) { return j.result; }), state.analysis ? [state.analysis] : [])
      .forEach(function (c) { if (c && c.id && !seen[c.id] && c.offer) { seen[c.id] = true; out.push(c); } });
    return out;
  }
  function openMedia(id) { state.mediaId = id; go("media"); }

  function renderMedia() {
    var main = $("main");
    if (!state.me.active) { main.innerHTML = lockedHTML(); return; }
    if (state.jobs === undefined && !DEMO && state.config.links) {
      state.jobs = null;
      loadJobs().then(function () { if (state.tab === "media") renderMedia(); });
    }
    var list = mediaProducts();
    if (!state.mediaId && list.length) state.mediaId = list[0].id;
    main.innerHTML =
      '<div class="page-head"><div><span class="eyebrow">برای آگهی‌ت در راینومال</span><h1 class="section-title">عکس و ویدیوی محصول‌ها</h1>' +
      '<p class="section-sub" style="margin:0">عکس‌ها و ویدیوهای هر محصول از 1688، Temu و آمازون، از طریق سرور ما (از داخل ایران هم دانلود میشه). هر عکس رو اصلی بگیر یا مربعی سفید ' + ltr("1200×1200") + " که فروشگاه‌ها می‌خوان.</p></div></div>" +
      '<div class="notice info"><b>قرارداد راینومال:</b> فقط عکسی رو در آگهی بذار که واقعاً همون کالای انبارت رو نشون بده؛ اطلاعات غلط درباره‌ی محصول تخلفه (بند ۱۱-۲). هر ماه یه بار هم می‌تونی از راینومال عکس واضح کالای خودت در انبار رو بخوای (بند ۳-۴).</div>' +
      (list.length
        ? '<div class="media"><nav class="glass bk media-list" aria-label="محصول‌ها">' + list.map(function (c) {
            return '<button type="button" data-mid="' + esc(c.id) + '" aria-current="' + (c.id === state.mediaId) + '"><span class="sq">' + esc((c.title_fa || "?").trim().charAt(0)) + '</span><span class="t">' +
              esc(c.title_fa || c.listing && c.listing.title || "") + "<small>" + esc(catName(c.category)) + " · " + VERDICT[c.verdict] + "</small></span></button>";
          }).join("") + '</nav><section class="glass bk media-view" id="media-view"><p class="loading">در حال آوردن عکس‌ها…</p></section></div>'
        : '<div class="empty">هنوز محصولی نداری. از «شکارهای امروز» یا «تحلیل لینک» شروع کن.</div>');
    each(main, "[data-mid]", function (b) { b.onclick = function () { state.mediaId = b.dataset.mid; renderMedia(); }; });
    if (list.length) loadMedia(list.find(function (c) { return c.id === state.mediaId; }) || list[0]);
  }

  function loadMedia(c) {
    var box = $("media-view");
    state.mediaCache = state.mediaCache || {};
    var got = state.mediaCache[c.id] ? Promise.resolve(state.mediaCache[c.id])
      : DEMO ? Promise.resolve(demoMedia(c)) : api("/api/media?id=" + encodeURIComponent(c.id));
    got.then(function (m) {
      state.mediaCache[c.id] = m;
      if (state.tab !== "media" || state.mediaId !== c.id || !$("media-view")) return;
      box.innerHTML = mediaHTML(c, m);
      bindMedia(box, c, m);
    }, function (e) { box.innerHTML = '<div class="empty">' + esc(errText(e)) + "</div>"; });
  }

  function mediaHTML(c, m) {
    var title = m.title || c.title_fa || "";
    var src = function (x) { return { "1688": "1688", temu: "Temu", amazon: "آمازون" }[x.source] || x.source || ""; };
    var file = function (x, n, extra) { return DEMO ? "#" : "/media/file?u=" + encodeURIComponent(x.url) + "&name=" + encodeURIComponent(title) + "&n=" + n + (extra || ""); };
    var view = function (x) { return DEMO ? x.url : "/img?u=" + encodeURIComponent(x.url); };
    var pics = m.images.map(function (x, n) {
      return '<figure class="media-item" style="margin:0"><div class="pic"><img src="' + esc(view(x)) + '" alt="عکس ' + toman(n + 1) + " " + esc(title) + '" loading="lazy"><span class="src">' + esc(src(x)) + "</span></div>" +
        '<div class="acts"><a class="btn ghost" data-dl href="' + esc(file(x, n + 1)) + '">' + ic("download") + "اصلی</a>" +
        '<a class="btn" data-dl href="' + esc(file(x, n + 1, "&ready=1")) + '">' + ic("download") + "آماده‌ی آگهی</a></div></figure>";
    }).join("");
    var vids = m.videos.map(function (x, n) {
      return '<figure class="media-item" style="margin:0"><div class="pic">' +
        (DEMO ? '<span class="hint" style="padding:12px;text-align:center">' + ic("video") + "<br>ویدیوی نمونه</span>"
          : '<video src="' + esc(file(x, n + 1, "&inline=1")) + '" controls preload="none" playsinline></video>') +
        '<span class="src">' + esc(src(x)) + "</span></div>" +
        '<div class="acts"><a class="btn" data-dl href="' + esc(file(x, n + 1)) + '">' + ic("download") + "دانلود ویدیو</a></div></figure>";
    }).join("");
    return '<div class="panel-h"><h2>' + ic("media") + esc(title) + "</h2>" +
      (m.images.length ? '<a class="btn" data-dl href="' + (DEMO ? "#" : "/media/zip?id=" + encodeURIComponent(c.id)) + '">' + ic("zip") + "دانلود همه‌ی عکس‌ها (ZIP)</a>" : "") + "</div>" +
      '<p class="hint" style="margin:0">' + toman(m.images.length) + " عکس · " + toman(m.videos.length) + " ویدیو" +
        (m.page_read === false ? " · صفحه‌ی 1688 این محصول خونده نشد؛ فقط عکس‌های آگهی" : "") + (DEMO ? " · در نسخه‌ی نمایشی عکس‌ها نمونه‌ان" : "") + "</p>" +
      (pics ? '<h3 class="media-h3">' + ic("media") + 'عکس‌ها</h3><div class="media-grid">' + pics + "</div>" : '<div class="empty" style="margin-top:12px">برای این محصول عکسی پیدا نشد.</div>') +
      (vids ? '<h3 class="media-h3">' + ic("video") + 'ویدیوها</h3><div class="media-grid">' + vids + "</div>" : '<p class="hint" style="margin-top:14px">این محصول ویدیو نداره.</p>');
  }
  function bindMedia(box) {
    if (!DEMO) return;
    each(box, "[data-dl]", function (a) {
      a.onclick = function (ev) { ev.preventDefault(); toast("در نسخه‌ی واقعی فایل همین‌جا دانلود میشه."); };
    });
  }

  // The demo has no pictures of its own: labelled stand-ins, so the page can be seen working.
  function demoMedia(c) {
    var title = c.title_fa || "محصول", words = title.split(/\s+/).slice(0, 3).join(" ");
    var pic = function (n, label) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><rect width="600" height="600" fill="#161616"/>' +
        '<rect x="40" y="40" width="520" height="520" fill="none" stroke="#fac507" stroke-width="2" stroke-dasharray="10 8"/>' +
        '<text x="300" y="285" font-family="Vazirmatn,Tahoma,sans-serif" font-size="40" font-weight="700" fill="#f2f2f2" text-anchor="middle" direction="rtl">' + esc(words) + "</text>" +
        '<text x="300" y="345" font-family="Vazirmatn,Tahoma,sans-serif" font-size="28" fill="#fac507" text-anchor="middle" direction="rtl">' + label + " " + toman(n) + "</text></svg>";
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    };
    return {
      id: c.id, title: title, page_read: true,
      images: [1, 2, 3, 4].map(function (n) { return { url: pic(n, "عکس نمونه"), source: n < 4 ? "1688" : (c.listing && c.listing.source) || "temu" }; }),
      videos: [{ url: "", source: "1688" }],
    };
  }

  // --- hunt tab ------------------------------------------------------------------

  function huntHTML() {
    var h = state.hunt;
    if (!h) return '<div class="empty">هنوز شکاری انجام نشده. مدیر سایت باید دستور <span class="num">python -m hunter hunt</span> رو اجرا کنه.</div>';
    var counts = h.counts || {};
    var fresh = h.candidates.filter(function (c) { return c.is_new; }).length;
    var head =
      '<div class="page-head"><div><span class="eyebrow">آخرین جستجو: ' + esc(faDate(h.started_at)) + "</span>" +
      '<h1 class="section-title">شکارهای امروز</h1>' +
      '<p class="section-sub" style="margin:0">هر محصول با قیمت واقعی Temu و آمازون مقایسه شده؛ سبزها رو می‌شه با خیال راحت آورد.</p></div></div>' +
      (h.sample ? '<div class="notice"><b>داده‌ی نمونه:</b> ' + esc(h.note || "این اعداد برای نمایش‌ان.") + "</div>" : "") +
      '<div class="summary">' +
        '<span class="pill green"><span class="dot"></span>' + toman(counts.green || 0) + " شکار خوب</span>" +
        '<span class="pill yellow"><span class="dot"></span>' + toman(counts.yellow || 0) + " با احتیاط</span>" +
        '<span class="pill red"><span class="dot"></span>' + toman(counts.red || 0) + " نیار</span>" +
        (fresh ? '<span class="pill new">' + toman(fresh) + " محصول جدید امروز</span>" : "") +
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
    if (v) each(v, "button", function (b) {
      b.onclick = function () { state.filter.verdict = b.dataset.v; render(); };
    });
    var fresh = $("flt-new");
    if (fresh) fresh.onclick = function () { state.filter.fresh = !state.filter.fresh; render(); };
  }

  // --- picks tab -----------------------------------------------------------------

  function renderPicks() {
    var main = $("main");
    if (!state.me.active) { main.innerHTML = lockedHTML(); return; }
    if (!state.picks && !DEMO) {
      main.innerHTML = '<p class="loading">در حال انتخاب محصول برای تو…</p>';
      api("/api/picks").then(function (p) { state.picks = p; render(); }, function (e) {
        main.innerHTML = '<div class="empty">' + esc(errText(e)) + "</div>";
      });
      return;
    }
    var p = state.picks || { candidates: [] };
    main.innerHTML =
      '<div class="page-head"><div><span class="eyebrow">فقط برای تو</span><h1 class="section-title">شکارهای اختصاصی من</h1>' +
      '<p class="section-sub" style="margin:0">از بین شکارهای امروز، این‌ها با دسته‌ها و بودجه‌ات جور درمیان. هر محصول حداکثر به ' +
        toman(p.per_product || 3) + " فروشنده داده میشه تا با هم رقابت نکنید.</p></div>" +
      '<button type="button" class="btn ghost small" data-go="account">تغییر دسته‌ها و بودجه' + ic("sliders") + "</button></div>" +
      '<div class="summary"><span class="pill neutral">بودجه: <span class="num">' + usd(p.budget_usd) + '</span></span><span class="pill neutral">سرمایه‌ی لازم برای همه: <span class="num">' +
        usd(p.capital_usd) + "</span></span></div>" +
      (p.candidates.length ? '<div class="grid">' + p.candidates.map(cardHTML).join("") + "</div>"
        : '<div class="empty">فعلاً محصولی با دسته‌ها و بودجه‌ی تو جور نشد. دسته‌های بیشتری انتخاب کن یا فردا دوباره سر بزن.</div>');
    bindCards(main);
  }

  function lockedHTML() {
    return '<div class="empty">' + ic("lock") + " این بخش برای مشترک‌هاست.<br>" +
      '<button type="button" class="btn" data-go="account" style="margin-top:14px">خرید اشتراک' + ic("coin") + "</button></div>";
  }

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
          '<div class="error" id="links-error"></div><div><button class="btn" type="submit">تحلیل کن' + ic("search") + "</button></div>" +
        "</form>" +
        '<div class="jobs" id="jobs">' + jobsHTML() + "</div>"
      : '<div class="notice"><b>تحلیل با لینک هنوز فعال نشده.</b> مدیر سایت باید کلید Keepa یا Apify رو تنظیم کنه. فعلاً از تحلیل دستی پایین استفاده کن.</div>';
    return '<div class="page-head"><div><span class="eyebrow">محصولی که خودت پیدا کردی</span><h1 class="section-title">تحلیل محصول‌های خودم</h1>' +
      '<p class="section-sub" style="margin:0">لینک بفرست تا کامل تحلیل بشه: تأمین‌کننده در 1688، مقایسه با Temu و آمازون، همه‌ی هزینه‌ها و قیمت فروش.</p></div></div>' +
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
      '</div><div class="error" id="an-error"></div><button class="btn" type="submit">تحلیل کن' + ic("search") + "</button></form>" +
      (a ? '<div style="margin-top:18px" class="grid">' + cardHTML(a) + "</div>" : "") +
      "</details>";
  }

  function jobsHTML() {
    var items = state.jobs && state.jobs.items || [];
    if (!items.length) return "";
    return '<h2 class="section-title">تحلیل‌های من</h2>' + items.map(function (j) {
      var st = STATUS[j.status] || STATUS.queued;
      var cached = j.result && j.result.from_cache ? '<span class="pill neutral">از قبل تحلیل شده بود</span>' : "";
      var head = '<div class="job"><span class="url">' + esc(j.url) + "</span>" + cached + '<span class="pill ' + st[0] + '"><span class="dot"></span>' + st[1] + "</span></div>";
      if (j.status === "done" && j.result) return "<div>" + head + '<div class="job-result grid">' + cardHTML(j.result) + "</div></div>";
      if (j.status === "failed") return "<div>" + head + '<p class="error" style="margin:4px 4px 0">' + esc(LINK_ERRORS[j.error] || j.error || "") + "</p></div>";
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
    return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input num" id="' + id + '" type="number" inputmode="decimal" min="0" step="' + step + '" value="' + value + '"></div>';
  }
  function bindAnalyze() {
    var form = $("an-form");
    if (!form) return;
    if (state.jobs === undefined && !DEMO && state.config.links) {
      state.jobs = null;
      loadJobs().then(function () { if (state.tab === "analyze") { $("jobs").innerHTML = jobsHTML(); bindCards($("jobs")); pollJobs(); } });
    } else {
      pollJobs();
    }
    each(document, "[data-link]", function (b) {
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
        monthly_sold: v("an-sold"), reviews: v("an-reviews"),
      };
      $("an-error").textContent = "";
      if (!body.price_cny || !body.weight_kg) { $("an-error").textContent = "قیمت 1688 و وزن لازمه."; return; }
      var ids = ["an-title", "an-cny", "an-weight", "an-temu", "an-amazon", "an-lpack", "an-moq", "an-sold", "an-reviews"];
      var done = function (res) {
        var typed = {};
        ids.forEach(function (id) { typed[id] = $(id).value; });
        state.analysis = res; render();
        document.querySelector(".manual").open = true;
        ids.forEach(function (id) { $(id).value = typed[id]; });  // keep what was typed
      };
      if (DEMO) {
        var res = demoAnalyze(body);
        if (res) done(res); else $("an-error").textContent = ERRORS.unprofitable_settings;
        return;
      }
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
    var quota = (currentPlan() || {}).links || state.config.monthly_links;
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
    var current = currentPlan();
    var status = me.active
      ? (me.is_admin ? "مدیر سایت: دسترسی کامل." : "اشتراک" + (current ? " «" + esc(current.name_fa) + "»" : "") + " تا " + esc(faDate(me.paid_until)) + " فعاله.")
      : "اشتراک فعالی نداری.";
    return '<div class="page-head"><div><span class="eyebrow">' + esc(me.email) + '</span><h1 class="section-title">حساب من</h1></div>' +
      '<button type="button" class="btn ghost small" data-logout>' + "خروج از حساب" + ic("logout") + "</button></div>" +
      '<div class="stack">' +
      '<section class="panel"><h2 class="section-title">اشتراک</h2><p class="section-sub">' + status + "</p>" +
        '<div class="plans">' + plansHTML(true) + "</div>" +
        (cfg.online_payment ? "" : '<p class="hint">پرداخت آنلاین هنوز فعال نشده؛ بعد از کارت‌به‌کارت، پشتیبانی اشتراکت رو فعال می‌کنه: ' + supportLine() + "</p>") +
        '<div class="error" id="pay-error"></div></section>' +
      '<form class="panel" id="profile-form"><h2 class="section-title">مشخصات و علاقه‌مندی</h2>' +
        '<p class="section-sub">شکارهای اختصاصی از روی این دسته‌ها و بودجه‌ات انتخاب میشن. هیچ دسته‌ای نزنی یعنی همه.</p>' +
        '<div class="form-grid" style="margin-bottom:16px">' +
          '<div class="field"><label for="p-name">نام</label><input class="input" id="p-name" value="' + esc(me.name) + '"></div>' +
          '<div class="field"><label for="p-phone">موبایل</label><input class="input num" id="p-phone" value="' + esc(me.phone) + '"></div>' +
          '<div class="field"><label for="p-budget">بودجه‌ی شروع (دلار)</label><input class="input num" id="p-budget" type="number" min="0" step="50" value="' + esc(me.budget_usd) + '"><span class="hint">هزینه‌ی اولین محموله‌ی همه‌ی محصولات با هم</span></div>' +
        "</div>" +
        '<div class="label" style="margin-bottom:6px">دسته‌هایی که کار می‌کنی</div><div class="cats">' + cats + "</div>" +
        '<div class="error" id="profile-error"></div><button class="btn" type="submit">ذخیره' + ic("save") + "</button></form>" +
      supportHTML() +
      (me.is_admin ? adminHTML() : "") +
    "</div>";
  }

  // For the site's admin: activate a seller who paid by bank transfer.
  function adminHTML() {
    var plans = state.config.plans.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name_fa) + "</option>"; }).join("");
    return '<form class="panel" id="grant-form"><h2 class="section-title">مدیریت: فعال کردن اشتراک فروشنده</h2>' +
      '<p class="section-sub">برای فروشنده‌ای که کارت‌به‌کارت پرداخت کرده. اول باید روی سایت ثبت‌نام کرده باشه؛ اگه اشتراکش هنوز فعاله، روزها به آخرش اضافه میشه.</p>' +
      '<div class="form-grid" style="margin-bottom:16px">' +
        '<div class="field"><label for="g-email">ایمیل فروشنده</label><input class="input" id="g-email" type="email" dir="ltr" required></div>' +
        '<div class="field"><label for="g-plan">پلن</label><select class="input" id="g-plan">' + plans + "</select></div>" +
        '<div class="field"><label for="g-days">چند روز</label><input class="input num" id="g-days" type="number" min="1" step="1" value="30"></div>' +
      "</div>" +
      '<div class="error" id="grant-error"></div><button class="btn" type="submit">فعال کن' + ic("check") + "</button></form>";
  }
  function bindAccount() {
    each(document, "[data-plan]", function (b) {
      b.onclick = function () {
        if (DEMO) { toast("در نسخه‌ی واقعی اینجا به درگاه زرین‌پال می‌ری."); return; }
        b.disabled = true;
        api("/api/pay", { method: "POST", body: { plan: b.dataset.plan } }).then(function (r) {
          window.location.href = r.redirect_url;
        }, function (e) { b.disabled = false; $("pay-error").textContent = errText(e); });
      };
    });
    var grant = $("grant-form");
    if (grant) grant.onsubmit = function (ev) {
      ev.preventDefault();
      var body = { email: $("g-email").value, plan: $("g-plan").value, days: Number($("g-days").value || 30) };
      $("grant-error").textContent = "";
      if (DEMO) { toast("در نسخه‌ی واقعی اشتراک " + body.email + " فعال میشه."); return; }
      api("/api/admin/grant", { method: "POST", body: body }).then(function (r) {
        toast("اشتراک " + r.email + " تا " + faDate(r.paid_until) + " فعال شد.");
        $("g-email").value = "";
      }, function (e) { $("grant-error").textContent = errText(e); });
    };
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

  // --- calculator (everyone, logged in or not) -------------------------------------------

  var CALC_KEY = "hunter.calc.v1";  // last inputs and saved scenarios, in this browser only
  // Where the selling price goes; each part keeps its colour (c1..c5) whichever are shown.
  var PARTS = [
    ["profit", "سود تو"], ["buy", "خرید و ایجنت"], ["ship", "حمل تا دبی"],
    ["fee", "سهم راینومال"], ["other", "درگاه، تبلیغات و مرجوعی"],
  ];
  var SPLIT_FA = {
    fee: "کمیسیون پلتفرم", ads: "تبلیغات و بازاریابی", storage: "انبارداری در دبی",
    packaging: "بسته‌بندی نهایی", delivery: "ارسال به مشتری", promo: "تخفیف‌ها و ارجاع",
  };
  function partIndex(key) { return PARTS.findIndex(function (x) { return x[0] === key; }) + 1; }
  function partName(key) {
    var n = PARTS.find(function (x) { return x[0] === key; })[1];
    return key === "fee" ? n + " (" + toman(sharePct()) + "٪)" : n;
  }
  // Parts with nothing in them (the contract has no gateway, ads or returns cut) aren't shown.
  function visibleParts(parts) { return parts.filter(function (p) { return p.key === "profit" || Math.abs(p.value) >= 0.005; }); }
  var ADV = [
    ["platform_pct", "کمیسیون فروشگاه", "%"], ["gateway_pct", "کارمزد درگاه", "%"], ["marketing_pct", "تبلیغات", "%"],
    ["returns_pct", "ذخیره‌ی مرجوعی", "%"], ["target_margin", "حاشیه‌ی سود هدف", "%"], ["china_side_pct", "ایجنت و حمل داخل چین", "%"],
    ["undercut", "چقدر زیر Temu بفروشیم", "%"], ["freight_usd_per_kg", "کرایه تا دبی، دلار/کیلو", "$"],
    ["packaging_usd", "بسته‌بندی هر عدد، دلار", "$"], ["cny_per_usd", "یوان در هر دلار", ""],
  ];
  var FREIGHT_NOTE = {
    sea: "دریایی: ارزون ولی کند، حدود ۳ تا ۶ هفته",
    site: "نرخ پیش‌فرض سایت (ترکیب رایج)",
    air: "هوایی: سریع ولی گرون، حدود ۱ هفته",
    custom: "نرخی که خودت وارد کردی",
  };

  function memo() { try { return JSON.parse(localStorage.getItem(CALC_KEY)) || {}; } catch (e) { return {}; } }
  function memoSet(patch) { try { localStorage.setItem(CALC_KEY, JSON.stringify(Object.assign(memo(), patch))); } catch (e) { /* storage off */ } }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function calcDefaults() {
    var p = state.config.pricing;
    return {
      title: "", price: 21, currency: "cny", units: 1, weight_kg: 0.35, dims: { l: null, w: null, h: null },
      temu_usd: 12.99, amazon_usd: 19.99, market: "prepaid", items_per_cart: p.items_per_cart, freight: "site", license: "new",
      qty: p.min_starter_qty, monthly_sales: 40, toman_per_usd: state.config.toman_per_usd || 234500, cfg: {},
    };
  }
  function calcState() {
    if (!state.calc) {
      var input = Object.assign(calcDefaults(), memo().last || {});
      input.dims = input.dims || { l: null, w: null, h: null }; input.cfg = input.cfg || {};
      state.calc = { input: input, custom: null, res: null, view: "chart" };
    }
    return state.calc;
  }
  function calcRun(i) {
    if (!(i.price > 0) || !(i.weight_kg > 0)) return null;
    return Calc.compute({
      price: i.price, currency: i.currency, units: i.units || 1, weight_kg: i.weight_kg,
      dims: { l: Number(i.dims.l) || 0, w: Number(i.dims.w) || 0, h: Number(i.dims.h) || 0 },
      temu_usd: i.temu_usd || null, amazon_usd: i.amazon_usd || null, market: i.market,
      freight: i.freight === "site" || i.freight === "custom" ? null : i.freight,
      items_per_cart: i.items_per_cart, cfg: i.cfg,
    }, state.config.pricing);
  }
  function atPrice(res, price) {
    var now = Object.assign({}, res, Calc.at(res, price));
    now.vs_benchmark = res.benchmark_usd ? price / res.benchmark_usd : null;
    now.vs_amazon = res.amazon_usd ? price / res.amazon_usd : null;
    now.verdict = Calc.verdict(now.margin, now.vs_benchmark, res.cfg);
    return now;
  }
  function activePrice() { var cs = state.calc; return cs.custom != null ? cs.custom : cs.res.recommended_usd; }
  function snap(p) { return Math.max(0.49, Math.round((p + 0.01) * 2) / 2 - 0.01); }  // nearest .49 / .99

  function openInCalc(c) {
    if (!c || !c.pricing) return;
    var base = calcState().input, p = c.pricing, d = calcDefaults();
    state.calc = {
      input: Object.assign(d, {
        monthly_sales: base.monthly_sales, toman_per_usd: base.toman_per_usd,
        title: c.title_fa || (c.listing && c.listing.title) || "", price: c.offer.price_cny, units: c.pack_qty || 1,
        weight_kg: c.weight_kg, temu_usd: p.benchmark_estimated ? null : p.benchmark_usd, amazon_usd: p.amazon_usd,
        qty: c.starter_qty || d.qty,
      }),
      custom: null, res: null, view: "chart",
    };
    go("calc");
  }

  function renderCalc() {
    var cs = calcState();
    $("main").innerHTML =
      '<div class="page-head"><div><span class="eyebrow">رایگان · همون فرمول‌های موتور شکار</span><h1 class="section-title">ماشین‌حساب واردات از چین</h1>' +
      '<p class="section-sub" style="margin:0">از قیمت 1688 تا سود خالص تو: همه‌ی هزینه‌ها تا انبار دبی و دست مشتری، قیمت فروش پیشنهادی کنار Temu و آمازون، و برنامه‌ی اولین محموله به تومان.</p></div>' +
      '<button type="button" class="btn ghost small" id="calc-reset">شروع از اول' + ic("reset") + "</button></div>" +
      '<div class="calc">' + calcFormHTML(cs.input) + '<div class="calc-out" id="calc-out"></div></div>' +
      (state.me ? "" :
        '<section class="panel guest-cta" style="margin-top:20px"><div><h2 class="section-title">محصول‌هایی که این حساب‌وکتاب رو پاس می‌کنن، هر روز آماده</h2>' +
        '<p class="section-sub" style="margin:0">موتور شکار هر روز پرفروش‌های Temu و آمازون رو با همین فرمول‌ها حساب می‌کنه و سبزها رو با تأمین‌کننده‌ی 1688 تحویلت می‌ده.</p></div>' +
        '<button type="button" class="btn" data-go="signup">ساخت حساب' + ic("back") + "</button></section>");
    bindCalc();
    calcUpdate();
  }

  function calcFormHTML(i) {
    function nf(k, label, v, step, hint) {
      var id = "c-" + k.replace(".", "-");
      return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input num" id="' + id + '" data-k="' + k +
        '" type="number" inputmode="decimal" min="0" step="' + step + '" value="' + (v == null ? "" : esc(v)) + '">' + (hint || "") + "</div>";
    }
    function seg(name, opts) {
      return '<div class="seg" role="group" data-seg="' + name + '">' + opts.map(function (o) {
        return '<button type="button" data-v="' + o[0] + '" aria-pressed="' + (i[name] === o[0]) + '">' + (o[2] ? ic(o[2]) : "") + o[1] + "</button>";
      }).join("") + "</div>";
    }
    function group(n, icon, title, body) {
      return '<div class="calc-group"><h2 class="calc-h"><span class="n">0' + n + "</span>" + ic(icon) + title + "</h2>" + body + "</div>";
    }
    var dims = ["l", "w", "h"].map(function (k, n) {
      return '<input class="input num" data-k="dims.' + k + '" type="number" inputmode="decimal" min="0" step="1" placeholder="' +
        ["طول", "عرض", "ارتفاع"][n] + '" aria-label="' + ["طول", "عرض", "ارتفاع"][n] + ' (سانتی‌متر)" value="' + (i.dims[k] == null ? "" : esc(i.dims[k])) + '">';
    }).join("");
    var adv = ADV.map(function (a) {
      return '<div class="field"><label for="c-cfg-' + a[0] + '">' + a[1] + (a[2] === "%" ? " (%)" : "") + '</label><input class="input num" id="c-cfg-' + a[0] +
        '" data-cfg="' + a[0] + '" data-unit="' + a[2] + '" type="number" inputmode="decimal" min="0" step="any"></div>';
    }).join("");
    return '<form class="panel calc-form" id="calc-form" novalidate autocomplete="off">' +
      group(1, "box", "محصول در 1688",
        '<div class="field"><label for="c-title">اسم محصول (اختیاری)</label><input class="input" id="c-title" data-k="title" dir="auto" value="' + esc(i.title) + '" placeholder="مثلاً: کیف لوازم آرایش سفری"></div>' +
        '<div class="field"><label for="c-price">قیمت هر عدد در 1688</label><div class="price-in"><input class="input num" id="c-price" data-k="price" type="number" inputmode="decimal" min="0" step="0.01" value="' + (i.price == null ? "" : esc(i.price)) + '">' +
          seg("currency", [["cny", "¥ یوان"], ["usd", "$ دلار"]]) + "</div></div>" +
        '<div class="two">' + nf("units", "چند عدد در هر آگهی", i.units, 1) + nf("weight_kg", "وزن هر آگهی، کیلو", i.weight_kg, 0.01) + "</div>" +
        '<div class="field"><span class="label">ابعاد بسته، سانتی‌متر (اختیاری)</span><div class="three">' + dims + '</div><span class="hint" id="calc-vol"></span></div>') +
      group(2, "scale", "بازار و مشتری",
        '<div class="two">' + nf("temu_usd", "قیمت Temu، دلار", i.temu_usd, 0.01) + nf("amazon_usd", "قیمت آمازون، دلار", i.amazon_usd, 0.01) + "</div>" +
        '<div class="field"><span class="label">امتیاز پنل راینومال (' + ltr(usd(state.config.pricing.license_usd || 0)) + ")</span>" +
          seg("license", [["new", "پرداخت می‌کنم"], ["exempt", "معافم (شریک قبلی)"]]) +
          '<span class="hint">در ' + toman(state.config.pricing.license_installments || 10) + " قسط از درآمد؛ شرکای قبلی معافن (بند ۴ قرارداد).</span></div>" +
        nf("items_per_cart", "چند قلم در هر سفارش مشتری", i.items_per_cart, 1, '<span class="hint">هزینه‌ی ارسال بین اقلام یه سفارش تقسیم میشه</span>')) +
      group(3, "truck", "حمل تا انبار دبی",
        seg("freight", [["sea", "دریایی", "ship"], ["site", "ترکیبی", "truck"], ["air", "هوایی", "plane"]]) +
        '<span class="hint" id="calc-freight"></span>') +
      group(4, "cart", "برنامه‌ی خرید",
        '<div class="two">' + nf("qty", "تعداد اولین سفارش", i.qty, 1) + nf("monthly_sales", "فروش ماهانه‌ی تو (تخمین)", i.monthly_sales, 1) + "</div>" +
        nf("toman_per_usd", "نرخ دلار، تومان", i.toman_per_usd, 500)) +
      '<details id="calc-adv"><summary>' + ic("sliders") + "کارمزدها و فرض‌های هزینه</summary><div>" +
        '<div class="two">' + adv + "</div>" +
        '<button type="button" class="btn ghost small" id="calc-adv-reset">برگشت به پیش‌فرض سایت' + ic("reset") + "</button></div></details>" +
      "</form>";
  }

  function bindCalc() {
    var cs = state.calc, i = cs.input, form = $("calc-form");
    form.onsubmit = function (ev) { ev.preventDefault(); };
    form.addEventListener("input", function (ev) {
      var t = ev.target, v;
      if (t.dataset.k) {
        v = t.type === "number" ? (t.value === "" ? null : Number(t.value)) : t.value;
        if (t.dataset.k.indexOf("dims.") === 0) i.dims[t.dataset.k.slice(5)] = v; else i[t.dataset.k] = v;
      } else if (t.dataset.cfg) {
        var k = t.dataset.cfg;
        if (t.value === "") delete i.cfg[k];
        else i.cfg[k] = Number(t.value) / (t.dataset.unit === "%" ? 100 : 1);
        if (k === "freight_usd_per_kg") { i.freight = t.value === "" ? "site" : "custom"; syncSegs(); }
      }
      cancelAnimationFrame(bindCalc.frame);
      bindCalc.frame = requestAnimationFrame(calcUpdate);
    });
    each(form, "[data-seg] button", function (b) {
      b.onclick = function () {
        var name = b.parentNode.dataset.seg, was = i[name];
        i[name] = b.dataset.v;
        if (name === "market") delete i.cfg.returns_pct;
        if (name === "freight") delete i.cfg.freight_usd_per_kg;
        if (name === "currency" && was !== i.currency && i.price) {  // keep the same price, in the other currency
          var rate = i.cfg.cny_per_usd || state.config.pricing.cny_per_usd;
          i.price = Math.round((i.currency === "usd" ? i.price / rate : i.price * rate) * 100) / 100;
          $("c-price").value = i.price;
        }
        syncSegs(); calcUpdate();
      };
    });
    $("calc-adv-reset").onclick = function () { i.cfg = {}; if (i.freight === "custom") i.freight = "site"; syncSegs(); calcUpdate(); };
    $("calc-reset").onclick = function () { state.calc = null; memoSet({ last: null }); renderCalc(); };
  }
  function syncSegs() {
    var i = state.calc.input;
    each($("calc-form"), "[data-seg]", function (g) {
      each(g, "button", function (b) { b.setAttribute("aria-pressed", String(i[g.dataset.seg] === b.dataset.v)); });
    });
  }
  function syncForm(res) {
    var i = state.calc.input;
    var cfg = res ? res.cfg : Object.assign({}, state.config.pricing, i.cfg);
    ADV.forEach(function (a) {
      var el = $("c-cfg-" + a[0]);
      if (!el || el === document.activeElement || cfg[a[0]] == null) return;
      el.value = String(+(a[2] === "%" ? cfg[a[0]] * 100 : cfg[a[0]]).toFixed(a[2] === "%" ? 1 : 2));
    });
    $("calc-freight").textContent = ltr("$" + Number(cfg.freight_usd_per_kg).toFixed(2)) + " هر کیلو · " + FREIGHT_NOTE[i.freight] + ". نرخ‌ها تقریبی‌ان؛ از فورواردر استعلام بگیر.";
    var w = res && res.weight;
    $("calc-vol").textContent = w && w.volumetric > 0
      ? "وزن حجمی " + ltr(w.volumetric.toFixed(2)) + " کیلو؛ " + (w.volumetric > w.actual ? "از وزن واقعی بیشتره، پس کرایه روی وزن حجمی حساب میشه." : "کمتر از وزن واقعیه، کرایه روی وزن واقعی حساب میشه.")
      : "طول × عرض × ارتفاع ÷ ۶۰۰۰. اگه از وزن واقعی بیشتر باشه، کرایه روی اون حساب میشه.";
  }

  function calcUpdate() {
    var cs = state.calc, out = $("calc-out");
    if (!cs || !out) return;
    var i = cs.input, res = calcRun(i);
    cs.res = res;
    memoSet({ last: i });
    syncForm(res);
    if (!res) { out.innerHTML = '<div class="empty">' + ic("calc") + " قیمت 1688 و وزن رو وارد کن تا حساب‌وکتاب شروع بشه.</div>"; return; }
    if (!res.ok) {
      out.innerHTML = '<div class="empty">' + ic("warn") + " با این فرض‌ها " + ltr(pct(1 - res.keep)) +
        " قیمت فروش صرف کمیسیون، درگاه، تبلیغات و مرجوعی میشه و با حاشیه‌ی سود " + ltr(pct(res.cfg.target_margin)) + " هیچ قیمتی جواب نمی‌ده. کارمزدها رو پایین‌تر بیار.</div>";
      return;
    }
    var top = Math.max(res.recommended_usd, res.benchmark_usd || 0, res.amazon_usd || 0, res.breakeven_usd * 1.6);
    cs.range = [Math.max(0.5, Math.floor(res.breakeven_usd * 0.7 * 2) / 2), Math.ceil(top * 1.2 * 2) / 2];
    if (cs.custom != null && Math.abs(cs.custom - res.recommended_usd) < 0.005) cs.custom = null;
    var price = activePrice();
    out.innerHTML = heroHTML(res, i) +
      '<section class="panel" id="calc-explore">' +
        cardHead("سود در هر قیمت", "chart", "قیمت خودت رو امتحان کن: اسلایدر رو بکش یا روی نمودار بزن.",
          '<div class="toggle-row"><div class="seg" role="group" id="calc-view"><button type="button" data-v="chart" aria-pressed="' + (cs.view === "chart") + '">نمودار</button><button type="button" data-v="table" aria-pressed="' + (cs.view === "table") + '">جدول</button></div></div>') +
        '<div class="price-ctl"><input type="range" class="range" id="calc-range" min="' + (cs.range[0] - 0.01) + '" max="' + (cs.range[1] - 0.01) + '" step="0.5" value="' + price + '" aria-label="قیمت فروش">' +
          '<input class="input num" id="calc-price" type="number" inputmode="decimal" min="0" step="0.01" value="' + price.toFixed(2) + '" aria-label="قیمت فروش، دلار">' +
          '<button type="button" class="btn ghost small" id="calc-rec">قیمت پیشنهادی' + ic("reset") + "</button></div>" +
        '<div class="kpis" id="calc-kpis"></div><div class="chart" id="calc-curve"></div>' +
      "</section>" +
      '<section class="panel" id="calc-split"></section>' +
      '<section class="panel" id="calc-ship"></section>' +
      '<section class="panel" id="calc-scen"></section>';
    bindExplore();
    calcAtPrice();
    renderScenarios();
  }

  function cardHead(title, icon, sub, extra) {
    return '<div class="card-h"><div><h2>' + ic(icon) + title + "</h2>" + (sub ? '<div class="hint">' + sub + "</div>" : "") + "</div>" + (extra || "") + "</div>";
  }
  function fact(k, v) { return '<div><div class="k">' + k + '</div><div class="v">' + v + "</div></div>"; }

  function heroHTML(res, i) {
    var tm = round1000(res.recommended_usd * (i.toman_per_usd || 0));
    function box(name, price, ratio, note) {
      return '<div class="market"><div class="k">' + name + '</div><div class="v"><span class="num">' + (price ? usd(price) : "—") + "</span> " + chip(ratio) + '</div><div class="k">' + note + "</div></div>";
    }
    return '<section class="panel calc-hero v-' + res.verdict + '">' +
      "<div>" +
        '<div class="hero-title"><span class="label">' + (i.title ? esc(i.title) : "قیمت فروش پیشنهادی") + '</span><span class="pill ' + res.verdict + '"><span class="dot"></span>' + VERDICT[res.verdict] + "</span></div>" +
        '<div class="big-price">' + usd(res.recommended_usd) + "</div>" +
        '<div class="big-sub">' + (i.title ? "قیمت فروش پیشنهادی · " : "") + (tm ? "≈ " + toman(tm) + " تومان" : "") + "</div>" +
        '<div class="facts-row">' +
          fact("تمام‌شده تا انبار دبی", usd(res.landed_usd)) + fact("هزینه‌ی کامل هر فروش", usd(res.unit_cost)) +
          fact("کمترین قیمت با سود " + ltr(pct(res.cfg.target_margin)), usd(res.floor_usd)) + fact("سربه‌سر (بدون سود)", usd(res.breakeven_usd)) +
        "</div>" +
      "</div>" +
      "<div>" +
        '<div class="compare">' +
          box(res.benchmark_estimated ? "Temu (تخمینی)" : "Temu", res.benchmark_usd, res.vs_benchmark,
            res.benchmark_usd ? (res.benchmark_estimated ? ltr(pct(res.cfg.temu_vs_amazon)) + " قیمت آمازون" : "قیمت رقیب") : "وارد نشده") +
          box("آمازون", res.amazon_usd, res.vs_amazon, res.amazon_usd ? "قیمت رقیب" : "وارد نشده") +
        "</div>" +
        '<ul class="reasons">' + calcReasons(res) + "</ul>" +
      "</div>" +
    "</section>";
  }

  function calcReasons(res) {
    var pros = [], cons = [], cfg = res.cfg, r = res.vs_benchmark;
    var ref = res.benchmark_estimated ? "Temu (تخمینی)" : "Temu";
    (res.margin >= cfg.target_margin ? pros : cons).push("حاشیه‌ی سود " + ltr(pct(res.margin)) + (res.margin >= cfg.target_margin ? "" : "، کمتر از هدف " + ltr(pct(cfg.target_margin))));
    if (r == null) cons.push("قیمت Temu یا آمازون وارد نشده؛ قیمت فقط از روی هزینه‌ها حساب شد");
    else if (r <= 0.97) pros.push(ltr(Math.round((1 - r) * 100) + "%") + " ارزان‌تر از " + ref);
    else if (r <= 1.03) pros.push("هم‌قیمت " + ref);
    else if (r <= 1 + cfg.max_premium) cons.push(ltr(Math.round((r - 1) * 100) + "%") + " گران‌تر از " + ref);
    else cons.push("کمترین قیمتی که سود مطلوب می‌ده " + ltr(Math.round((r - 1) * 100) + "%") + " بالاتر از " + ref + "ه؛ رقابتی نیست");
    if (res.vs_amazon != null && res.vs_amazon <= 0.7) pros.push(ltr(Math.round((1 - res.vs_amazon) * 100) + "%") + " ارزان‌تر از آمازون");
    else if (res.vs_amazon != null && res.vs_amazon > 1) cons.push("از آمازون هم گران‌تره");
    if (res.weight.volumetric > res.weight.actual) cons.push("وزن حجمی (" + ltr(res.weight.volumetric.toFixed(2)) + " کیلو) بیشتر از وزن واقعیه؛ کرایه گرون‌تر شد");
    if (res.weight.chargeable > 2) cons.push("سنگینه؛ ارسال به مشتری گرونه");
    else if (res.weight.chargeable <= 0.5) pros.push("سبکه؛ حمل ارزون");
    return pros.map(function (x) { return '<li class="pro"><span>' + esc(x) + "</span></li>"; }).join("") +
      cons.map(function (x) { return '<li class="con"><span>' + esc(x) + "</span></li>"; }).join("");
  }

  function bindExplore() {
    var cs = state.calc, range = $("calc-range"), input = $("calc-price");
    range.oninput = function () { setPrice(Number(range.value), "range"); };
    input.oninput = function () { if (input.value !== "" && Number(input.value) > 0) setPrice(Number(input.value), "input"); };
    $("calc-rec").onclick = function () { setPrice(cs.res.recommended_usd); };
    each($("calc-view"), "button", function (b) {
      b.onclick = function () {
        cs.view = b.dataset.v;
        each($("calc-view"), "button", function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        drawExplore();
      };
    });
  }
  function setPrice(p, from) {
    var cs = state.calc, res = cs.res;
    p = Math.round(p * 100) / 100;
    cs.custom = Math.abs(p - res.recommended_usd) >= 0.005 ? p : null;
    var price = activePrice();
    if (from !== "range") $("calc-range").value = price;
    if (from !== "input") $("calc-price").value = price.toFixed(2);
    calcAtPrice();
  }

  function calcAtPrice() {
    var cs = state.calc, now = atPrice(cs.res, activePrice()), custom = cs.custom != null;
    var d = now.vs_benchmark;
    $("calc-kpis").innerHTML =
      kpi("قیمت فروش" + (custom ? " (دلخواه)" : " (پیشنهادی)"), usd(now.price_usd)) +
      kpi("سود هر عدد", usd(now.profit_usd), now.profit_usd < 0 ? "bad" : "") +
      kpi("حاشیه‌ی سود", pct(now.margin), now.margin < 0.08 ? "bad" : now.margin >= now.cfg.target_margin ? "good" : "") +
      kpi("بازده سرمایه", pct(now.roi)) +
      kpi("× قیمت کارخونه", "×" + now.multiplier) +
      kpi("نسبت به Temu", d == null ? "—" : signed(d), d == null ? "" : d <= 1 ? "good" : d > 1 + now.cfg.max_premium ? "bad" : "") +
      '<div class="kpi"><div class="k">وضعیت در این قیمت</div><div class="v fa"><span class="pill ' + now.verdict + '"><span class="dot"></span>' + VERDICT[now.verdict] + "</span></div></div>";
    drawExplore();
    $("calc-split").innerHTML = splitHTML(now, custom);
    bindSplit();
    $("calc-ship").innerHTML = shipHTML(now);
    drawCash($("calc-cash"), now);
  }
  function kpi(k, v, cls) { return '<div class="kpi"><div class="k">' + k + '</div><div class="v ' + (cls || "") + '">' + v + "</div></div>"; }

  function drawExplore() {
    var cs = state.calc, box = $("calc-curve"), price = activePrice();
    if (cs.view === "table") { box.innerHTML = priceTableHTML(cs.res, price); return; }
    drawCurve(box, cs.res, price);
  }

  // The price ladder as a table: the chart's table view.
  function priceTableHTML(res, price) {
    var rows = [[res.breakeven_usd, "سربه‌سر"], [res.floor_usd, "کمترین قیمت با سود مطلوب"], [res.recommended_usd, "قیمت پیشنهادی"]];
    if (res.benchmark_usd) rows.push([res.benchmark_usd, res.benchmark_estimated ? "Temu (تخمینی)" : "Temu"]);
    if (res.amazon_usd) rows.push([res.amazon_usd, "آمازون"]);
    if (state.calc.custom != null) rows.push([price, "قیمت تو"]);
    rows.sort(function (a, b) { return a[0] - b[0]; });
    return '<div class="scroll"><table class="scen" style="min-width:0"><thead><tr><th>قیمت</th><th></th><th>سود هر عدد</th><th>حاشیه</th><th>نسبت به Temu</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var profit = r[0] * res.keep - res.unit_cost;
        return '<tr><td class="num">' + usd(r[0]) + "</td><td>" + r[1] + '</td><td class="num">' + usd(profit) + '</td><td class="num">' + pct(profit / r[0]) +
          '</td><td class="num">' + (res.benchmark_usd ? signed(r[0] / res.benchmark_usd) : "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  // --- charts (plain SVG) -----------------------------------------------------------

  function ticks(a, b, n) {
    var raw = (b - a || 1) / n, e = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / e;
    var step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * e, out = [];
    for (var k = Math.floor(a / step); k <= Math.ceil(b / step); k++) out.push(Math.round(k * step * 1e6) / 1e6);
    return out;
  }
  function tickUsd(v) {
    var a = Math.abs(v);
    return (v < 0 ? "−$" : "$") + (a % 1 === 0 ? a.toFixed(0) : a.toFixed(a < 1 ? 2 : 1));
  }
  function f1(x) { return Math.round(x * 10) / 10; }
  function showTip(box, x, y, lines) {
    var tip = box.querySelector(".tip");
    if (!tip) { tip = document.createElement("div"); tip.className = "tip"; box.appendChild(tip); }
    tip.textContent = "";
    lines.forEach(function (l, n) {
      var d = document.createElement("div");
      if (n === 0) d.className = "tip-h";
      d.textContent = l;
      tip.appendChild(d);
    });
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight, bw = box.clientWidth;
    tip.style.left = Math.min(Math.max(0, x - w / 2), bw - w) + "px";
    tip.style.top = (y - h - 14 < 0 ? y + 14 : y - h - 14) + "px";
  }
  function hideTip(box) { var t = box.querySelector(".tip"); if (t) t.hidden = true; }

  // Profit per piece against the selling price, with where it stops losing money, where
  // it reaches the target margin, and where Temu and Amazon sell.
  function drawCurve(box, res, price) {
    var W = Math.max(300, box.clientWidth || 640), H = W < 480 ? 230 : 270;
    var L = 50, R = 16, T = 34, B = 30;
    var lo = Math.min(state.calc.range[0], price * 0.95), hi = Math.max(state.calc.range[1], price * 1.05);
    var f = function (p) { return p * res.keep - res.unit_cost; };
    var yt = ticks(Math.min(f(lo), 0), Math.max(f(hi), 0), 4), ymin = yt[0], ymax = yt[yt.length - 1];
    var X = function (p) { return f1(L + (p - lo) / (hi - lo) * (W - L - R)); };
    var Y = function (v) { return f1(T + (ymax - v) / (ymax - ymin) * (H - T - B)); };
    var s = [], be = res.breakeven_usd, fl = res.floor_usd, rec = res.recommended_usd;
    [[lo, be, "loss", "ضرر"], [be, fl, "low", "سود کم"], [fl, hi, "good", "سود مطلوب"]].forEach(function (b) {
      var a = Math.max(lo, b[0]), z = Math.min(hi, b[1]);
      if (z <= a) return;
      s.push('<rect class="band-' + b[2] + '" x="' + X(a) + '" y="' + T + '" width="' + f1(X(z) - X(a)) + '" height="' + (H - T - B) + '"/>');
      if (X(z) - X(a) > 58) s.push('<text class="fa" x="' + (X(a) + 6) + '" y="' + (T + 15) + '">' + b[3] + "</text>");
    });
    yt.forEach(function (v) {
      s.push('<line class="' + (v === 0 ? "zero" : "gl") + '" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/>');
      s.push('<text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + tickUsd(v) + "</text>");
    });
    ticks(lo, hi, W < 480 ? 4 : 7).filter(function (p) { return p >= lo && p <= hi; }).forEach(function (p) {
      s.push('<text x="' + X(p) + '" y="' + (H - B + 18) + '" text-anchor="middle">' + tickUsd(p) + "</text>");
    });
    var mk = [];
    if (res.benchmark_usd) mk.push([res.benchmark_usd, res.benchmark_estimated ? "Temu~" : "Temu"]);
    if (res.amazon_usd) mk.push([res.amazon_usd, "Amazon"]);
    mk.sort(function (a, b) { return a[0] - b[0]; });
    mk.forEach(function (m, n) {
      var x = X(m[0]);
      if (x < L || x > W - R) return;
      var anchor = "middle", dx = 0;
      if (mk.length === 2 && Math.abs(X(mk[1][0]) - X(mk[0][0])) < 110) { anchor = n === 0 ? "end" : "start"; dx = n === 0 ? -4 : 4; }
      var half = (m[1].length + usd(m[0]).length + 1) * 3.4;  // ~6.7px a character at 11px mono
      if (anchor !== "end" && x + (anchor === "middle" ? half : 2 * half) > W) { anchor = "end"; dx = -3; }
      if (anchor !== "start" && x - (anchor === "middle" ? half : 2 * half) < 0) { anchor = "start"; dx = 3; }
      s.push('<line class="mkt" x1="' + x + '" x2="' + x + '" y1="' + (T - 6) + '" y2="' + (H - B) + '"/>');
      s.push('<text x="' + (x + dx) + '" y="' + (T - 12) + '" text-anchor="' + anchor + '">' + m[1] + " " + usd(m[0]) + "</text>");
    });
    s.push('<line class="ln" x1="' + X(lo) + '" y1="' + Y(f(lo)) + '" x2="' + X(hi) + '" y2="' + Y(f(hi)) + '"/>');
    // The chart box is left-to-right: labels put the figure first so they read right-to-left.
    s.push('<circle class="mk-be" cx="' + X(be) + '" cy="' + Y(0) + '" r="4.5"/>');
    s.push('<text class="fa" x="' + (X(be) + 8) + '" y="' + (Y(0) + 17) + '">' + usd(be) + " سربه‌سر</text>");
    s.push('<circle class="mk-rec" cx="' + X(rec) + '" cy="' + Y(f(rec)) + '" r="5.5"/>');
    s.push('<text class="fa strong" x="' + (X(rec) - 9) + '" y="' + (Y(f(rec)) - 10) + '" text-anchor="end">' + usd(rec) + " پیشنهادی</text>");
    if (state.calc.custom != null) {
      var near = Math.abs(X(price) - X(be)) < 80;
      s.push('<circle class="mk-you" cx="' + X(price) + '" cy="' + Y(f(price)) + '" r="6"/>');
      s.push('<text class="fa strong" x="' + (X(price) + (near ? -9 : 9)) + '" y="' + (Y(f(price)) + (near ? -10 : 18)) + '" text-anchor="' + (near ? "end" : "start") + '">' + usd(price) + " قیمت تو</text>");
    }
    s.push('<g class="xh" visibility="hidden"><line class="cross" y1="' + T + '" y2="' + (H - B) + '"/><circle class="mk-rec" r="4.5"/></g>');
    s.push('<rect class="hit" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '"/>');
    box.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="سود هر عدد در قیمت‌های مختلف؛ نمای جدول هم هست">' + s.join("") + "</svg>" +
      '<div class="chart-note">' + ic("info") + "<span>خط آبی: سود هر عدد. زیر صفر ضرره؛ از «سود مطلوب» به بعد حاشیه‌ی هدف به دست میاد.</span></div>";
    var svg = box.querySelector("svg"), xh = svg.querySelector(".xh"), hit = svg.querySelector(".hit");
    function priceAt(ev) {
      var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
      return snap(Math.min(hi, Math.max(lo, lo + (px - L) / (W - L - R) * (hi - lo))));
    }
    hit.addEventListener("pointermove", function (ev) {
      var p = priceAt(ev), v = f(p), r = svg.getBoundingClientRect(), k = r.width / W;
      xh.setAttribute("visibility", "visible");
      xh.firstChild.setAttribute("x1", X(p)); xh.firstChild.setAttribute("x2", X(p));
      xh.lastChild.setAttribute("cx", X(p)); xh.lastChild.setAttribute("cy", Y(v));
      var lines = [usd(p), "سود هر عدد: " + ltr(usd(v)), "حاشیه: " + ltr(pct(v / p))];
      if (res.benchmark_usd) lines.push("نسبت به Temu: " + ltr(signed(p / res.benchmark_usd)));
      lines.push("بزن تا این قیمت انتخاب بشه");
      showTip(box, X(p) * k, Y(v) * k, lines);
    });
    hit.addEventListener("pointerleave", function () { xh.setAttribute("visibility", "hidden"); hideTip(box); });
    hit.addEventListener("click", function (ev) { setPrice(priceAt(ev)); });
  }

  function barPath(x, w, y0, y1) {  // 4px rounded at the data end, square on the baseline
    var r = Math.min(4, w / 2, Math.abs(y1 - y0)), up = y1 < y0, e = up ? y1 + r : y1 - r;
    return "M" + x + "," + y0 + "V" + e + "Q" + x + "," + y1 + " " + (x + r) + "," + y1 + "H" + (x + w - r) +
      "Q" + (x + w) + "," + y1 + " " + (x + w) + "," + e + "V" + y0 + "Z";
  }

  // Where the money stands at the end of each month of the first shipment.
  function drawCash(box, now) {
    var i = state.calc.input, monthly = i.monthly_sales || 0, qty = Math.max(1, Math.round(i.qty || 1));
    if (!box) return;
    if (!(monthly > 0)) { box.innerHTML = '<div class="chart-note">' + ic("info") + "<span>فروش ماهانه رو وارد کن تا جریان پول ماه‌به‌ماه رو ببینی.</span></div>"; return; }
    var s = Calc.shipment(now, qty, monthly, i.toman_per_usd);
    var M = Math.min(12, Math.ceil(qty / monthly)), vals = [];
    for (var m = 0; m <= M; m++) vals.push(-s.capital_usd + Math.min(qty, monthly * m) * s.per_sale_usd);
    var W = Math.max(300, box.clientWidth || 640), H = 210, L = 58, R = 12, T = 24, B = 28;
    var yt = ticks(Math.min(0, Math.min.apply(null, vals)), Math.max(0, Math.max.apply(null, vals)), 4), ymin = yt[0], ymax = yt[yt.length - 1];
    var Y = function (v) { return f1(T + (ymax - v) / (ymax - ymin) * (H - T - B)); };
    var band = (W - L - R) / (M + 1), bw = Math.min(36, band - 4), out = [];
    yt.forEach(function (v) {
      out.push('<line class="' + (v === 0 ? "zero" : "gl") + '" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/>');
      out.push('<text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + tickUsd(v) + "</text>");
    });
    vals.forEach(function (v, m) {
      var x = f1(L + band * m + (band - bw) / 2);
      out.push('<path class="' + (v < 0 ? "neg" : "pos") + '" data-m="' + m + '" d="' + barPath(x, bw, Y(0), Y(v)) + '"/>');
      if (M <= 12 && (band > 26 || m % 2 === 0)) out.push('<text class="fa" x="' + f1(x + bw / 2) + '" y="' + (H - B + 18) + '" text-anchor="middle">' + (m === 0 ? "شروع" : toman(m)) + "</text>");
    });
    var first = vals[0], last = vals[vals.length - 1];
    out.push('<text class="strong" x="' + f1(L + (band - bw) / 2 + bw + 6) + '" y="' + (Y(first) - 2) + '">' + tickUsd(Math.round(first)) + "</text>");
    out.push('<text class="strong" x="' + f1(L + band * M + (band - bw) / 2 - 6) + '" y="' + (Y(last) - 6) + '" text-anchor="end">' + (last > 0 ? "+" : "") + tickUsd(Math.round(last)) + "</text>");
    if (s.cash_back_months != null && s.cash_back_months <= M) {
      var cx = f1(L + band * s.cash_back_months + band / 2);
      out.push('<line class="mkt" x1="' + cx + '" x2="' + cx + '" y1="' + (T - 6) + '" y2="' + (H - B) + '"/>');
      out.push('<text class="fa" x="' + cx + '" y="' + (T - 10) + '" text-anchor="' + (cx > W - 70 ? "end" : "middle") + '">برگشت پول</text>');
    }
    box.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="وضعیت نقدی اولین محموله در پایان هر ماه">' + out.join("") + "</svg>" +
      '<div class="chart-note">' + ic("info") + "<span>هر ستون: وضعیت پولت در پایان هر ماه (ماه‌ها به فارسی). زیر صفر یعنی هنوز سرمایه‌ات کامل برنگشته" + (Math.ceil(qty / monthly) > 12 ? "؛ فقط ۱۲ ماه اول نشون داده شده" : "") + ".</span></div>";
    each(box, "path[data-m]", function (p) {
      p.addEventListener("pointerenter", function () {
        var m = Number(p.dataset.m), r = box.querySelector("svg").getBoundingClientRect(), k = r.width / W, bb = p.getBBox();
        showTip(box, (bb.x + bb.width / 2) * k, Math.min(bb.y, Y(0)) * k, [
          m === 0 ? "شروع: خرید محموله" : "پایان ماه " + toman(m),
          "فروش تا اینجا: " + toman(Math.min(qty, monthly * m)) + " عدد",
          "وضعیت نقدی: " + ltr((vals[m] > 0 ? "+" : "") + usd(vals[m])),
        ]);
      });
      p.addEventListener("pointerleave", function () { hideTip(box); });
    });
  }

  function splitHTML(now, custom) {
    var parts = visibleParts(Calc.split(now)), loss = now.profit_usd < 0;
    var shown = loss ? parts.slice(1) : parts;
    var total = shown.reduce(function (a, p) { return a + Math.max(0, p.value); }, 0) || 1;
    var bar = shown.map(function (p) {
      return '<div class="c' + partIndex(p.key) + '" data-part="' + p.key + '" style="flex:' + (Math.max(0, p.value) / total).toFixed(4) + ' 1 0"></div>';
    }).join("");
    var legend = parts.map(function (p) {
      return '<li data-part="' + p.key + '"><span class="sw c' + partIndex(p.key) + '"></span><span>' + partName(p.key) + '</span><span class="num">' + usd(p.value) +
        '</span><span class="num share">' + pct(p.value / now.price_usd) + "</span></li>";
    }).join("");
    return cardHead("هر دلار از قیمت فروش کجا می‌ره", "pie", "در قیمت " + ltr(usd(now.price_usd)) + (custom ? " (قیمت تو)" : " (پیشنهادی)")) +
      '<div class="split-box"><div class="split" role="img" aria-label="سهم سود و هزینه‌ها از قیمت فروش؛ جدول زیرش هست">' + bar + "</div></div>" +
      (loss ? '<p class="error split-loss">ضرر: هزینه‌ها ' + ltr(usd(-now.profit_usd)) + " بیشتر از چیزیه که از این قیمت دستت می‌رسه.</p>" : "") +
      '<ul class="legend">' + legend + "</ul>" +
      "<details class=\"costs-d\"><summary>ریز همه‌ی هزینه‌ها (جدول)</summary>" + costTable(now, state.calc.input.units || 1, now.weight.chargeable) + "</details>";
  }
  function bindSplit() {
    var root = $("calc-split"), bar = root.querySelector(".split"), box = root.querySelector(".split-box");
    var parts = Calc.split(atPrice(state.calc.res, activePrice())), price = activePrice();
    function on(key, target) {
      bar.classList.toggle("dim", !!key);
      each(root, "[data-part]", function (el) { el.classList.toggle("on", el.dataset.part === key); });
      if (key && target && target.parentNode === bar) {
        var p = parts.find(function (x) { return x.key === key; });
        var r = target.getBoundingClientRect(), br = box.getBoundingClientRect();
        showTip(box, r.left - br.left + r.width / 2, 0, [usd(p.value), partName(key), ltr(pct(p.value / price)) + " از قیمت فروش"]);
      } else hideTip(box);
    }
    each(root, "[data-part]", function (el) {
      el.addEventListener("pointerenter", function () { on(el.dataset.part, el); });
      el.addEventListener("pointerleave", function () { on(null); });
    });
  }

  // The panel's licence still to pay from profits: nothing for earlier partners (contract clause 4-2).
  function licenseFor(input) { return input.license === "exempt" ? 0 : state.config.pricing.license_usd || 0; }

  function shipHTML(now) {
    var i = state.calc.input, qty = Math.max(1, Math.round(i.qty || 1)), monthly = i.monthly_sales || 0;
    var s = Calc.shipment(now, qty, monthly, i.toman_per_usd, licenseFor(i));
    function tile(k, v, t, fa) { return '<div><div class="k">' + k + '</div><div class="v' + (fa ? " fa" : "") + '">' + v + '</div><div class="t">' + (t || "&nbsp;") + "</div></div>"; }
    function tm(x) { return x != null ? toman(round1000(x)) + " تومان" : ""; }
    return cardHead("اولین محموله", "box", toman(qty) + " عدد، فروش در " + ltr(usd(now.price_usd))) +
      '<div class="ship-tiles">' +
        tile("سرمایه‌ی لازم (تا انبار دبی)", usd(s.capital_usd), tm(s.capital_toman)) +
        tile("درآمد کل فروش", usd(s.revenue_usd), "قبل از کارمزدها") +
        tile("سود کل محموله", usd(s.profit_usd), tm(s.profit_toman)) +
        tile("سود ماهانه", s.monthly_profit_usd != null ? usd(s.monthly_profit_usd) : "—", s.monthly_profit_usd != null ? tm(s.monthly_profit_toman) : "فروش ماهانه رو وارد کن") +
        tile("برگشت کامل سرمایه", s.cash_back_months != null ? toman(s.cash_back_months) + " ماه" : "—",
          s.units_to_cash_back != null ? "بعد از فروش " + toman(s.units_to_cash_back) + " عدد" : "با این قیمت سرمایه کامل برنمی‌گرده", true) +
        tile("مدت فروش کل محموله", s.sell_out_months != null ? toman(s.sell_out_months) + " ماه" : "—", monthly ? "با " + toman(monthly) + " فروش در ماه" : "", true) +
        tile("امتیاز پنل از سود", !s.license_usd ? "معاف" : s.license_months != null ? toman(s.license_months) + " ماه" : "—",
          !s.license_usd ? "شریک قبلی راینومال" : usd(s.license_usd) + " در " + toman(state.config.pricing.license_installments || 10) + " قسط", true) +
        tile("سود خالص سال اول", s.first_year_usd != null ? usd(s.first_year_usd) : "—",
          s.first_year_usd != null ? tm(s.first_year_toman) + (s.license_usd ? " (بعد از امتیاز پنل)" : "") : "فروش ماهانه رو وارد کن") +
      "</div>" +
      (s.over_shelf ? '<div class="notice" style="margin:12px 0 0"><b>بیش از ' + toman(s.shelf_months) + " ماه در انبار:</b> طبق بند ۱۱-۵ قرارداد، کالایی که به‌خاطر کم‌کاری فروشنده بیش از " +
        toman(s.shelf_months) + " ماه در انبار راینومال بمونه باید ظرف ۳۰ روز خارج بشه. با " + toman(monthly) + " فروش در ماه، حداکثر " + toman(s.max_qty_on_shelf) + " عدد بفرست.</div>" : "") +
      '<p class="hint" style="margin:10px 0 0">تسویه‌ی راینومال هفتگیه: درخواست برداشت تا شنبه، حسابرسی یکشنبه، واریز ریالی دوشنبه (بند ۸ قرارداد).</p>' +
      '<div class="chart" id="calc-cash"></div>';
  }

  function renderScenarios() {
    var box = $("calc-scen");
    if (!box) return;
    var list = memo().scenarios || [];
    var actions = '<div class="actions">' +
      '<button type="button" class="btn small" id="calc-save">ذخیره‌ی این حالت' + ic("save") + "</button>" +
      '<button type="button" class="btn ghost small" id="calc-copy">کپی خلاصه برای تلگرام' + ic("copy") + "</button>" +
      '<button type="button" class="btn ghost small" id="calc-print">چاپ / PDF' + ic("receipt") + "</button></div>";
    var body;
    if (!list.length) {
      body = '<p class="hint" style="margin:10px 0 0">هنوز حالتی ذخیره نکردی. مثلاً یه بار با حمل دریایی و یه بار هوایی ذخیره کن و کنار هم ببین.</p>';
    } else {
      var cols = list.map(function (sc) {
        var r = calcRun(sc.input);
        if (!r || !r.ok) return { sc: sc };
        var now = atPrice(r, sc.custom || r.recommended_usd);
        return { sc: sc, now: now, s: Calc.shipment(now, Math.max(1, Math.round(sc.input.qty || 1)), sc.input.monthly_sales || 0, sc.input.toman_per_usd, licenseFor(sc.input)) };
      });
      var rows = [
        ["قیمت فروش", function (c) { return c.now.price_usd; }, usd, null],
        ["تمام‌شده تا انبار", function (c) { return c.now.landed_usd; }, usd, "min"],
        ["سود هر عدد", function (c) { return c.now.profit_usd; }, usd, "max"],
        ["حاشیه‌ی سود", function (c) { return c.now.margin; }, pct, "max"],
        ["بازده سرمایه", function (c) { return c.now.roi; }, pct, "max"],
        ["سرمایه‌ی اولین محموله", function (c) { return c.s.capital_usd; }, usd, "min"],
        ["سود اولین محموله", function (c) { return c.s.profit_usd; }, usd, "max"],
        ["برگشت سرمایه (ماه)", function (c) { return c.s.cash_back_months; }, function (v) { return v == null ? "—" : toman(v); }, "min"],
      ];
      var ok = cols.filter(function (c) { return c.now; });
      body = '<div class="scroll"><table class="scen"><thead><tr><th></th>' + cols.map(function (c, n) {
          return "<th>" + esc(c.sc.name) + '<div class="ops"><button type="button" class="btn quiet small" data-load="' + n + '">باز کن</button>' +
            '<button type="button" class="btn quiet small" data-del="' + n + '" aria-label="حذف">' + ic("trash") + "</button></div></th>";
        }).join("") + "</tr></thead><tbody>" +
        rows.map(function (r) {
          var vals = ok.map(r[1]).filter(function (v) { return v != null; });
          var best = r[3] && ok.length > 1 && vals.length ? (r[3] === "max" ? Math.max.apply(null, vals) : Math.min.apply(null, vals)) : null;
          return "<tr><th>" + r[0] + "</th>" + cols.map(function (c) {
            if (!c.now) return "<td>—</td>";
            var v = r[1](c);
            return '<td class="num' + (best != null && v === best ? " best" : "") + '">' + r[2](v) + "</td>";
          }).join("") + "</tr>";
        }).join("") +
        "<tr><th>وضعیت</th>" + cols.map(function (c) {
          return c.now ? '<td><span class="pill ' + c.now.verdict + '"><span class="dot"></span>' + VERDICT[c.now.verdict] + "</span></td>" : "<td>—</td>";
        }).join("") + "</tr></tbody></table></div>";
    }
    box.innerHTML = cardHead("مقایسه‌ی حالت‌ها", "table", "تا ۴ حالت رو کنار هم ببین؛ فقط در همین مرورگر ذخیره میشه.", actions) + body;
    $("calc-save").onclick = function () {
      var cs = state.calc, all = memo().scenarios || [];
      if (all.length >= 4) { toast("حداکثر ۴ حالت؛ اول یکی رو پاک کن."); return; }
      all.push({ name: cs.input.title || "حالت " + toman(all.length + 1), input: clone(cs.input), custom: cs.custom });
      memoSet({ scenarios: all });
      renderScenarios();
      toast("ذخیره شد؛ حالا یه چیزی رو عوض کن و دوباره ذخیره کن.");
    };
    $("calc-copy").onclick = function () { copyText(calcSummary(), "خلاصه کپی شد؛ توی تلگرام بچسبون."); };
    $("calc-print").onclick = function () { window.print(); };
    each(box, "[data-load]", function (b) {
      b.onclick = function () {
        var sc = (memo().scenarios || [])[Number(b.dataset.load)];
        if (!sc) return;
        state.calc = { input: clone(sc.input), custom: sc.custom, res: null, view: state.calc.view };
        renderCalc();
        window.scrollTo(0, 0);
      };
    });
    each(box, "[data-del]", function (b) {
      b.onclick = function () {
        var all = memo().scenarios || [];
        all.splice(Number(b.dataset.del), 1);
        memoSet({ scenarios: all });
        renderScenarios();
      };
    });
  }

  function calcSummary() {
    var cs = state.calc, i = cs.input, res = cs.res, now = atPrice(res, activePrice());
    var qty = Math.max(1, Math.round(i.qty || 1)), s = Calc.shipment(now, qty, i.monthly_sales || 0, i.toman_per_usd, licenseFor(i));
    var U = function (x) { return "\u200E" + usd(x); }, S = function (x) { return "\u200E" + signed(x); };
    var P = function (x) { return "\u200E" + pct(x); };
    var mark = { green: "✅", yellow: "⚠️", red: "⛔" }[now.verdict];
    var lines = [
      "🧮 حساب‌وکتاب واردات" + (i.title ? ": " + i.title : ""),
      "خرید از 1688: " + (i.currency === "usd" ? "$" : "¥") + i.price + (i.units > 1 ? " × " + i.units + " عدد" : "") + " · وزن قابل‌محاسبه " + res.weight.chargeable.toFixed(2) + " کیلو",
      "تمام‌شده تا انبار دبی: " + U(res.landed_usd),
      "قیمت فروش" + (cs.custom != null ? " (دلخواه)" : " پیشنهادی") + ": " + U(now.price_usd) +
        (res.benchmark_usd ? " · Temu " + U(res.benchmark_usd) + " (" + S(now.vs_benchmark) + ")" : "") +
        (res.amazon_usd ? " · آمازون " + U(res.amazon_usd) : ""),
      "سود هر عدد: " + U(now.profit_usd) + " · حاشیه " + P(now.margin) + " · بازده سرمایه " + P(now.roi),
      "اولین محموله (" + toman(qty) + " عدد): سرمایه " + U(s.capital_usd) + (s.capital_toman ? " ≈ " + toman(round1000(s.capital_toman)) + " تومان" : "") +
        " · سود " + U(s.profit_usd) + (s.profit_toman ? " ≈ " + toman(round1000(s.profit_toman)) + " تومان" : ""),
    ];
    if (s.cash_back_months != null) lines.push("برگشت کامل سرمایه: حدود " + toman(s.cash_back_months) + " ماه");
    if (s.license_months != null) lines.push("امتیاز پنل راینومال از سود: حدود " + toman(s.license_months) + " ماه");
    if (s.over_shelf) lines.push("⚠️ فروش کل محموله بیش از " + toman(s.shelf_months) + " ماه طول می‌کشه (بند ۱۱-۵ قرارداد)");
    lines.push("وضعیت: " + VERDICT[now.verdict] + " " + mark);
    if (!DEMO) lines.push((state.config.brand || "شکارچی") + " · " + location.origin + "/#calc");
    return lines.join("\n");
  }

  // --- demo-only analysis (the calculator's pricing, hunter/scoring.py's score) ------------

  function demoAnalyze(b) {
    var res = Calc.compute({
      price: b.price_cny, units: b.listing_pack || 1, weight_kg: b.weight_kg, temu_usd: b.temu_price_usd,
      amazon_usd: b.amazon_price_usd, market: b.market, items_per_cart: b.items_per_cart,
    }, state.config.pricing);
    if (!res.ok) return null;
    var cfg = res.cfg, margin = res.margin, ratio = res.vs_benchmark, vsAmazon = res.vs_amazon;
    var ref = res.benchmark_estimated ? "Temu (تخمینی از قیمت آمازون)" : "Temu";
    var score = 0, pros = [], cons = [], d = b.monthly_sold;
    if (d == null) { score += 10; cons.push("آمار فروش ماهانه وارد نشده"); }
    else if (d >= 3000) { score += 25; pros.push("تقاضای خیلی بالا"); }
    else if (d >= 1000) { score += 20; pros.push("تقاضای خوب"); }
    else if (d >= 300) { score += 14; pros.push("تقاضای متوسط"); }
    else { score += 4; cons.push("تقاضای کم"); }
    if (margin >= 0.30) score += 25; else if (margin >= 0.22) score += 20; else if (margin >= 0.15) score += 14; else if (margin >= 0.08) score += 6;
    (margin >= 0.15 ? pros : cons).push("حاشیه‌ی سود " + Math.round(margin * 100) + "%");
    if (ratio == null) { score += 8; cons.push("قیمت Temu وارد نشده"); }
    else if (ratio <= 0.97) { score += 20; pros.push("ارزان‌تر از " + ref); }
    else if (ratio <= 1.03) { score += 15; pros.push("هم‌قیمت " + ref); }
    else if (ratio <= 1 + cfg.max_premium) { score += 8; cons.push(Math.round((ratio - 1) * 100) + "% گران‌تر از " + ref); }
    else cons.push("کمترین قیمتی که سود می‌ده " + Math.round((ratio - 1) * 100) + "% بالاتر از " + ref + "ه؛ رقابتی نیست");
    if (vsAmazon != null && vsAmazon <= 0.7) { score += 5; pros.push(Math.round((1 - vsAmazon) * 100) + "% ارزان‌تر از آمازون"); }
    else if (vsAmazon != null && vsAmazon > 1) { score -= 5; cons.push("از آمازون هم گران‌تره"); }
    score += b.reviews == null ? 5 : b.reviews < 500 ? 10 : b.reviews < 3000 ? 6 : 2;
    score += b.weight_kg <= 0.5 ? 10 : b.weight_kg <= 2 ? 6 : 2;
    score += 4;
    var tooDear = ratio != null && ratio > 1 + cfg.max_premium;
    var verdict = tooDear || margin < 0.08 ? "red"
      : score >= 70 && margin >= 0.15 && (ratio == null || ratio <= 1.03) ? "green" : score >= 50 ? "yellow" : "red";
    var starter = Math.max(b.moq || 1, cfg.min_starter_qty);
    var pricing = {};
    ["factory_usd", "china_side_usd", "freight_usd", "packaging_usd", "landed_usd", "last_mile_usd", "price_usd", "floor_usd",
      "breakeven_usd", "platform_fee_usd", "gateway_usd", "marketing_usd", "returns_reserve_usd", "profit_usd", "margin", "roi",
      "multiplier", "benchmark_usd", "benchmark_estimated", "vs_benchmark", "amazon_usd", "vs_amazon"].forEach(function (k) { pricing[k] = res[k]; });
    return {
      id: "analyze", category: "manual", title_fa: b.title || "محصول من", pack_qty: Math.max(1, b.listing_pack || 1), weight_kg: b.weight_kg,
      listing: { source: "temu", title: "", url: "", image_url: "", monthly_sold: b.monthly_sold },
      offer: { price_cny: b.price_cny, moq: b.moq || 1, url: "", shop_name: "", price_tiers: [] }, matches: [], alternatives: [],
      pricing: pricing, score: Math.max(0, Math.min(score, 100)), verdict: verdict, pros: pros, cons: cons, flags: [],
      starter_qty: starter, starter_capital_usd: Math.round(starter * res.landed_usd * 100) / 100,
    };
  }

  // --- navigation ----------------------------------------------------------------

  function go(tab) {
    state.tab = tab;
    render();
    window.scrollTo(0, 0);
    try { history.replaceState(null, "", tab === "calc" ? "#calc" : location.pathname + location.search); } catch (e) { /* sandboxed */ }
  }
  function logout() {
    if (DEMO) { state.me = null; state.tab = "home"; render(); window.scrollTo(0, 0); return; }
    api("/api/logout", { method: "POST" }).then(function () {
      state.me = null; state.picks = null; state.analysis = null; state.jobs = undefined; state.tab = "home"; return loadHunt();
    }).then(render);
  }
  function focusAuth(mode) {
    state.authMode = mode;
    if (state.tab !== "home") go("home"); else { $("auth").innerHTML = authHTML(); bindAuth(); }
    var f = $("auth-form");
    if (f) { $("auth").scrollIntoView({ block: "center", behavior: "smooth" }); f.querySelector("input").focus({ preventScroll: true }); }
  }

  each($("tabs"), "button", function (b) { b.onclick = function () { go(b.dataset.tab); }; });
  $("brand-link").onclick = function (ev) { ev.preventDefault(); go("home"); };
  $("app").addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-go], [data-logout], [data-demo-enter]");
    if (!t) return;
    ev.preventDefault();
    if (t.hasAttribute("data-logout")) { logout(); return; }
    if (t.hasAttribute("data-demo-enter")) { enterDemo(); toast("این میز کار یه فروشنده‌ی نمونه‌ست."); return; }
    var where = t.dataset.go;
    if (where === "signup" || where === "login") { if (state.me) go("account"); else focusAuth(where); }
    else if (where === "plans" || where === "demo") {  // sections of the landing
      if (state.me) { go(where === "plans" ? "account" : "dash"); return; }
      if (state.tab !== "home") go("home");
      var p = $(where); if (p) p.scrollIntoView({ block: "start", behavior: motionOK() ? "smooth" : "auto" });
    } else go(where);
  });
  // Pictures from the image proxy that don't load leave the initial letter behind.
  document.addEventListener("error", function (ev) {
    if (ev.target && ev.target.tagName === "IMG" && ev.target.closest(".thumb, .gallery")) ev.target.remove();
  }, true);
  window.addEventListener("resize", function () {
    clearTimeout(go.resize);
    go.resize = setTimeout(function () {
      if (state.tab === "calc" && state.calc && state.calc.res && state.calc.res.ok && $("calc-kpis")) { drawExplore(); drawCash($("calc-cash"), atPrice(state.calc.res, activePrice())); }
    }, 150);
  });

  window.addEventListener("hashchange", function () { if (location.hash === "#calc" && state.config && state.tab !== "calc") go("calc"); });

  var hash = (location.hash || "").slice(1);
  load().then(function () {
    if (hash === "calc") state.tab = "calc";
    if (DEMO && (hash === "dash" || hash === "media")) { state.me = DEMO.me; state.tab = hash; }  // links straight into the workspace
    if (HASH_MESSAGES[hash]) {
      toast(HASH_MESSAGES[hash]);
      if (hash !== "paid" && state.me) state.tab = "account";
      try { history.replaceState(null, "", location.pathname); } catch (e) { /* sandboxed */ }
    }
    render();
  }, function (e) { $("main").innerHTML = '<div class="empty">' + esc(errText(e)) + "</div>"; });
})();
