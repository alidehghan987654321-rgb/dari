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
    filter: { cat: "all", verdict: "all", sort: "new", fresh: false, q: "" }, authMode: "signup", analysis: null, jobs: undefined, catalog: null,
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
    "pay-failed": "پرداخت تأیید نشد. اگه پولی کم شده، ظرف 72 ساعت برمی‌گرده.",
  };
  var VERDICT = { green: "شکار خوب", yellow: "با احتیاط", red: "نیار" };
  var TITLES = { dash: "میز کار", media: "عکس و ویدیو", hunt: "کاتالوگ شکارها", picks: "شکارهای اختصاصی من", analyze: "تحلیل لینک", order: "سبد سفارش", calc: "ماشین‌حساب واردات", account: "حساب من" };
  var PUBLIC = { home: true, calc: true };  // what visitors can open; "home" is the landing

  // --- helpers ----------------------------------------------------------------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(name) { return '<svg class="i" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : ""; }
  function usd(n) {
    return n == null || isNaN(n) ? "—" : (n < 0 ? "−$" : "$") + Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function cny(n) { return n == null ? "—" : "¥" + Number(n).toFixed(2); }
  function pct(n) { return n == null || isNaN(n) ? "—" : Math.round(n * 100) + "%"; }
  function signed(ratio) { var d = Math.round((ratio - 1) * 100); return (d > 0 ? "+" : "") + d + "%"; }
  function ltr(x) { return "\u200E" + x + "\u200E"; }  // a figure inside Persian text, kept in order (LRM: shows nowhere)
  function count(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
  function toman(n) { return Number(n).toLocaleString("en-US"); }  // one kind of digit everywhere: 0-9
  function round1000(n) { return Math.round(n / 1000) * 1000; }
  function faDate(iso) {
    try { return new Date(iso).toLocaleDateString("fa-IR-u-nu-latn", { year: "numeric", month: "long", day: "numeric" }); }
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
  function supportLine(lead) {
    var s = support();
    if (!s.name && !s.phone && !s.email) return "";
    return (lead == null ? "سؤالی داری؟ " : lead) + "پشتیبانی و مدیر پروژه: <b>" + esc(s.name) + "</b>" +
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
    stopRadar();
    stopWorld();
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
      "، همراه فروشنده‌های راینومال از 1688 تا فروش. عددها برآوردی‌اند؛ قبل از سفارش اصلی، نمونه بگیر.</span>" +
      '<span class="support">' + supportLine() + "</span></div>";
    var main = $("main");
    if (state.tab === "calc") renderCalc();
    else if (!loggedIn) { main.innerHTML = landingHTML(); bindLanding(); }
    else if (state.tab === "dash") renderDash();
    else if (state.tab === "media") renderMedia();
    else if (state.tab === "picks") renderPicks();
    else if (state.tab === "analyze") { main.innerHTML = analyzeHTML(); bindAnalyze(); }
    else if (state.tab === "order") renderOrder();
    else if (state.tab === "account") { main.innerHTML = accountHTML(); bindAccount(); }
    else renderCatalog();
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
          '<button type="button" class="btn small" data-go="signup">رایگان شروع کن</button></div>';
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
            (c.is_new ? '<span class="pill new">جدید امروز</span>' : "") +
            (typeof c.taken === "number" && c.taken > 0 ? '<span class="pill neutral" title="تعداد فروشنده‌هایی که این محصول رو برداشتن">' + toman(c.taken) + " فروشنده برداشته</span>" : "") + "</div></div>" +
        '<div class="score ' + c.verdict + '" title="امتیاز از 100">' + c.score + "<small>امتیاز</small></div>" +
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
      '<div class="card-foot">' +
        (c.verdict !== "red" ? '<button type="button" class="btn small" data-cart="' + esc(c.id) + '">افزودن به سبد سفارش' + ic("cart") + "</button>" : "") +
        '<button type="button" class="btn ghost small" data-calc="' + esc(c.id) + '">حساب‌وکتاب در ماشین‌حساب' + ic("calc") + "</button>" +
        (c.offer && c.offer.url ? '<button type="button" class="btn ghost small" data-media="' + esc(c.id) + '">عکس و ویدیو' + ic("media") + "</button>" : "") + "</div>" +
      "</article>";
  }

  // Every cost of one sale. The store's share is split the way the contract says (clause 5);
  // cuts the contract doesn't have show only when set (another store's settings).
  function costTable(p, packQty, weightKg) {
    var cfg = state.config.pricing || {}, share = Math.round((cfg.platform_pct || 0) * 100);
    var split = (cfg.platform_split || []).map(function (x) {
      return '<tr class="sub"><td>' + (SPLIT_FA[x[0]] || x[0]) + " (" + toman(Math.round(x[1] * 100)) + "%)</td><td>" + usd(p.price_usd * x[1]) + "</td></tr>";
    }).join("");
    var opt = function (label, v) { return v ? row(label, v) : ""; };
    return '<table class="costs"><tbody>' +
      row("قیمت کارخونه" + (packQty > 1 ? " (" + packQty + " عدد)" : ""), p.factory_usd) +
      row("ایجنت و حمل داخل چین", p.china_side_usd) +
      row("حمل تا انبار دبی (" + Number(weightKg).toFixed(2) + " کیلو)", p.freight_usd) +
      opt("بسته‌بندی", p.packaging_usd) +
      '<tr class="total"><td>تمام‌شده تا انبار دبی</td><td>' + usd(p.landed_usd) + "</td></tr>" +
      row("سهم راینومال (" + toman(share) + "% از قیمت فروش)", p.platform_fee_usd) + split +
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
        "<li>اول 1 تا 3 عدد نمونه بخر و جنس، اندازه و بسته‌بندی رو چک کن.</li>" +
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
    each(root, "[data-cart]", function (b) {
      b.onclick = function () { addToCart(findCard(b.dataset.cart), b); };
    });
    bindCopy(root);
  }

  // --- landing (logged out): what the hunter does, a live demo, then sign-up ---------------

  // One product through the whole pipeline, for the demo. The listing and supplier are
  // sample data; every price below them is worked out live by calc.js with the site's settings.
  var EXAMPLE = {
    title_fa: "پرکننده‌ی شکاف صندلی خودرو، چرمی با جیب (2 عددی)",
    temu: { title: "2 Pack Car Seat Gap Filler, PU Leather Organizer with Storage Pocket", price: 11.99 },
    amazon: { price: 16.99, sold: 5000 },
    offer: {
      title: "座椅缝隙收纳盒 皮革 悬挂式", shop: "کارخانه‌ی نمونه در ییوو", location: "浙江 义乌", years: 8,
      rating: 4.8, repurchase: 0.32, moq: 10, price: 6.65, tiers: [[10, 6.65], [100, 6.12], [1000, 5.65]],
    },
    units: 2, weight_kg: 0.4,
  };
  var STEPS = ["پیدا کن", "از منبع بخر", "هزینه‌ها", "قیمت و سود"];
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
    var cfg = state.config || {}, pricing = cfg.pricing || {}, share = sharePct();
    var faq = [
      ["شکارچی برای کیه؟", "برای فروشنده‌های راینومال که از چین جنس میارن و می‌خوان قبل از خرید بدونن چی بیارن، از کجا بخرن و چقدر سود می‌کنن."],
      ["چینی بلد نیستم؛ حساب 1688 لازمه؟", "نه. اطلاعات تأمین‌کننده همین‌جا به فارسیه. فقط لینک رو برای ایجنت خریدت بفرست."],
      ["قیمت نهایی و سهم راینومال رو حساب می‌کنه؟", "بله، با فرمول خود قرارداد: (بهای تمام‌شده + سود تو) ÷ " + (1 - share / 100).toFixed(1) +
        ". سهم " + share + "% راینومال ارسال، بسته‌بندی، انبار، تبلیغات و مرجوعی رو پوشش می‌ده؛ هزینه‌ی دیگه‌ای نداری."],
      ["امتیاز پنل هم حساب میشه؟", "بله. ماشین‌حساب نشون می‌ده امتیاز پنل (" + ltr(usd(pricing.license_usd || 10000)) + " در " +
        (pricing.license_installments || 10) + " قسط) چند ماهه از سودت برمی‌گرده. شریک قبلی راینومال هستی؟ معافی."],
      ["عکس و ویدیوی محصول هم می‌گیرم؟", "بله. برای هر محصول، اصلی یا مربعی آماده‌ی آگهی؛ از داخل ایران هم دانلود میشه."],
      ["داده‌ها از کجا میان؟", "از خود Temu، آمازون و 1688. کنار هر محصول لینکش هست تا با چشم خودت ببینی."],
      ["عددها چقدر دقیقن؟", "برآوردی دقیق، نه قطعی. کرایه و هزینه‌ها رو در ماشین‌حساب با عدد خودت عوض کن و قبل از سفارش اصلی، نمونه بگیر."],
      ["چرا هر محصول فقط به چند فروشنده می‌رسه؟", "تا قیمت‌ها نشکنه. هر محصول حداکثر به " + (cfg.per_product || 3) + " فروشنده داده میشه؛ بازار مال خودت می‌مونه."],
      ["پشتیبانی با کیه؟", "با خود ما، مستقیم. " + supportLine("")],
    ];
    return '<div class="lp">' + worldHTML() + demoBarHTML() +
      '<section class="lp-hero">' +
        "<div>" +
          '<span class="lp-eyebrow fa">مخصوص فروشنده‌های راینومال</span>' +
          "<h1>چی بیاری، از کجا بخری،<br><em>چند بفروشی.</em></h1>" +
          '<p class="lp-lead">پرفروش‌های هر روز Temu و آمازون، همون جنس در 1688، و قیمتی که از Temu ارزون‌تره. سهم راینومال از قبل کم شده؛ عددی که می‌بینی، سود خودته.</p>' +
          '<div class="lp-ctas"><button type="button" class="btn shine" data-go="signup">رایگان شروع کن' + ic("back") + "</button>" +
            '<button type="button" class="btn ghost" data-go="demo">' + ic("play") + "ببین چطور کار می‌کنه</button></div>" +
          '<div class="lp-stats"><div><b>3</b><span>بازار، هر روز زیر نظر</span></div>' +
            "<div><b>" + share + "%</b><span>سهم راینومال، با ارسال و انبار و تبلیغات</span></div>" +
            "<div><b>" + (cfg.per_product || 3) + "</b><span>فروشنده برای هر محصول، نه بیشتر</span></div></div>" +
        "</div>" +
        radarHTML() +
      "</section>" +
      '<section class="lp-sec band" id="demo"><div class="lp-in">' +
        head("دموی زنده", "یه محصول، از Temu تا <em>سود تو.</em>", "ببین شکارچی در چهار قدم با یه محصول چی کار می‌کنه. عددها همین الان حساب میشن.") +
        '<div class="lp-seg" role="tablist" aria-label="قدم‌های دمو" id="demo-seg">' + STEPS.map(function (s, n) {
          return '<button type="button" role="tab" data-step="' + n + '" aria-selected="' + (n === landing.step) + '"><span class="n">0' + (n + 1) + "</span>" + s + "</button>";
        }).join("") + "</div>" +
        '<div class="lp-stage glass bk" id="demo-stage" role="tabpanel">' + stepHTML(landing.step) + "</div>" +
      "</div></section>" +
      trialHTML() +
      toolsHTML() +
      '<section class="lp-sec band" id="plans"><div class="lp-in">' +
        head("پلن‌ها", "با رایگان شروع کن، <em>هر وقت خواستی بزرگ‌تر شو.</em>", "قیمت‌ها به دلاره و به نرخ روز، به تومان با کارت بانکی از درگاه زرین‌پال پرداخت میشه. قرارداد بلندمدت نداره.") +
        '<div class="plans">' + plansHTML(false) + "</div>" +
      "</div></section>" +
      '<section class="lp-sec" id="signup"><div class="lp-in lp-signup">' +
        '<div>' + head("ثبت‌نام", "یه دقیقه تا <em>اولین شکار.</em>", "ثبت‌نام رایگانه و کارت بانکی نمی‌خواد. همون لحظه میز کارت با همه‌ی ابزارها باز میشه.") +
          '<ul class="lp-checks">' + [
            "شکارهای امروز، ماشین‌حساب و تحلیل لینک، روی یه میز کار",
            "عکس و ویدیوی آماده‌ی آگهی برای هر محصول",
            "حساب‌وکتاب دقیق با قوانین قرارداد راینومال",
            "هر سؤالی داشتی، پشتیبانی کنارته" + ((cfg.support || {}).name ? ": " + esc(cfg.support.name) : ""),
          ].map(function (t) { return "<li>" + ic("check") + "<span>" + t + "</span></li>"; }).join("") + "</ul></div>" +
        '<div class="glass bk auth" id="auth">' + authHTML() + "</div>" +
      "</div></section>" +
      '<section class="lp-sec band" id="faq"><div class="lp-in lp-narrow">' + head("سؤال‌ها", "جواب کوتاه، <em>خیال راحت.</em>", "") +
        '<div class="lp-faq">' + faq.map(function (q) { return "<details><summary>" + q[0] + "</summary><p>" + q[1] + "</p></details>"; }).join("") + "</div>" +
      "</div></section>" +
    "</div>";
  }
  function head(eyebrow, title, sub) {
    return '<div class="lp-head"><p class="lp-eyebrow fa">' + eyebrow + '</p><h2 class="lp-title">' + title + "</h2>" +
      (sub ? '<p class="lp-sub">' + sub + "</p>" : "") + "</div>";
  }
  // In the demo there's no server: this jumps straight to what a seller sees after signing up.
  function demoBarHTML() {
    return DEMO ? '<div class="lp-demo-bar"><span>نسخه‌ی نمایشی: هر اسم و ایمیلی قبوله.</span>' +
      '<button type="button" class="btn" data-demo-enter>ورود مستقیم به میز کار' + ic("back") + "</button></div>" : "";
  }

  // --- the hero's radar: products pass through, the hunter locks on, costs each one and decides ---

  // Sample listings passing the radar: the 1688 price in yuan for the listing's units, weight in
  // kg, and the Temu and Amazon prices. Every figure shown is worked out live by calc.js with the
  // site's settings; `flag` is what the hunt's own checks say (a restricted good, a brand).
  var RADAR = [
    { name: "پرکننده‌ی شکاف صندلی خودرو (2 عددی)", cny: 6.65, units: 2, kg: 0.4, temu: 11.99, amazon: 16.99 },
    { name: "صندلی تاشوی کمپینگ", cny: 48, units: 1, kg: 3.6, temu: 17.99, amazon: 24.99 },
    { name: "زیرانداز لیسیدنی سگ (2 عددی)", cny: 3.2, units: 2, kg: 0.24, temu: 5.49, amazon: 9.99 },
    { name: "جاروشارژی خودرو", cny: 38, units: 1, kg: 1.1, temu: 19.99, amazon: 29.99, flag: ["red", "باتری لیتیومی داره؛ ارسالش ممنوعه.", "ممنوع"] },
    { name: "کیسه‌ی نگهداری زیر تخت (3 عددی)", cny: 8.5, units: 3, kg: 0.6, temu: 15.99, amazon: 21.99 },
    { name: "آینه‌ی قدی ایستاده", cny: 65, units: 1, kg: 5.5, temu: 27.99, amazon: 39.99 },
    { name: "کیف نظم‌دهنده‌ی چمدان (6 تایی)", cny: 17, units: 1, kg: 0.7, temu: 13.99, amazon: 19.99 },
    { name: "پایه‌ی مغناطیسی موبایل خودرو", cny: 9.5, units: 1, kg: 0.15, temu: 11.49, amazon: 19.99, flag: ["yellow", "طرحش شبیه یه برند ثبت‌شده‌ست؛ قبل از خرید بررسی کن.", "ریسک برند"] },
    { name: "آبچکان کشویی روی سینک", cny: 42, units: 1, kg: 1.9, temu: 24.99, amazon: 32.99 },
    { name: "چهارپایه‌ی تاشو", cny: 22, units: 1, kg: 2.8, temu: 12.99, amazon: 18.99 },
    { name: "فرکننده‌ی مو بدون حرارت", cny: 4.5, units: 1, kg: 0.08, temu: 6.99, amazon: 9.99 },
    { name: "چراغ خواب رومیزی", cny: 28, units: 1, kg: 1.4, temu: 16.99, amazon: 24.99 },
  ];
  var RADAR_SAY = { green: "شکار شد", yellow: "با احتیاط", red: "رد شد" };
  var RADAR_ICON = { green: "check", yellow: "warn", red: "x" };

  // One listing through the hunter: its cost to Dubai, the store's share and the profit at the
  // price it would sell for. When no profitable price is under Temu, that's the price just under
  // Temu, and the profit there is a loss.
  function radarEval(x) {
    var p = state.config && state.config.pricing;
    var r = p && quote({ price: x.cny, units: x.units, weight_kg: x.kg, temu_usd: x.temu, amazon_usd: x.amazon });
    if (!r) return null;
    var price = r.price_usd, verdict = r.verdict, why;
    if (r.vs_benchmark > 1 + p.max_premium) {
      price = Calc.charmDown(x.temu * (1 - p.undercut));
      why = "سنگینه (" + ltr(x.kg) + " کیلو)؛ کرایه سود رو می‌خوره و زیر قیمت Temu زیان می‌ده.";
    } else if (verdict === "green") {
      why = ltr(Math.round((1 - r.vs_benchmark) * 100) + "%") + " ارزون‌تر از Temu، با حاشیه‌ی سود " + ltr(pct(r.margin)) + ".";
    } else {
      why = "حاشیه‌ی سودش کمه؛ با احتیاط.";
    }
    var tag = null;
    if (x.flag) { verdict = x.flag[0]; why = x.flag[1]; tag = x.flag[2]; }
    var cost = r.unit_cost, fees = price * (1 - r.keep);
    return { name: x.name, verdict: verdict, why: why, tag: tag, price: price, cost: cost, fees: fees, profit: price * r.keep - cost,
      feesLabel: Math.abs(r.keep - (1 - p.platform_pct)) < 1e-9 ? "سهم راینومال " + sharePct() + "%" : "سهم و کارمزدها" };
  }

  function radarHTML() {
    return '<div class="radar glass bk beam" id="radar">' +
      '<div class="rd-top"><span class="rd-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span><b>رادار شکار</b>' +
        '<span class="rd-src" dir="ltr">TEMU · AMAZON · 1688</span>' +
        '<span class="rd-tally"><span>بررسی <b id="rd-seen">0</b></span><span class="g">شکار <b id="rd-hit">0</b></span>' +
        '<span class="r">رد <b id="rd-miss">0</b></span></span></div>' +
      '<div class="rd-stage" id="rd-stage" aria-hidden="true"><canvas></canvas><div class="rd-labels" id="rd-labels"></div>' +
        '<div class="rd-hud tr"><span class="live"><i></i>اسکن زنده</span><bdi id="rd-az">AZ 000°</bdi></div>' +
        '<div class="rd-hud tl"><small>آخرین تصمیم‌ها</small><ol id="rd-log"></ol></div>' +
        '<div class="rd-hud bl"><small>نرخ شکار</small><b id="rd-rate">—</b><i class="meter"><s id="rd-rate-bar"></s></i></div>' +
        '<div class="rd-hud br"><span><i class="k w"></i>اسکن‌نشده</span><span><i class="k y"></i>در بررسی</span>' +
          '<span><i class="k g"></i>شکار</span><span><i class="k r"></i>رد</span></div>' +
      "</div>" +
      '<div class="rd-card" id="rd-card">' + radarCardHTML(radarEval(RADAR[0]), false) + "</div>" +
    "</div>";
  }
  // What the radar has locked on: the margin as a ring, where each dollar of the price goes, then
  // profit or loss. Figures carry data-v so they can count up when they appear.
  function radarCardHTML(e, busy) {
    if (!e) return '<p class="rd-why">' + ERRORS.unprofitable_settings + "</p>";
    var loss = e.profit < 0, total = Math.max(e.price, e.cost + e.fees), m = e.profit / e.price;
    var tone = busy ? "" : { green: "g", yellow: "y", red: "r" }[e.verdict];
    var w = function (x) { return (Math.max(0, x) / total * 100).toFixed(2) + "%"; };
    var val = function (x, sign) {
      return busy ? "···" : '<span data-v="' + x.toFixed(2) + '"' + (sign ? ' data-sign="1"' : "") + ">" + (sign && x >= 0 ? "+" : "") + usd(x) + "</span>";
    };
    var arc = busy ? 0 : Math.min(1, Math.abs(m)) * 119.4;
    return '<div class="rd-card-h">' +
        '<div class="rd-gauge ' + tone + '" title="حاشیه‌ی ' + (loss ? "زیان" : "سود") + '"><svg viewBox="0 0 44 44"><circle class="bg" cx="22" cy="22" r="19"/>' +
          '<circle class="fg" cx="22" cy="22" r="19" data-arc="' + arc.toFixed(1) + '" style="stroke-dasharray:' + arc.toFixed(1) + ' 200"/></svg>' +
          "<b>" + (busy ? "··" : (loss ? "−" : "") + Math.round(Math.abs(m) * 100) + "%") + "</b></div>" +
        '<div class="rd-name"><small>' + (busy ? "در حال تحلیل…" : "قفل روی") + "</small><b>" + esc(e.name) + "</b></div>" +
        (busy ? '<span class="pill neutral"><span class="dot"></span>تحلیل</span>'
          : '<span class="pill ' + e.verdict + '">' + ic(RADAR_ICON[e.verdict]) + RADAR_SAY[e.verdict] + "</span>") + "</div>" +
      (busy ? '<div class="rd-bar busy"></div>' : '<div class="rd-bar"><i class="c" style="width:' + w(e.cost) + '"></i><i class="s" style="width:' + w(e.fees) + '"></i>' +
        (loss ? '<i class="loss" style="inset-inline-start:' + w(e.price) + '"></i><i class="mark" style="inset-inline-start:' + w(e.price) + '"></i>'
          : '<i class="p" style="width:' + w(e.profit) + '"></i>') + "</div>") +
      '<div class="rd-cells">' +
        '<div><span><i class="sw c"></i>تمام‌شده تا دبی</span><b>' + val(e.cost) + "</b></div>" +
        '<div><span><i class="sw s"></i>' + e.feesLabel + "</span><b>" + val(e.fees) + "</b></div>" +
        "<div><span>" + (loss ? "قیمت زیر Temu" : "قیمت فروش") + "</span><b>" + val(e.price) + "</b></div>" +
        '<div class="pl ' + (busy ? "" : loss ? "r" : "g") + '"><span><i class="sw ' + (loss ? "l" : "p") + '"></i>' + (loss ? "زیان هر عدد" : "سود هر عدد") + "</span><b>" +
          val(e.profit, true) + "</b></div>" +
      "</div>" +
      '<p class="rd-why">' + (busy ? "هزینه‌ها، سهم راینومال و قیمت رقبا در حال محاسبه‌ست." : esc(e.why)) + "</p>";
  }

  // The radar, drawn on a canvas: a thick disc in 3D with a sweep and a curtain of light behind it,
  // the logo floating over a beam in the middle, and the products as boxes. Unscanned boxes are
  // wireframes; the sweep makes them solid. The hunter locks on, scans the box and decides: a hunt
  // is lifted into the logo, a reject breaks up. Labels are HTML over the canvas, placed by the
  // same projection.
  var radar = { raf: 0, io: null, ro: null, onResize: null };
  var TILT = 57 * Math.PI / 180, SPIN_MS = 3600, LANES = [-0.66, -0.38, 0.3, 0.6];  // clear of the logo in the middle
  var BOX = 0.12, PYLON = 0.48, THICK = 0.07, TAU = Math.PI * 2;
  var YELLOW = [250, 197, 7], GREEN = [52, 211, 153], RED = [248, 113, 113], AMBER = [251, 146, 60], WHITE = [235, 235, 235];
  var GLOWS = {};
  function glowSprite(c) {  // a soft round light in colour c, drawn once and reused
    var key = c.join();
    if (GLOWS[key]) return GLOWS[key];
    var g = document.createElement("canvas");
    g.width = g.height = 64;
    var x = g.getContext("2d"), grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, rgba(c, 1)); grd.addColorStop(0.3, rgba(c, 0.4)); grd.addColorStop(1, rgba(c, 0));
    x.fillStyle = grd; x.fillRect(0, 0, 64, 64);
    return (GLOWS[key] = g);
  }
  function rgba(c, a) { return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + a + ")"; }
  function shade(c, k) { return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)]; }
  function mix(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function shortName(s) { return s.length > 24 ? s.slice(0, 23) + "…" : s; }

  function bindRadar() {
    stopRadar();
    var stage = $("rd-stage");
    if (!stage) return;
    var cv = stage.querySelector("canvas"), ctx = cv.getContext && cv.getContext("2d");
    var labels = $("rd-labels"), card = $("rd-card"), evals = RADAR.map(radarEval);
    if (!ctx || !evals[0]) return;
    var sn = Math.sin(TILT), cs = Math.cos(TILT), moving = false;
    var geo = {}, items = [], sparks = [], motes = [], wait = {};
    var next = 1, t = 0, last = 0, held = null, releasedAt = -1e9, flash = -1e9, tween = null;
    var tally = { seen: 0, hit: 0, miss: 0 };
    var logo = new Image();
    logo.onload = function () { if (!moving) draw(); };
    logo.src = "/static/brand/logo-192.png";
    for (var i = 0; i < 28; i++) motes.push({ a: Math.random() * TAU, r: Math.sqrt(Math.random()) * 0.95, h: Math.random() * 0.7, sp: 0.00004 + Math.random() * 0.00006 });

    // A point over the disc (u right, v towards the viewer, h up; in radii) -> the screen.
    function at(u, v, h) {
      var R = geo.R, z = (v * sn + h * cs) * R, s = geo.P / (geo.P - z);
      return { x: geo.cx + u * R * s, y: geo.cy + (v * cs - h * sn) * R * s, s: s };
    }
    function polar(a, r, h, u0, v0) { return at((u0 || 0) + Math.sin(a) * r, (v0 || 0) - Math.cos(a) * r, h || 0); }
    function circle(r, h, u0, v0, n) {
      var pts = [];
      n = n || 96;
      for (var k = 0; k < n; k++) pts.push(polar(k / n * TAU, r, h, u0, v0));
      return pts;
    }
    function path(pts) {
      ctx.beginPath();
      for (var k = 0; k < pts.length; k++) k ? ctx.lineTo(pts[k].x, pts[k].y) : ctx.moveTo(pts[k].x, pts[k].y);
      ctx.closePath();
    }
    function line(a, b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    function light(p, r, c, a) {
      if (a <= 0.01) return;
      var was = ctx.globalAlpha;
      ctx.globalAlpha = was * Math.min(1, a);
      ctx.drawImage(glowSprite(c), p.x - r, p.y - r, r * 2, r * 2);
      ctx.globalAlpha = was;
    }

    // The largest disc that fits, with room above for the logo and the far labels, below for its rim.
    // The disc almost as wide as the stage, and the stage as tall as the disc needs: no empty band
    // above or below it. The corners left over hold the HUD panels.
    function measure() {
      var w = stage.clientWidth, dpr = Math.min(2, window.devicePixelRatio || 1);
      geo = { cx: w / 2, cy: 0, R: w * 0.475, dpr: dpr };
      geo.P = geo.R * 4.4;
      var top = Math.min(at(0, -1, 0).y, at(0, 0, PYLON + 0.2).y, at(0, LANES[0], BOX * 1.2).y - 46);
      var h = Math.round(Math.max(220, at(0, 1, -THICK).y + 12 - top + 10));
      geo.cy = 10 - top;
      geo.w = w;
      stage.style.height = h + "px";
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      geo.k = Math.max(0.78, Math.min(1.15, geo.R / 210));
    }

    function spawn(lane, u, n) {
      var el = document.createElement("div");
      el.className = "rd-tag";
      labels.appendChild(el);
      var it = { lane: lane, v: LANES[lane], u: u, h: 0, n: n, e: evals[n], x: RADAR[n], el: el, state: "new",
        ping: -1e9, matAt: null, speed: 0.12 + Math.random() * 0.05, rot: Math.random() * TAU,
        spin: (Math.random() < 0.5 ? -1 : 1) * (0.00022 + Math.random() * 0.0002),
        size: BOX * (0.85 + Math.random() * 0.35), tall: 0.72 + Math.random() * 0.3, scale: 1, fade: 1 };
      tag(it, '<bdi>Temu ' + usd(it.x.temu) + "</bdi>", "");
      items.push(it);
      return it;
    }
    function chord(v) { return Math.sqrt(Math.max(0, 1 - v * v)); }
    function tag(it, html, cls) { it.el.innerHTML = html; it.el.className = "rd-tag" + (cls ? " " + cls : ""); }
    function tone(e) { return { green: "g", yellow: "y", red: "r" }[e.verdict]; }
    function colour(e) { return { green: GREEN, yellow: AMBER, red: RED }[e.verdict]; }
    function setTally(bump) {
      $("rd-seen").textContent = tally.seen; $("rd-hit").textContent = tally.hit; $("rd-miss").textContent = tally.miss;
      var b = bump && $(bump);
      if (b && moving) { b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); }
    }
    function burst(it, c, n, up) {
      for (var k = 0; k < n; k++) {
        sparks.push({ u: it.u + (Math.random() - 0.5) * it.size, v: it.v + (Math.random() - 0.5) * it.size, h: it.h + Math.random() * it.size * it.tall,
          du: (Math.random() - 0.5) * 0.0007, dv: (Math.random() - 0.5) * 0.0007, dh: (up ? 0.0004 : 0.0001) + Math.random() * 0.0006,
          life: 700 + Math.random() * 700, max: 1400, c: c });
      }
    }
    function floatText(it, text, cls) {
      if (!moving) return;
      var p = at(it.u, it.v, it.h + it.size * it.tall + 0.03), el = document.createElement("div");
      el.className = "rd-float " + cls;
      el.innerHTML = "<bdi>" + esc(text) + "</bdi>";
      el.style.transform = "translate(" + p.x.toFixed(1) + "px," + (p.y - 46 * geo.k).toFixed(1) + "px)";  // above the label
      el.addEventListener("animationend", function () { if (el.parentNode) el.parentNode.removeChild(el); });
      labels.appendChild(el);
    }
    function showCard(e, busy) {
      card.innerHTML = radarCardHTML(e, busy);
      if (busy || !moving) return;
      var fg = card.querySelector(".fg");  // the ring fills, the figures count up
      fg.style.strokeDasharray = "0 200"; void fg.getBoundingClientRect(); fg.style.strokeDasharray = fg.dataset.arc + " 200";
      tween = { at: t, els: Array.prototype.map.call(card.querySelectorAll("[data-v]"), function (el) {
        return { el: el, v: Number(el.dataset.v), sign: !!el.dataset.sign };
      }) };
    }
    function stepTween() {
      if (!tween) return;
      var p = clamp01((t - tween.at) / 700), k = 1 - Math.pow(1 - p, 3);
      tween.els.forEach(function (x) { var v = x.v * k; x.el.textContent = (x.sign && v >= 0 ? "+" : "") + usd(v); });
      if (p >= 1) tween = null;
    }

    function lockOn(it) {
      held = { it: it, at: t };
      it.state = "lock";
      tag(it, "<b>" + esc(shortName(it.x.name)) + "</b><small>در حال تحلیل…</small>", "lock");
      showCard(it.e, true);
    }
    function reveal(it) {
      var e = it.e, cls = tone(e), value = e.tag || (e.profit < 0 ? "" : "+") + usd(e.profit);
      it.state = "done";
      tag(it, "<b>" + esc(shortName(e.name)) + '</b><small class="' + cls + '">' + ic(RADAR_ICON[e.verdict]) + RADAR_SAY[e.verdict] +
        " · <bdi>" + esc(value) + "</bdi></small>", "lock " + cls);
      showCard(e, false);
      if (moving) { burst(it, colour(e), 24, true); floatText(it, value, cls); }
      if (e.verdict === "green") tally.hit++;
      if (e.verdict === "red") tally.miss++;
      tally.decided = (tally.decided || 0) + 1;
      setTally(e.verdict === "green" ? "rd-hit" : e.verdict === "red" ? "rd-miss" : null);
      var log = $("rd-log"), row = document.createElement("li");
      row.className = cls;
      row.innerHTML = ic(RADAR_ICON[e.verdict]) + "<span>" + esc(shortName(e.name).slice(0, 18)) + "</span><bdi>" + esc(value) + "</bdi>";
      log.insertBefore(row, log.firstChild);
      while (log.children.length > 3) log.removeChild(log.lastChild);
      var rate = tally.hit / tally.decided;
      $("rd-rate").textContent = Math.round(rate * 100) + "%";
      $("rd-rate-bar").style.width = Math.round(rate * 100) + "%";
    }
    function release() {
      var it = held.it, e = it.e;
      held = null; releasedAt = t;
      if (e.verdict === "green") {  // lifted into the logo
        it.fly = { at: t, u: it.u, v: it.v };
        tag(it, "<bdi>+" + usd(e.profit) + "</bdi>", "g");
      } else if (e.verdict === "red") {  // breaks up
        it.dissolve = t;
        burst(it, RED, 46, false);
        tag(it, "<bdi>" + esc(e.tag || usd(e.profit)) + "</bdi>", "r");
      } else {
        tag(it, "<bdi>" + esc(e.tag || usd(e.profit)) + "</bdi>", "y");
      }
    }

    function step(dt) {
      t += dt;
      var sweep = (t / SPIN_MS) * TAU % TAU;
      items.forEach(function (it) {
        it.rot += it.spin * dt * (it.fly ? 10 : 1);
        if (it.fly) {
          var p = clamp01((t - it.fly.at) / 1300), q = p * p * (3 - 2 * p);
          it.u = it.fly.u * (1 - q); it.v = it.fly.v * (1 - q); it.h = PYLON * Math.pow(q, 0.7); it.scale = 1 - 0.8 * q;
          if (p >= 1) { it.gone = true; flash = t; }
          return;
        }
        if (it.dissolve) {
          it.fade = 1 - clamp01((t - it.dissolve) / 650);
          if (it.fade <= 0) it.gone = true;
          return;
        }
        it.u -= it.speed * (held && held.it === it ? 0.25 : 1) * dt / 1000;
        if (it.u < -chord(it.v) - 0.03) { it.gone = true; return; }
        var a = (Math.atan2(it.u, -it.v) + TAU) % TAU;
        if ((sweep - a + TAU) % TAU < 0.18 && t - it.ping > 1200 && Math.abs(it.u) < chord(it.v) - 0.04) {  // the sweep just passed it
          it.ping = t;
          if (it.state === "new") { it.state = "seen"; it.matAt = t; tally.seen++; setTally(); }
          if (!held && t - releasedAt > 600 && it.state === "seen" && it.u + chord(it.v) > 0.55 && Math.hypot(it.u, it.v) < 0.8) lockOn(it);
        }
      });
      if (held && held.it.state === "lock" && t - held.at > 1100) reveal(held.it);
      if (held && t - held.at > 4200) release();
      items = items.filter(function (it) {
        if (!it.gone) return true;
        labels.removeChild(it.el);
        wait[it.lane] = t + 400 + Math.random() * 1600;
        return false;
      });
      LANES.forEach(function (v, lane) {
        if ((wait[lane] || 0) <= t && !items.some(function (it) { return it.lane === lane; })) {
          spawn(lane, chord(v) + 0.02, next);
          next = (next + 1) % RADAR.length;
        }
      });
      sparks = sparks.filter(function (s) {
        s.life -= dt; s.u += s.du * dt; s.v += s.dv * dt; s.h = Math.max(0, s.h + s.dh * dt); s.dh -= 0.0000014 * dt;
        return s.life > 0;
      });
      motes.forEach(function (m) { m.h += m.sp * dt; if (m.h > 0.75) { m.h = 0; m.a = Math.random() * TAU; m.r = Math.sqrt(Math.random()) * 0.95; } });
      stepTween();
    }

    function floor() {
      var c0 = at(0, 0, 0), k, a, p1, p2;
      // the grid around the disc, drifting the way the products go
      var fade = ctx.createRadialGradient(c0.x, c0.y, geo.R * 0.5, c0.x, c0.y, geo.R * 2.2);
      fade.addColorStop(0, rgba(YELLOW, 0.17)); fade.addColorStop(1, rgba(YELLOW, 0));
      ctx.strokeStyle = fade; ctx.lineWidth = 1; ctx.beginPath();
      var drift = (t * 0.00004) % 0.3;
      for (var g = -2.4; g <= 2.41; g += 0.3) {
        line(at(g - drift, -2.4, 0), at(g - drift, 2.4, 0));
        line(at(-2.4, g, 0), at(2.4, g, 0));
      }
      ctx.stroke();
      // the disc's edge, lit
      var upper = [], lower = [];
      for (k = 0; k <= 48; k++) { a = Math.PI / 2 + k / 48 * Math.PI; upper.push(polar(a, 1, 0)); lower.push(polar(a, 1, -THICK)); }
      path(upper.concat(lower.reverse()));
      var side = ctx.createLinearGradient(0, at(0, 1, 0).y, 0, at(0, 1, -THICK).y);
      side.addColorStop(0, rgba(YELLOW, 0.5)); side.addColorStop(0.45, "rgba(80,60,4,.95)"); side.addColorStop(1, "rgba(18,15,6,.98)");
      ctx.fillStyle = side; ctx.fill();
      ctx.globalCompositeOperation = "lighter";
      var strip = [];
      for (k = 0; k <= 60; k++) strip.push(polar(Math.PI / 2 + k / 60 * Math.PI, 1, -THICK * 0.55));
      ctx.beginPath();
      strip.forEach(function (p, n) { n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.setLineDash([2, 7]); ctx.lineDashOffset = -t * 0.02;
      ctx.strokeStyle = rgba(YELLOW, 0.9); ctx.lineWidth = 2; ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalCompositeOperation = "source-over";
      // the face
      var rim = circle(1, 0);
      path(rim); ctx.fillStyle = "rgba(15,14,10,.94)"; ctx.fill();
      ctx.save(); path(rim); ctx.clip();
      ctx.translate(c0.x, c0.y); ctx.scale(1, cs * 1.08);
      var face = ctx.createRadialGradient(0, 0, 0, 0, 0, geo.R * 1.05);
      face.addColorStop(0, rgba(YELLOW, 0.24)); face.addColorStop(0.45, rgba(YELLOW, 0.06)); face.addColorStop(0.9, rgba(YELLOW, 0.03)); face.addColorStop(1, rgba(YELLOW, 0.16));
      ctx.fillStyle = face; ctx.fillRect(-geo.R * 2, -geo.R * 2, geo.R * 4, geo.R * 4);
      ctx.restore();
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (k = 0; k < 24; k++) { a = k / 24 * TAU; line(polar(a, 0.12, 0), polar(a, 0.86, 0)); }
      ctx.strokeStyle = rgba(YELLOW, 0.07); ctx.stroke();
      [0.25, 0.5, 0.75].forEach(function (r) { path(circle(r, 0)); ctx.strokeStyle = rgba(YELLOW, 0.3); ctx.stroke(); });
      ctx.beginPath(); line(at(-1, 0, 0), at(1, 0, 0)); line(at(0, -1, 0), at(0, 1, 0));
      ctx.strokeStyle = rgba(YELLOW, 0.24); ctx.stroke();
      ctx.beginPath();
      for (k = 0; k < 72; k++) if (k % 6) { a = k / 72 * TAU; line(polar(a, 0.935, 0), polar(a, 0.975, 0)); }
      ctx.strokeStyle = rgba(YELLOW, 0.5); ctx.lineWidth = 1.1; ctx.stroke();
      ctx.beginPath();
      for (k = 0; k < 12; k++) { a = k / 12 * TAU; line(polar(a, 0.87, 0), polar(a, 0.975, 0)); }
      ctx.strokeStyle = rgba(YELLOW, 0.95); ctx.lineWidth = 2.2; ctx.stroke();
      path(rim); ctx.strokeStyle = rgba(YELLOW, 0.85); ctx.lineWidth = 1.8; ctx.stroke();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = rgba(YELLOW, 0.14); ctx.lineWidth = 7; ctx.stroke();
      // pulses from the middle
      for (k = 0; k < 2; k++) {
        var ph = (t / 2800 + k / 2) % 1;
        path(circle(Math.max(0.01, ph), 0)); ctx.strokeStyle = rgba(YELLOW, 0.4 * (1 - ph)); ctx.lineWidth = 1.5; ctx.stroke();
      }
      // the sweep, its trail and the curtain of light standing on its edge
      var A = (t / SPIN_MS) * TAU % TAU, o = at(0, 0, 0), N = 28, span = 1.25;
      for (k = 0; k < N; k++) {
        var a0 = A - (k + 1) / N * span, a1 = A - k / N * span;
        ctx.beginPath(); ctx.moveTo(o.x, o.y);
        p1 = polar(a0, 1, 0); p2 = polar((a0 + a1) / 2, 1, 0); var p3 = polar(a1, 1, 0);
        ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath();
        ctx.fillStyle = rgba(YELLOW, 0.28 * Math.pow(1 - k / N, 2)); ctx.fill();
      }
      for (k = 0; k < 7; k++) {
        var ak = A - k * 0.05, hk = 0.32 * (1 - k / 7), f1 = polar(ak, 1, 0), f2 = polar(ak, 1, hk);
        var wall = ctx.createLinearGradient(f1.x, f1.y, f2.x, f2.y);
        wall.addColorStop(0, rgba(YELLOW, 0.15 * (1 - k / 7))); wall.addColorStop(1, rgba(YELLOW, 0));
        path([o, f1, f2, at(0, 0, hk)]); ctx.fillStyle = wall; ctx.fill();
      }
      p1 = polar(A, 1, 0);
      ctx.beginPath(); line(o, p1); ctx.strokeStyle = "rgba(255,232,140,.95)"; ctx.lineWidth = 2; ctx.stroke();
      light(p1, 18 * geo.k, YELLOW, 0.9);
      ctx.globalCompositeOperation = "source-over";
    }

    function pylon() {
      var f = clamp01(1 - (t - flash) / 600), bob = Math.sin(t / 700) * 0.015;
      var base = at(0, 0, 0), top = at(0, 0, PYLON + bob), k;
      // a small drum the beam rises from
      path(circle(0.075, 0.035, 0, 0, 40)); ctx.fillStyle = "rgba(24,20,8,.95)"; ctx.fill();
      ctx.strokeStyle = rgba(YELLOW, 0.9); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.globalCompositeOperation = "lighter";
      light(base, 46 * geo.k, YELLOW, 0.5 + 0.4 * f);
      var bw = 8 * base.s * geo.k, beam = ctx.createLinearGradient(0, base.y, 0, top.y);
      beam.addColorStop(0, rgba(YELLOW, 0.6)); beam.addColorStop(1, rgba(YELLOW, 0.03));
      ctx.fillStyle = beam; ctx.beginPath();
      ctx.moveTo(base.x - bw, base.y); ctx.lineTo(base.x + bw, base.y); ctx.lineTo(top.x + bw * 0.35, top.y); ctx.lineTo(top.x - bw * 0.35, top.y);
      ctx.closePath(); ctx.fill();
      for (k = 0; k < 3; k++) {  // rings climbing the beam
        var ph = (t / 2400 + k / 3) % 1;
        path(circle(0.05 + 0.06 * (1 - ph), 0.04 + ph * PYLON * 0.8, 0, 0, 40));
        ctx.strokeStyle = rgba(YELLOW, 0.55 * (1 - ph)); ctx.lineWidth = 1.2; ctx.stroke();
      }
      var size = 84 * top.s * geo.k * (1 + 0.14 * f);
      light(top, size * (0.95 + 0.5 * f), YELLOW, 0.3 + 0.5 * f);
      ctx.globalCompositeOperation = "source-over";
      if (logo.complete && logo.naturalWidth) ctx.drawImage(logo, top.x - size / 2, top.y - size / 2, size, size);
    }

    function box(it) {
      var e = it.e, hs = it.size / 2 * it.scale, H = it.size * it.tall * it.scale, h0 = it.h;
      var edge = it.fly || it.dissolve ? 1 : clamp01((chord(it.v) - Math.abs(it.u)) / 0.12);
      var alpha = edge * it.fade, locked = held && held.it === it, k, p;
      if (alpha <= 0.01) return alpha;
      var decided = it.state === "done" || it.fly || it.dissolve, c = decided ? colour(e) : YELLOW;
      var mat = it.matAt == null ? 0 : moving ? clamp01((t - it.matAt) / 500) : 1;
      ctx.globalAlpha = alpha;
      // shadow, and light on the floor under a decided box
      path(circle(hs * 1.55, 0.001, it.u, it.v, 24)); ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fill();
      ctx.globalCompositeOperation = "lighter";
      if (decided || locked) light(at(it.u, it.v, 0), 34 * at(it.u, it.v, 0).s * geo.k, c, 0.45 * alpha);
      var pinged = clamp01((t - it.ping) / 800);
      if (pinged < 1) {
        path(circle(hs * (1.4 + 2.6 * pinged), 0.001, it.u, it.v, 32));
        ctx.strokeStyle = rgba(YELLOW, 0.7 * (1 - pinged) * alpha); ctx.lineWidth = 1.5; ctx.stroke();
      }
      if (locked) {  // a turning ring on the floor
        ctx.setLineDash([6, 5]); ctx.lineDashOffset = -t * 0.03;
        path(circle(hs * 2.7, 0.002, it.u, it.v, 44)); ctx.strokeStyle = rgba(YELLOW, 0.95); ctx.lineWidth = 1.6; ctx.stroke();
        ctx.setLineDash([]);
      }
      if (it.fly) {  // the lift
        var fb = at(it.fly.u, it.fly.v, 0), ft = at(it.u, it.v, h0 + H), beamW = 12 * fb.s * geo.k;
        var lift = ctx.createLinearGradient(0, fb.y, 0, ft.y);
        lift.addColorStop(0, rgba(GREEN, 0.5)); lift.addColorStop(1, rgba(GREEN, 0));
        ctx.fillStyle = lift; ctx.beginPath(); ctx.moveTo(fb.x - beamW, fb.y); ctx.lineTo(fb.x + beamW, fb.y); ctx.lineTo(ft.x, ft.y); ctx.closePath(); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      // the box
      var cn = [];
      for (k = 0; k < 4; k++) { var a = it.rot + k * Math.PI / 2; cn.push([it.u + Math.cos(a) * hs * Math.SQRT2, it.v + Math.sin(a) * hs * Math.SQRT2]); }
      var B = cn.map(function (q) { return at(q[0], q[1], h0); }), T = cn.map(function (q) { return at(q[0], q[1], h0 + H); });
      var camV = geo.P / geo.R * sn, faces = [];
      for (k = 0; k < 4; k++) {
        var k2 = (k + 1) % 4, mu = (cn[k][0] + cn[k2][0]) / 2, mv = (cn[k][1] + cn[k2][1]) / 2, nu = mu - it.u, nv = mv - it.v, nl = Math.hypot(nu, nv) || 1;
        nu /= nl; nv /= nl;
        if (nu * -mu + nv * (camV - mv) > 0) faces.push({ pts: [B[k], B[k2], T[k2], T[k]], lum: 0.52 + 0.4 * Math.max(0, -0.55 * nu + 0.6 * nv), k: k });
      }
      faces.push({ pts: T, lum: 1.08, top: true });
      var body = it.dissolve || decided && e.verdict === "red" ? mix(YELLOW, RED, 0.6) : YELLOW;
      function lerp(a, b, f) { return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }; }
      faces.forEach(function (fc) {
        path(fc.pts);
        if (mat > 0) {
          ctx.globalAlpha = alpha * mat;
          ctx.fillStyle = rgba(shade(body, fc.lum), 1); ctx.fill();
          // packing tape across the top and down two sides
          ctx.fillStyle = "rgba(70,48,0,.55)";
          if (fc.top) { path([lerp(T[0], T[1], 0.42), lerp(T[0], T[1], 0.58), lerp(T[3], T[2], 0.58), lerp(T[3], T[2], 0.42)]); ctx.fill(); }
          else if (fc.k === 0 || fc.k === 2) {
            var s0 = fc.pts, top0 = lerp(s0[3], s0[2], 0.42), top1 = lerp(s0[3], s0[2], 0.58);
            path([top0, top1, lerp(top1, lerp(s0[0], s0[1], 0.58), 0.45), lerp(top0, lerp(s0[0], s0[1], 0.42), 0.45)]); ctx.fill();
          }
          path(fc.pts); ctx.strokeStyle = "rgba(60,42,0,.55)"; ctx.lineWidth = 1; ctx.stroke();
        }
        if (mat < 1) {  // still a hologram
          ctx.globalAlpha = alpha * (1 - mat);
          ctx.fillStyle = "rgba(235,235,235,.07)"; ctx.fill();
          ctx.strokeStyle = rgba(WHITE, 0.75); ctx.lineWidth = 1.2; ctx.stroke();
        }
      });
      if (mat < 1) {  // the hidden edges of a wireframe
        ctx.globalAlpha = alpha * (1 - mat) * 0.35;
        ctx.beginPath();
        for (k = 0; k < 4; k++) { line(B[k], B[(k + 1) % 4]); line(B[k], T[k]); }
        ctx.strokeStyle = rgba(WHITE, 0.8); ctx.stroke();
      }
      ctx.globalAlpha = alpha;
      if (decided) {  // outlined in the verdict's colour
        ctx.globalCompositeOperation = "lighter";
        faces.forEach(function (fc) { path(fc.pts); ctx.strokeStyle = rgba(c, 0.9); ctx.lineWidth = 1.4; ctx.stroke(); });
        ctx.globalCompositeOperation = "source-over";
      }
      if (locked) {
        var scanned = it.state === "lock";
        ctx.globalCompositeOperation = "lighter";
        if (scanned) {  // a plane of light scanning the box
          var hsn = h0 + H * (0.5 + 0.5 * Math.sin(t / 170)), sq = [];
          for (k = 0; k < 4; k++) { var ang = it.rot + k * Math.PI / 2; sq.push(at(it.u + Math.cos(ang) * hs * 1.9, it.v + Math.sin(ang) * hs * 1.9, hsn)); }
          path(sq); ctx.fillStyle = rgba(YELLOW, 0.22); ctx.fill(); ctx.strokeStyle = rgba(YELLOW, 0.95); ctx.lineWidth = 1.2; ctx.stroke();
        }
        // a link to the logo, with data running along it
        var from = at(it.u, it.v, h0 + H), to = at(0, 0, PYLON);
        var link = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
        link.addColorStop(0, rgba(c, 0.85)); link.addColorStop(1, rgba(c, 0.1));
        ctx.beginPath(); line(from, to); ctx.strokeStyle = link; ctx.lineWidth = 1.3; ctx.stroke();
        for (k = 0; k < 3; k++) {
          var f = (t / 600 + k / 3) % 1;
          light({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f }, 6 * geo.k, c, 0.9);
        }
        // corner brackets round the box
        var xs = B.concat(T).map(function (q) { return q.x; }), ys = B.concat(T).map(function (q) { return q.y; });
        var grow = moving ? 1 + 0.6 * (1 - clamp01((t - held.at) / 300)) : 1, pad = 9 * geo.k * grow, len = 9 * geo.k;
        var x0 = Math.min.apply(null, xs) - pad, x1 = Math.max.apply(null, xs) + pad, y0 = Math.min.apply(null, ys) - pad, y1 = Math.max.apply(null, ys) + pad;
        ctx.beginPath();
        [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]].forEach(function (b) {
          ctx.moveTo(b[0] + b[2] * len, b[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(b[0], b[1] + b[3] * len);
        });
        ctx.strokeStyle = rgba(c, 1); ctx.lineWidth = 2; ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.globalAlpha = 1;
      return alpha;
    }

    function place(it, alpha) {  // the label over a box
      var show = it.state === "lock" || it.state === "done" || it.fly || it.dissolve || (it.state === "seen" && t - it.ping < 1500);
      if (!moving && it.state === "seen") show = false;
      var a = show ? alpha * (it.state === "seen" ? 1 - clamp01((t - it.ping - 1000) / 500) : 1) * (it.fly ? 1 - clamp01((t - it.fly.at) / 900) : 1) : 0;
      it.el.style.opacity = a.toFixed(3);
      if (a <= 0) return;
      var p = at(it.u, it.v, it.h + it.size * it.tall * it.scale + 0.03);
      it.el.style.transform = "translate(" + p.x.toFixed(1) + "px," + (p.y - 6 * geo.k).toFixed(1) + "px) translate(-50%,-100%)";
    }

    function draw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
      floor();
      var az = Math.round((t / SPIN_MS) * 360 % 360);
      if (az !== geo.az) { geo.az = az; $("rd-az").textContent = "AZ " + ("00" + az).slice(-3) + "°"; }
      var sorted = items.slice().sort(function (a, b) { return a.v - b.v; }), middle = false;
      sorted.forEach(function (it) {
        if (!middle && it.v >= 0) { pylon(); middle = true; }
        place(it, box(it));
      });
      if (!middle) pylon();
      ctx.globalCompositeOperation = "lighter";
      sparks.forEach(function (s) { light(at(s.u, s.v, s.h), 5 * geo.k, s.c, s.life / s.max * 1.4); });
      motes.forEach(function (m) { light(polar(m.a, m.r, m.h), 3 * geo.k, YELLOW, 0.5 * (1 - m.h / 0.75)); });
      ctx.globalCompositeOperation = "source-over";
    }

    measure();
    // Start mid-scan: the first product locked near the centre, others on their way.
    var first = spawn(2, 0.3, 0);
    [[0, 0.45], [1, -0.4], [3, -0.2]].forEach(function (s) { spawn(s[0], s[1] * chord(LANES[s[0]]), next); next = (next + 1) % RADAR.length; });
    items.forEach(function (it) { it.state = "seen"; it.matAt = -1e9; tally.seen++; });
    t = SPIN_MS * 0.8;
    held = { it: first, at: t - 1200 };
    first.state = "lock";
    reveal(first);
    draw();

    radar.onResize = function () { if (stage.clientWidth !== geo.w) { measure(); draw(); } };  // only a new width re-sizes it
    if (window.ResizeObserver) { radar.ro = new ResizeObserver(radar.onResize); radar.ro.observe(stage); }
    else window.addEventListener("resize", radar.onResize);
    if (!motionOK() || !window.requestAnimationFrame) return;

    function frame(now) {
      var dt = last ? Math.min(50, now - last) : 16;
      last = now;
      step(dt); draw();
      radar.raf = requestAnimationFrame(frame);
    }
    function run(on) {
      cancelAnimationFrame(radar.raf); radar.raf = 0; last = 0; moving = on;
      if (on) radar.raf = requestAnimationFrame(frame);
    }
    if (window.IntersectionObserver) {
      radar.io = new IntersectionObserver(function (entries) { run(entries[entries.length - 1].isIntersecting); }, { threshold: 0.1 });
      radar.io.observe(stage);
    } else run(true);
  }
  function stopRadar() {
    cancelAnimationFrame(radar.raf); radar.raf = 0;
    if (radar.io) { radar.io.disconnect(); radar.io = null; }
    if (radar.ro) { radar.ro.disconnect(); radar.ro = null; }
    if (radar.onResize) { window.removeEventListener("resize", radar.onResize); radar.onResize = null; }
  }

  // --- the world strip: the route from China's factories, past the hunter, to the customer --------

  // Land from the Red Sea to the Yellow Sea on a 0.6° grid, a bit per point: rows from 44°N down to
  // 8°N, columns from 34°E. Sampled from NOAA's GLOBE elevation data (public domain) with the
  // global-land-mask package; that data counts the Caspian Sea as land, so it was cut out by hand.
  var LAND = { cols: 157, rows: 61, lon: 34, lat: 44, step: 0.6, bits: "AH/+D/////////////////////gB//A/////////////////////wAP/gP////////////////////4AD/4D/////////////////////wB/+A//////////////////////L//gf////////////////////////wP//////////////////j/////4D//////////////////H/v///8B/////////////////9AB3///+Af////////////////+AB////+AP/////////////////wA/////gH/////////////////54D////+P//////////////////4Dh///////////////////////wAx///////////////////////gAcf//////////////////////wAcP//////////////////////8AAP///////////////////////AAH///////////////////////gAH///////////////////////wAD///////////////////////2AD///////////////////////+AD////////////////////////AB////f///////////////////gA////D///////////////////4Af///g///////////////////8AL///4f//////////////////+AA///8D//////////////////8AAP///A//////////////////+ABH///wEP////////////////8AAh///5AX////////////////+AAYf///gYP/v/////////////+AAMP///QcAAD//////////////GCHD///4/AAB//////////////DADg/////8AAf/////////////DABwf////+AAD////////////+BgA+H/////wAA//////f/////wAAAfD/////wAA+////kP/////gAAAPx/////wAAPf///gH///+EAAAAH4f////wAAAP///wB///+CAAAAD8H////wAAAH///wAf//+BgAAAB+B////4AAAD///gAH//+DgAAAA/Af///4AAAB///gAB///BwAAAAf4P///4AAAA///gAA///wQAAOAP+D///wAAAAP//gAAf//4AAAOAH/A///gAAAAH//AAAPf/+AAADgD/gf/+AAAAAD//AAAHP//gAADwB/8P//AAAAAA/+AAABD//8AABgA/+H/+AAAAAAf+AAAAB//+AAAwAf/j/4AAAAAAH/AAAAA///gAAcAP/4/wAAAAAAD/gAAAAf//wAAGwH/+eAAAAAAAB/4AAAAHf/4AACID//+AAAAAAAAf8AAAgDP/8AABCB//4AAAAAAAAP8AAAQBx/+AAAiw//4ACAAAAAAD+AAAAAwf/AAAGIf//B/AAAAAAB/AAAAAYD+AAADYP////gAAAAAAfgAAAAIA+AAAgAH////wAAAAAAPoAAAAEAMAAAgcD////wAAAAAAHmAAAgCAEAAAgAR////4AAAAAABjAAAABgEAAAgCY////4AAAAAAABwAAAAYAAAAAD+AA==" };
  // Where 1688's suppliers are; the store's warehouse; and customers round it (points, not places).
  var HUBS = [["ییوو", 29.31, 120.08], ["گوانگجو", 23.13, 113.26], ["ووهان", 30.59, 114.3], ["چوانجو", 24.87, 118.68], ["چنگدو", 30.66, 104.07]];
  var DUBAI = [25.2, 55.27];
  var HOMES = [[23.8, 52.6], [22.3, 55.2], [23.0, 57.8], [21.2, 53.4], [24.6, 50.8], [20.8, 56.9]];
  var WSTEPS = [["factory", "کارخونه‌های چین", "کارخونه"], ["hunt", "شکار: فقط سودآورها", "شکار"],
    ["plane", "حمل تا انبار راینومال در دبی", "انبار دبی"], ["home", "دست مشتری", "مشتری"]];
  var world = { raf: 0, io: null, ro: null, onResize: null };

  function worldHTML() {
    return '<section class="lp-world" id="world" aria-label="مسیر جنس: از کارخونه‌های چین، از زیر ذره‌بین شکارچی، تا انبار راینومال در دبی و دست مشتری">' +
      '<canvas aria-hidden="true"></canvas><div class="w-labels" id="w-labels" aria-hidden="true"></div>' +
      '<div class="w-head"><span class="lp-eyebrow fa">مسیر جنس</span><b><span class="long">از کارخونه‌های چین، از زیر ذره‌بین ما، تا دست مشتری</span>' +
        '<span class="short">از کارخونه‌های چین تا دست مشتری</span></b></div>' +
      '<div class="w-count" aria-hidden="true"><span>بررسی‌شده <b id="w-seen">0</b></span><span class="g">شکار <b id="w-hit">0</b></span>' +
        '<span class="y">رسیده به مشتری <b id="w-done">0</b></span></div>' +
      '<ol class="w-steps">' + WSTEPS.map(function (s, n) {
        return '<li data-w="' + n + '">' + ic(s[0]) + '<span class="long">' + s[1] + '</span><span class="short">' + s[2] + "</span></li>";
      }).join("") + "</ol>" +
    "</section>";
  }

  // The map is a plane bent like the Earth's surface and seen at a slant; everything on it is placed
  // by at(). The hunter flies from city to city, scans what their factories make, takes the
  // profitable ones and drops the rest; what it takes flies to Dubai and then on to customers.
  function bindWorld() {
    stopWorld();
    var box = $("world");
    if (!box) return;
    var cv = box.querySelector("canvas"), ctx = cv.getContext && cv.getContext("2d");
    if (!ctx || !window.atob) return;
    var labels = $("w-labels"), steps = box.querySelectorAll(".w-steps li");
    var TW = 60 * Math.PI / 180, sn = Math.sin(TW), cs = Math.cos(TW), ALT = 0.13;
    var geo = {}, map = null, t = 0, last = 0, moving = false;
    var goods = [], cargo = [], parcels = [], sparks = [], count = { seen: 0, hit: 0, done: 0 }, flashes = {};
    var raw = atob(LAND.bits), land = [];
    for (var i = 0; i < raw.length; i++) land.push(raw.charCodeAt(i));
    function isLand(n) { return (land[n >> 3] >> (7 - (n & 7))) & 1; }
    var logo = new Image();
    logo.onload = function () { if (!moving) draw(); };
    logo.src = "/static/brand/logo-192.png";
    function place(lat, lon) { return { u: (lon - 81) / 47, v: (26 - lat) / 47 }; }
    var cities = HUBS.map(function (c) { var p = place(c[1], c[2]); p.name = c[0]; return p; });
    var dubai = place(DUBAI[0], DUBAI[1]), homes = HOMES.map(function (h) { return place(h[0], h[1]); });
    var tour = { city: 0, phase: "fly", at: -1600, from: { u: 0.35, v: -0.2 }, load: 0 };

    function at(u, v, h) {
      var d = u * u * 0.8 + (v - 0.12) * (v - 0.12) * 1.8;
      h = (h || 0) - 0.12 * d;  // the Earth curving away from the middle
      var R = geo.R, z = (v * sn + h * cs) * R, s = geo.P / (geo.P - z);
      return { x: geo.cx + u * R * s, y: geo.cy + (v * cs - h * sn) * R * s, s: s };
    }
    function arcAt(a, b, f, lift) { return at(a.u + (b.u - a.u) * f, a.v + (b.v - a.v) * f, Math.sin(Math.PI * f) * lift); }
    function ring(p, r, h, n) {
      ctx.beginPath();
      for (var k = 0; k <= n; k++) {
        var a = k / n * TAU, q = at(p.u + Math.sin(a) * r, p.v - Math.cos(a) * r * 0.9, h || 0);
        k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
    }
    function light(p, r, c, a) {
      if (a <= 0.01) return;
      var was = ctx.globalAlpha;
      ctx.globalAlpha = was * Math.min(1, a);
      ctx.drawImage(glowSprite(c), p.x - r, p.y - r, r * 2, r * 2);
      ctx.globalAlpha = was;
    }
    // A crate in screen space, standing on p: three faces, packing tape, or only its edges while unjudged.
    function crate(p, z, c, a, wire) {
      var x = p.x, y = p.y, w = z, h = z * 0.78, q = w / 4;
      var A = [x, y], L = [x - w / 2, y - q], Rr = [x + w / 2, y - q];
      var A2 = [x, y - h], L2 = [x - w / 2, y - q - h], R2 = [x + w / 2, y - q - h], B2 = [x, y - 2 * q - h];
      function face(pts, fill) {
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
        ctx.closePath();
        if (wire) { ctx.fillStyle = "rgba(235,235,235,.07)"; ctx.fill(); ctx.strokeStyle = rgba(WHITE, 0.85); ctx.lineWidth = 1; ctx.stroke(); }
        else { ctx.fillStyle = rgba(fill, 1); ctx.fill(); ctx.strokeStyle = "rgba(60,42,0,.5)"; ctx.lineWidth = 0.8; ctx.stroke(); }
      }
      ctx.globalAlpha = a;
      face([A, L, L2, A2], shade(c, 0.78));
      face([A, Rr, R2, A2], shade(c, 0.56));
      face([A2, L2, B2, R2], shade(c, 1.08));
      if (!wire) {
        ctx.beginPath(); ctx.moveTo((A2[0] + L2[0]) / 2, (A2[1] + L2[1]) / 2); ctx.lineTo((B2[0] + R2[0]) / 2, (B2[1] + R2[1]) / 2);
        ctx.strokeStyle = "rgba(70,48,0,.6)"; ctx.lineWidth = Math.max(1, w * 0.12); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // The map from the Red Sea's east to the Yellow Sea, as wide as the page allows; the strip is as
    // tall as the map, the hunter's flight over it, and the title and steps round it need.
    function measure() {
      var w = box.clientWidth, dpr = Math.min(2, window.devicePixelRatio || 1), span = Math.min(w, 1320);
      var head = w < 620 ? 56 : 52, foot = w < 620 ? 48 : 56, most = w < 620 ? 250 : 330, h;
      geo = { R: span / 1.66, dpr: dpr, w: w, cy: 0 };
      for (var n = 0; n < 30; n++, geo.R *= 0.96) {  // as wide as the page, unless that makes the strip too tall
        geo.P = geo.R * 3.2;
        geo.cx = w / 2 - 0.12 * geo.R;
        geo.k = Math.max(0.62, Math.min(1.1, geo.R / 700));
        geo.cy = 0;
        var top = Math.min(at(0, -0.4, 0).y, Math.min.apply(null, cities.map(function (c) { return at(c.u, c.v, ALT + 0.05).y; })) - 30 * geo.k);
        h = Math.round(head + at(0, 0.3, 0).y - top + foot);
        geo.cy = head - top;
        if (h <= most) break;
      }
      box.style.height = h + "px";
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      paintMap(w, h);
      var marks = cities.map(function (c, n) { return ['<span class="w-city" data-c="' + n + '">' + c.name + "</span>", at(c.u, c.v, 0), 7]; })
        .concat([['<span class="w-hub">انبار راینومال · دبی</span>', at(dubai.u, dubai.v, 0), -44],
          ['<span class="w-homes">مشتری‌ها</span>', at(homes[3].u, homes[3].v, 0), 8]]);
      labels.innerHTML = marks.map(function (m) { return m[0]; }).join("");
      Array.prototype.forEach.call(labels.children, function (el, n) {  // centred under its place, but inside the strip
        var m = marks[n], half = el.offsetWidth / 2, x = Math.max(half + 8, Math.min(w - half - 8, m[1].x));
        el.style.transform = "translate(" + (x - half).toFixed(1) + "px," + (m[1].y + m[2] * geo.k).toFixed(1) + "px)";
      });
      markCity();
    }
    function markCity() {
      Array.prototype.forEach.call(labels.querySelectorAll(".w-city"), function (el) { el.classList.toggle("on", Number(el.dataset.c) === tour.city); });
    }
    function paintMap(w, h) {  // the still part, drawn once per size
      map = document.createElement("canvas");
      map.width = cv.width; map.height = cv.height;
      var m = map.getContext("2d"), lat, lon, k, p;
      m.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
      // the air over the horizon
      var sky = m.createLinearGradient(0, at(0, -0.44, 0).y - 40, 0, at(0, -0.4, 0).y + 10);
      sky.addColorStop(0, "rgba(250,197,7,0)"); sky.addColorStop(1, "rgba(250,197,7,.07)");
      m.fillStyle = sky; m.fillRect(0, 0, w, h);
      for (k = 0; k < 90; k++) {  // stars over the horizon
        var sx = Math.random() * w, sy = Math.random() * (at(0, -0.4, 0).y - 4);
        m.fillStyle = "rgba(255,255,255," + (0.08 + Math.random() * 0.3).toFixed(2) + ")";
        m.fillRect(sx, sy, Math.random() < 0.15 ? 2 : 1, Math.random() < 0.15 ? 2 : 1);
      }
      m.globalCompositeOperation = "lighter";
      [[10, 0.05], [4, 0.1], [1.5, 0.45]].forEach(function (g) {
        m.beginPath();
        for (k = 0; k <= 60; k++) { p = at(-1.3 + k / 60 * 2.6, -0.4, 0); k ? m.lineTo(p.x, p.y) : m.moveTo(p.x, p.y); }
        m.strokeStyle = rgba(YELLOW, g[1]); m.lineWidth = g[0]; m.stroke();
      });
      m.globalCompositeOperation = "source-over";
      // lines of latitude and longitude
      m.strokeStyle = rgba(YELLOW, 0.08); m.lineWidth = 1;
      for (lat = 10; lat <= 40; lat += 10) {
        m.beginPath();
        for (lon = 30; lon <= 132; lon += 2) { var q = place(lat, lon); p = at(q.u, q.v, 0); lon > 30 ? m.lineTo(p.x, p.y) : m.moveTo(p.x, p.y); }
        m.stroke();
      }
      for (lon = 40; lon <= 130; lon += 10) {
        m.beginPath();
        for (lat = 10; lat <= 44; lat += 2) { var q2 = place(lat, lon); p = at(q2.u, q2.v, 0); lat > 10 ? m.lineTo(p.x, p.y) : m.moveTo(p.x, p.y); }
        m.stroke();
      }
      // the land, brighter round the places on the route
      var hot = cities.concat([dubai]);
      for (var r = 0; r < LAND.rows; r++) {
        for (var c = 0; c < LAND.cols; c++) {
          var n = r * LAND.cols + c;
          if (!isLand(n)) continue;
          var pl = place(LAND.lat - r * LAND.step, LAND.lon + c * LAND.step);
          p = at(pl.u, pl.v, 0);
          var near = 0, coast = c > 0 && c < LAND.cols - 1 && r > 0 && r < LAND.rows - 1 &&
            (!isLand(n - 1) || !isLand(n + 1) || !isLand(n - LAND.cols) || !isLand(n + LAND.cols));
          hot.forEach(function (o) { near = Math.max(near, Math.exp(-(Math.pow(o.u - pl.u, 2) + Math.pow(o.v - pl.v, 2)) / 0.004)); });
          var fade = clamp01((pl.v + 0.4) / 0.12), size = Math.max(1, (coast ? 2.6 : 2) * p.s * geo.k);
          m.fillStyle = rgba(mix(coast ? [255, 226, 140] : WHITE, YELLOW, near), ((coast ? 0.55 : 0.2) + 0.4 * near) * fade);
          m.fillRect(p.x - size / 2, p.y - size / 2, size, size);
        }
      }
    }

    function spawnGoods(city) {
      var n = 4, picks = {}, k;
      picks[Math.floor(Math.random() * n)] = true;
      if (Math.random() < 0.45) picks[Math.floor(Math.random() * n)] = true;
      for (k = 0; k < n; k++) {
        var a = (k / n) * TAU + 0.4;
        goods.push({ city: city, u: city.u + Math.sin(a) * 0.035, v: city.v - Math.cos(a) * 0.03, born: t + k * 140,
          judge: t + 800 + k * 650, pick: !!picks[k], state: "raw" });
      }
    }
    function burst(p, h, c, n) {
      for (var k = 0; k < n; k++) {
        sparks.push({ u: p.u, v: p.v, h: h, du: (Math.random() - 0.5) * 0.00012, dv: (Math.random() - 0.5) * 0.0001,
          dh: 0.00005 + Math.random() * 0.00015, life: 500 + Math.random() * 600, max: 1100, c: c });
      }
    }
    function scannerAt() {
      var city = cities[tour.city];
      if (tour.phase === "fly") {
        var f = clamp01((t - tour.at) / 1600), e = f * f * (3 - 2 * f);
        return { u: tour.from.u + (city.u - tour.from.u) * e, v: tour.from.v + (city.v - tour.from.v) * e, h: ALT + Math.sin(Math.PI * f) * 0.05 };
      }
      return { u: city.u, v: city.v, h: ALT + Math.sin(t / 420) * 0.008 };
    }
    function step(dt) {
      t += dt;
      var city = cities[tour.city];
      if (tour.phase === "fly" && t - tour.at >= 1600) { tour.phase = "scan"; tour.at = t; tour.load = 0; spawnGoods(city); }
      if (tour.phase === "scan" && t - tour.at >= 3700) {
        if (tour.load) cargo.push({ from: city, at: t, n: tour.load });
        tour.from = { u: city.u, v: city.v };
        tour.city = (tour.city + 1) % cities.length;
        tour.phase = "fly"; tour.at = t;
        markCity();
      }
      goods.forEach(function (g) {
        if (g.state === "raw" && t >= g.judge) {
          count.seen++;
          if (g.pick) { g.state = "pick"; g.at = t; burst(g, 0.02, YELLOW, 10); }
          else { g.state = "drop"; g.at = t; burst(g, 0.02, RED, 14); }
          setCount();
        }
        if (g.state === "pick" && t - g.at > 700) { g.state = "gone"; count.hit++; tour.load++; setCount(); }
        if (g.state === "drop" && t - g.at > 500) g.state = "gone";
      });
      goods = goods.filter(function (g) { return g.state !== "gone"; });
      cargo = cargo.filter(function (c) {
        if (t - c.at < 2600) return true;
        flashes.dubai = t;
        burst(dubai, 0.03, YELLOW, 16);
        for (var k = 0; k < c.n; k++) parcels.push({ home: Math.floor(Math.random() * homes.length), at: t + k * 260 });
        return false;
      });
      parcels = parcels.filter(function (p) {
        if (t - p.at < 900) return true;
        count.done++; flashes[p.home] = t; burst(homes[p.home], 0.01, GREEN, 8); setCount();
        return false;
      });
      sparks = sparks.filter(function (s) {
        s.life -= dt; s.u += s.du * dt; s.v += s.dv * dt; s.h = Math.max(0, s.h + s.dh * dt); s.dh -= 0.0000003 * dt;
        return s.life > 0;
      });
      var on = [goods.some(function (g) { return g.state === "raw" && t >= g.born; }), tour.phase === "scan" && goods.length > 0, cargo.length > 0, parcels.length > 0];
      Array.prototype.forEach.call(steps, function (li, n) { if (li.classList.contains("on") !== on[n]) li.classList.toggle("on", on[n]); });
    }
    function setCount() { $("w-seen").textContent = count.seen; $("w-hit").textContent = count.hit; $("w-done").textContent = count.done; }

    function draw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(map, 0, 0);
      ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
      var k, p, q;
      // the routes to Dubai, flowing
      ctx.setLineDash([4, 6]); ctx.lineDashOffset = -t * 0.02;
      cities.forEach(function (c) {
        ctx.beginPath();
        for (k = 0; k <= 40; k++) { p = arcAt(c, dubai, k / 40, 0.08); k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
        ctx.strokeStyle = rgba(YELLOW, 0.22); ctx.lineWidth = 1.2; ctx.stroke();
      });
      ctx.setLineDash([]);
      // Dubai: the warehouse
      var fd = clamp01(1 - (t - (flashes.dubai || -1e9)) / 700), dp = at(dubai.u, dubai.v, 0);
      ctx.globalCompositeOperation = "lighter";
      light(dp, (34 + 20 * fd) * geo.k, YELLOW, 0.55 + 0.4 * fd);
      ctx.globalCompositeOperation = "source-over";
      ring(dubai, 0.026, 0, 36); ctx.strokeStyle = rgba(YELLOW, 0.9); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.setLineDash([3, 4]); ctx.lineDashOffset = t * 0.02;
      ring(dubai, 0.042 + 0.01 * fd, 0, 48); ctx.strokeStyle = rgba(YELLOW, 0.55); ctx.stroke();
      ctx.setLineDash([]);
      crate(dp, 16 * geo.k * dp.s, YELLOW, 1, false);
      // customers: small houses, green when a parcel arrives
      homes.forEach(function (hm, n) {
        var f = clamp01(1 - (t - (flashes[n] || -1e9)) / 900);
        p = at(hm.u, hm.v, 0);
        var z = 6 * geo.k * p.s, col = mix([200, 200, 200], GREEN, f);
        ctx.fillStyle = rgba(col, 0.9);
        ctx.beginPath(); ctx.moveTo(p.x - z, p.y - z); ctx.lineTo(p.x, p.y - z * 1.9); ctx.lineTo(p.x + z, p.y - z); ctx.closePath(); ctx.fill();
        ctx.fillRect(p.x - z * 0.7, p.y - z, z * 1.4, z);
        if (f > 0) { ctx.globalCompositeOperation = "lighter"; light(p, 18 * geo.k * f + 6, GREEN, f); ctx.globalCompositeOperation = "source-over"; }
      });
      // the cities
      cities.forEach(function (c, n) {
        p = at(c.u, c.v, 0);
        var ph = (t / 1800 + n * 0.23) % 1;
        ring(c, 0.012 + 0.03 * ph, 0, 28); ctx.strokeStyle = rgba(YELLOW, 0.6 * (1 - ph)); ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = rgba(YELLOW, 1); ctx.beginPath(); ctx.arc(p.x, p.y, 3 * geo.k + 0.5, 0, TAU); ctx.fill();
      });
      // the hunter over its city: a cone of light and the ring it scans
      var sc = scannerAt(), top = at(sc.u, sc.v, sc.h), base = at(sc.u, sc.v, 0);
      if (tour.phase === "scan") {
        var cone = ctx.createLinearGradient(0, top.y, 0, base.y);
        cone.addColorStop(0, rgba(YELLOW, 0.45)); cone.addColorStop(1, rgba(YELLOW, 0.06));
        var spread = 0.05;
        ctx.globalCompositeOperation = "lighter";
        ctx.beginPath(); ctx.moveTo(top.x, top.y + 10 * geo.k);
        for (k = 0; k <= 24; k++) { var a = Math.PI / 2 + k / 24 * Math.PI; q = at(sc.u + Math.sin(a) * spread, sc.v - Math.cos(a) * spread * 0.9, 0); ctx.lineTo(q.x, q.y); }
        ctx.closePath(); ctx.fillStyle = cone; ctx.fill();
        ring(sc, spread, 0, 40); ctx.strokeStyle = rgba(YELLOW, 0.8); ctx.lineWidth = 1.2; ctx.stroke();
        var sw = (t / 900) % 1;
        ring(sc, spread * sw, 0, 32); ctx.strokeStyle = rgba(YELLOW, 0.7 * (1 - sw)); ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
      } else {  // its shadow while it flies
        ring(sc, 0.02, 0, 20); ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fill();
      }
      // the goods under it: unjudged ones are wireframes; the taken rise into it, the rest turn red and go
      goods.forEach(function (g) {
        if (t < g.born) return;
        var pop = clamp01((t - g.born) / 250), z = 10 * geo.k;
        if (g.state === "raw") { p = at(g.u, g.v, 0); crate(p, z * pop * p.s, WHITE, 0.95, true); }
        else if (g.state === "pick") {
          var f = clamp01((t - g.at) / 700);
          p = at(g.u + (sc.u - g.u) * f, g.v + (sc.v - g.v) * f, sc.h * f);
          crate(p, z * p.s * (1 - 0.5 * f), YELLOW, 1, false);
        } else {
          var fr = clamp01((t - g.at) / 500);
          p = at(g.u, g.v, 0);
          crate(p, z * p.s, RED, 1 - fr, false);
        }
      });
      // cargo on its way to Dubai, with a trail
      cargo.forEach(function (c) {
        var f = clamp01((t - c.at) / 2600), e = f * f * (3 - 2 * f);
        ctx.globalCompositeOperation = "lighter";
        ctx.beginPath();
        for (k = 0; k <= 16; k++) { q = arcAt(c.from, dubai, Math.max(0, e - 0.18 + 0.18 * k / 16), 0.08); k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }
        ctx.strokeStyle = rgba(YELLOW, 0.85); ctx.lineWidth = 2.2; ctx.stroke();
        p = arcAt(c.from, dubai, e, 0.08);
        light(p, 16 * geo.k, YELLOW, 0.9);
        ctx.globalCompositeOperation = "source-over";
        crate({ x: p.x, y: p.y + 5 * geo.k }, 11 * geo.k * p.s, YELLOW, 1, false);
      });
      // parcels out to customers
      parcels.forEach(function (pc) {
        if (t < pc.at) return;
        var f = clamp01((t - pc.at) / 900);
        p = arcAt(dubai, homes[pc.home], f, 0.03);
        crate(p, 7 * geo.k * p.s, YELLOW, 1, false);
      });
      // the hunter itself
      var size = 46 * geo.k * top.s;
      ctx.globalCompositeOperation = "lighter";
      light(top, size * 0.9, YELLOW, 0.5);
      sparks.forEach(function (s) { light(at(s.u, s.v, s.h), 4 * geo.k + 1, s.c, s.life / s.max * 1.3); });
      ctx.globalCompositeOperation = "source-over";
      if (logo.complete && logo.naturalWidth) ctx.drawImage(logo, top.x - size / 2, top.y - size / 2, size, size);
    }

    measure();
    for (var warm = 0; warm < 260; warm++) step(25);  // start with the route already busy
    draw();
    world.onResize = function () { if (box.clientWidth !== geo.w) { measure(); draw(); } };
    if (window.ResizeObserver) { world.ro = new ResizeObserver(world.onResize); world.ro.observe(box); }
    else window.addEventListener("resize", world.onResize);
    if (!motionOK() || !window.requestAnimationFrame) return;
    function frame(now) {
      var dt = last ? Math.min(50, now - last) : 16;
      last = now;
      step(dt); draw();
      world.raf = requestAnimationFrame(frame);
    }
    function run(on) {
      cancelAnimationFrame(world.raf); world.raf = 0; last = 0; moving = on;
      if (on) world.raf = requestAnimationFrame(frame);
    }
    if (window.IntersectionObserver) {
      world.io = new IntersectionObserver(function (entries) { run(entries[entries.length - 1].isIntersecting); }, { threshold: 0.05 });
      world.io.observe(box);
    } else run(true);
  }
  function stopWorld() {
    cancelAnimationFrame(world.raf); world.raf = 0;
    if (world.io) { world.io.disconnect(); world.io = null; }
    if (world.ro) { world.ro.disconnect(); world.ro = null; }
    if (world.onResize) { window.removeEventListener("resize", world.onResize); world.onResize = null; }
  }

  function stepHTML(n) {
    var e = EXAMPLE, o = e.offer, r = example(), share = sharePct();
    var copy, visual;
    if (n === 0) {
      copy = ["پرفروش رو پیدا کن", "هر روز پرفروش‌های Temu و آمازون بررسی میشن. این یکی ماهی حدود " +
        toman(e.amazon.sold) + " فروش در آمازون داره و سبکه؛ یعنی حمل ارزون."];
      visual = '<div class="ex-box ex-listing"><div class="ex-img">' + ic("box") + '<span class="ex-badge">Temu</span></div><div>' +
        '<p class="ex-en" dir="ltr">' + esc(e.temu.title) + '</p><p class="ex-fa">' + esc(e.title_fa) + "</p>" +
        '<div class="ex-cells"><div><span>Temu</span><b>' + usd(e.temu.price) + "</b></div>" +
        "<div><span>آمازون</span><b>" + usd(e.amazon.price) + "</b><small>~" + count(e.amazon.sold) + " فروش در ماه</small></div></div></div></div>";
    } else if (n === 1) {
      copy = ["همون جنس، از منبع", "با جستجوی تصویری، همین محصول در 1688 پیدا میشه: تأمین‌کننده، سابقه، امتیاز و قیمت پلکانی؛ همه به فارسی."];
      var facts = ["کارخانه", o.location, toman(o.years) + " سال در 1688", "امتیاز " + o.rating, "خرید مجدد " + pct(o.repurchase), "حداقل سفارش " + toman(o.moq)];
      visual = '<div class="ex-box"><div class="ex-shop">' + ic("factory") + "<span>" + esc(o.shop) + "</span></div>" +
        '<p class="ex-zh" lang="zh">' + esc(o.title) + "</p>" +
        '<div class="ex-facts">' + facts.map(function (f) { return "<bdi>" + esc(f) + "</bdi>"; }).join("") + "</div>" +
        '<div class="ex-cells">' + o.tiers.map(function (t) {
          return "<div><span>از " + toman(t[0]) + " عدد</span><b>¥" + t[1].toFixed(2) + "</b></div>";
        }).join("") + "</div></div>";
    } else if (n === 2) {
      copy = ["همه‌ی هزینه‌ها، شفاف", r ? "تو فقط تا انبار دبی خرج می‌کنی. ارسال، بسته‌بندی، انبار و تبلیغات از سهم " +
        share + "% راینومال پرداخت میشه. این محصول تا دبی " + ltr(usd(r.landed_usd)) + " تموم میشه." : ERRORS.unprofitable_settings];
      var rows = r ? [
        ["خرید از کارخونه (" + toman(e.units) + " عدد)", r.factory_usd], ["ایجنت و حمل داخل چین", r.china_side_usd],
        ["حمل تا انبار دبی", r.freight_usd], ["سهم راینومال (" + toman(share) + "% از قیمت)", r.platform_fee_usd, "share"],
      ] : [];
      if (r && r.packaging_usd) rows.splice(3, 0, ["بسته‌بندی", r.packaging_usd]);
      var max = Math.max.apply(null, rows.map(function (x) { return x[1]; }).concat([0.01]));
      visual = '<div class="ex-box ex-costs">' + rows.map(function (x) {
        return '<div class="ex-row"><span>' + x[0] + '</span><i><s class="' + (x[2] || "") + '" style="width:' + Math.max(2, Math.round(x[1] / max * 100)) + '%"></s></i><b>' + usd(x[1]) + "</b></div>";
      }).join("") + (r ? '<div class="ex-row total"><span>تمام‌شده تا انبار دبی</span><b>' + usd(r.landed_usd) + "</b></div>" : "") + "</div>";
    } else {
      copy = ["قیمت آماده، سود روشن", "قیمتی کمی زیر Temu که بعد از سهم راینومال هم سودت رو نگه می‌داره؛ با حکم سبز، زرد یا قرمز و دلیلش."];
      visual = r ? '<div class="ex-box ex-verdict"><span class="pill ' + r.verdict + '"><span class="dot"></span>' + VERDICT[r.verdict] + "</span>" +
        '<div class="ex-big">' + usd(r.price_usd) + "</div><p>قیمت فروش پیشنهادی در راینومال</p>" +
        '<div class="ex-cells"><div><span>Temu</span><b>' + usd(e.temu.price) + "</b><small>" + ltr(signed(r.vs_benchmark)) + "</small></div>" +
          "<div><span>سود هر عدد</span><b class=\"y\">" + usd(r.profit_usd) + "</b><small>بعد از سهم راینومال</small></div>" +
          "<div><span>بازده سرمایه</span><b>" + pct(r.roi) + "</b><small>حاشیه " + ltr(pct(r.margin)) + "</small></div></div></div>" : "";
    }
    return '<div class="ex-copy"><span class="ex-n" dir="ltr">STEP 0' + (n + 1) + " / 0" + STEPS.length + "</span><h3>" + copy[0] + "</h3><p>" + copy[1] + "</p>" +
      (n === STEPS.length - 1
        ? '<button type="button" class="btn" data-go="signup">شکارهای امروزت رو ببین' + ic("back") + "</button>"
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
      head("ماشین‌حساب زنده", "قبل از خرید، <em>سودت رو ببین.</em>", "سه عدد رو تغییر بده؛ قیمت فروش و سودت همون لحظه حساب میشه.") +
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
      '<button type="button" class="btn ghost" data-open-calc>حساب‌وکتاب کامل در ماشین‌حساب' + ic("calc") + "</button>";
  }

  // What each tool does for the seller: the feature's name, then the benefit.
  var TOOL_LIST = [
    ["hunt", "شکار روزانه", "هر صبح، پرفروش‌های تازه", "دیگه لازم نیست ساعت‌ها بگردی؛ هر روز فهرست تازه با حکم سبز، زرد یا قرمز منتظرته."],
    ["analyze", "تحلیل لینک", "هر لینکی، یه جواب روشن", "لینک Temu یا آمازون رو بده؛ تأمین‌کننده، هزینه‌ها و قیمت فروش رو تحویل بگیر."],
    ["media", "عکس و ویدیو", "آگهی آماده، بی‌دردسر", "عکس و ویدیوی هر محصول، اصلی یا مربعی آماده‌ی آگهی؛ از داخل ایران هم دانلود میشه."],
    ["calc", "ماشین‌حساب واردات", "سود خالص، قبل از خرید", "با فرمول قرارداد راینومال ببین چقدر برات می‌مونه و پولت کی برمی‌گرده."],
    ["world", "1688 به فارسی", "1688، بدون چینی و بدون حساب", "عکس، مشخصات، مدل‌ها و قیمت پلکانی تأمین‌کننده، همه به فارسی."],
    ["factory", "بدون واسطه‌گر", "کارخونه، نه دلال", "تأمین‌کننده‌ها با سابقه و امتیاز رتبه می‌گیرن و کارخونه‌ها جلوترن؛ از منبع بخر."],
  ];
  function toolsHTML() {
    return '<section class="lp-sec" id="tools"><div class="lp-in">' +
      head("ابزارها", "هر چی برای فروش لازم داری، <em>یه جا.</em>", "بعد از ثبت‌نام، همه روی میز کارت منتظرن.") +
      '<div class="lp-tools">' + TOOL_LIST.map(function (t) {
        return '<article class="glass bk tool-card">' + (t[0] === "media" ? '<span class="new">جدید</span>' : "") +
          '<span class="ib">' + ic(t[0]) + '</span><span class="kind">' + t[1] + "</span><h3>" + t[2] + "</h3><p>" + t[3] + "</p></article>";
      }).join("") + "</div></div></section>";
  }

  // Who each plan is for; the names and prices come from the server.
  var PLAN_FOR = { basic: "برای شروع کار", pro: "برای فروشنده‌ی جدی", business: "برای فروش پرحجم" };
  function plansHTML(buying) {
    var cfg = state.config, current = currentPlan();
    var tick = function (t) { return "<li>" + ic("check") + "<span>" + t + "</span></li>"; };
    // Signing up is free: the calculator, the workspace and a taste of the day's hunt.
    var free = buying ? "" : '<div class="plan">' +
      '<div class="label">رایگان</div><div class="for">برای آشنایی</div>' +
      '<div class="price"><b dir="ltr">$0</b> <small>رایگان</small></div>' +
      "<ul>" + tick("ماشین‌حساب کامل با قوانین قرارداد") + tick("میز کار و دموی زنده") + tick("نمونه‌ی شکارهای امروز") + "</ul>" +
      '<button type="button" class="btn ghost block" data-go="signup">رایگان شروع کن' + ic("back") + "</button></div>";
    return free + (cfg.plans || []).map(function (p, n) {
      var mine = current && current.id === p.id, best = !buying && n === 1;
      var button = buying
        ? '<button type="button" class="btn block" data-plan="' + esc(p.id) + '"' + (cfg.online_payment ? "" : " disabled") + ">" + (mine ? "تمدید" : "خرید") + " با درگاه" + ic("coin") + "</button>"
        : '<button type="button" class="btn ' + (best ? "" : "ghost ") + 'block" data-go="signup">همین رو می‌خوام' + ic("back") + "</button>";
      return '<div class="plan' + (mine ? " current" : best ? " best" : "") + '">' +
        '<div class="label">' + esc(p.name_fa) + (mine ? ' <span class="pill blue">پلن فعلی</span>' : best ? ' <span class="pill blue">پیشنهاد ما</span>' : "") + "</div>" +
        (PLAN_FOR[p.id] ? '<div class="for">' + PLAN_FOR[p.id] + "</div>" : "") +
        '<div class="price"><b dir="ltr">' + usd(p.price_usd) + "</b> <small>در ماه</small></div>" +
        '<div class="price-fa">حدود ' + toman(p.price_toman) + " تومان</div>" +
        "<ul>" + tick(toman(p.links) + " تحلیل لینک در ماه") + tick("شکار روزانه و شکارهای اختصاصی") +
          tick("عکس و ویدیوی آماده‌ی آگهی") + tick("تأمین‌کننده‌ی 1688 به فارسی") + "</ul>" + button + "</div>";
    }).join("");
  }

  function authHTML() {
    var signup = state.authMode === "signup";
    return '<div class="auth-tabs" role="group" aria-label="ثبت‌نام یا ورود"><button type="button" data-mode="signup" aria-pressed="' + signup + '">ثبت‌نام</button>' +
      '<button type="button" data-mode="login" aria-pressed="' + !signup + '">ورود</button></div>' +
      '<form id="auth-form" novalidate>' +
        (signup ? field("name", "نام و نام خانوادگی", "text", "name") + field("phone", "موبایل (برای رسید پرداخت)", "tel", "tel") : "") +
        field("email", "ایمیل", "email", "email") +
        field("password", "رمز عبور" + (signup ? " (حداقل 8 حرف)" : ""), "password", signup ? "new-password" : "current-password") +
        (DEMO ? '<p class="hint" style="margin:0">نسخه‌ی نمایشی: هر اسم، ایمیل و رمزی قبوله.</p>' : "") +
        '<div class="error" id="auth-error"></div>' +
        '<button class="btn block" type="submit">' + (signup ? "ساخت حساب رایگان" : "ورود به میز کار") + ic("back") + "</button>" +
      "</form>";
  }
  function field(id, label, type, ac) {
    return '<div class="field"><label for="f-' + id + '">' + label + '</label><input class="input" id="f-' + id + '" name="' + id + '" type="' + type + '" autocomplete="' + ac + '" dir="auto"></div>';
  }

  function bindLanding() {
    bindAuth();
    bindWorld();
    bindRadar();
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
        $("auth-error").textContent = e.code === "invalid" ? "همه‌ی خونه‌ها رو درست پر کن (رمز حداقل 8 حرف)." : errText(e);
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
      '<div class="notice info"><b>قرارداد راینومال:</b> فقط عکسی رو در آگهی بذار که واقعاً همون کالای انبارت رو نشون بده؛ اطلاعات غلط درباره‌ی محصول تخلفه (بند 11-2). هر ماه یه بار هم می‌تونی از راینومال عکس واضح کالای خودت در انبار رو بخوای (بند 3-4).</div>' +
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

  // --- catalog tab (the growing library of finds) --------------------------------

  function catKey() {
    var f = state.filter;
    return [f.cat, f.verdict, f.sort, f.fresh ? 1 : 0, (f.q || "")].join("|");
  }

  function catalogSummary(counts) {
    counts = counts || {};
    return '<div class="summary">' +
      '<span class="pill neutral">' + toman(counts.total || 0) + " محصول در کاتالوگ</span>" +
      '<span class="pill green"><span class="dot"></span>' + toman(counts.green || 0) + " شکار خوب</span>" +
      '<span class="pill yellow"><span class="dot"></span>' + toman(counts.yellow || 0) + " با احتیاط</span>" +
      '<span class="pill red"><span class="dot"></span>' + toman(counts.red || 0) + " نیار</span>" +
      (counts.new ? '<span class="pill new">' + toman(counts.new) + " جدید امروز</span>" : "") +
      "</div>";
  }

  function catalogFilters(cats) {
    var f = state.filter;
    var opts = (cats || []).map(function (k) {
      return '<option value="' + esc(k) + '"' + (f.cat === k ? " selected" : "") + ">" + esc(catName(k)) + "</option>";
    }).join("");
    return '<div class="filters">' +
      '<div class="field"><label for="flt-q">جستجو</label><input class="input" id="flt-q" placeholder="اسم محصول…" value="' + esc(f.q || "") + '"></div>' +
      '<div class="field"><label for="flt-cat">دسته</label><select class="input" id="flt-cat"><option value="all">همه‌ی دسته‌ها</option>' + opts + "</select></div>" +
      '<div class="field"><label for="flt-sort">مرتب‌سازی</label><select class="input" id="flt-sort">' +
        '<option value="new"' + (f.sort === "new" ? " selected" : "") + ">جدیدترین</option>" +
        '<option value="score"' + (f.sort === "score" ? " selected" : "") + ">بهترین‌ها</option>" +
        '<option value="profit"' + (f.sort === "profit" ? " selected" : "") + ">بیشترین سود</option>" +
        '<option value="capital"' + (f.sort === "capital" ? " selected" : "") + ">کمترین سرمایه</option></select></div>" +
      '<div class="field"><span class="label">وضعیت</span><div class="chips" id="flt-verdict">' +
        [["all", "همه"], ["green", "شکار خوب"], ["yellow", "با احتیاط"], ["red", "نیار"]].map(function (v) {
          return '<button type="button" data-v="' + v[0] + '" aria-pressed="' + (f.verdict === v[0]) + '">' + v[1] + "</button>";
        }).join("") + "</div></div>" +
      '<div class="field"><span class="label">فقط جدیدها</span><div class="chips"><button type="button" id="flt-new" aria-pressed="' + !!f.fresh + '">جدید امروز</button></div></div>' +
    "</div>";
  }

  function catalogHead(counts) {
    return '<div class="page-head"><div><span class="eyebrow">کتابخانه‌ی محصولات</span>' +
      '<h1 class="section-title">کاتالوگ شکارها</h1>' +
      '<p class="section-sub" style="margin:0">هر چیزی که تا حالا شکار شده این‌جا می‌مونه و هر روز بیشتر می‌شه. همه‌ی مشترک‌ها می‌بینن؛ «شکار من» مخصوص خودته.</p></div></div>' +
      catalogSummary(counts) + catalogFilters((counts && counts.categories) || []);
  }

  function drawCatalog(main, page) {
    var items = page.items || [], counts = page.counts || {};
    var body = items.length
      ? '<div class="grid">' + items.map(cardHTML).join("") + "</div>"
      : '<div class="empty">چیزی با این فیلتر پیدا نشد.</div>';
    var left = (page.total || 0) - items.length;
    var more = left > 0
      ? '<div class="more-row"><button type="button" class="btn ghost" id="cat-more">بیشتر (' + toman(left) + " تای دیگه)</button></div>" : "";
    main.innerHTML = catalogHead(counts) + body + more;
    bindCatalog(main);
    bindCards(main);
  }

  function renderCatalog() {
    var main = $("main");
    if (!DEMO && !state.me.active) { main.innerHTML = lockedHTML(); return; }
    if (DEMO) { drawCatalogDemo(main); return; }
    if (!state.catalog || state.catalog.key !== catKey()) {
      main.innerHTML = '<p class="loading">در حال باز کردن کاتالوگ…</p>';
      fetchCatalog(0, false);
      return;
    }
    drawCatalog(main, state.catalog);
  }

  function catalogQuery(offset) {
    var f = state.filter;
    return "/api/catalog?offset=" + offset + "&limit=24&sort=" + encodeURIComponent(f.sort) +
      "&category=" + encodeURIComponent(f.cat) + "&verdict=" + encodeURIComponent(f.verdict) +
      (f.fresh ? "&fresh=true" : "") + (f.q ? "&q=" + encodeURIComponent(f.q) : "");
  }

  function fetchCatalog(offset, append) {
    api(catalogQuery(offset)).then(function (p) {
      if (append && state.catalog) {
        state.catalog.items = state.catalog.items.concat(p.items || []);
        state.catalog.offset = p.offset;
      } else {
        state.catalog = { key: catKey(), items: p.items || [], total: p.total || 0, offset: p.offset || 0, limit: p.limit || 24, counts: p.counts || (state.catalog && state.catalog.counts) || {} };
      }
      if (state.tab === "hunt") drawCatalog($("main"), state.catalog);
    }, function (e) {
      if (state.tab === "hunt") $("main").innerHTML = '<div class="empty">' + esc(errText(e)) + "</div>";
    });
  }

  // The demo has the catalog inlined; filter, sort and page it in the browser.
  function drawCatalogDemo(main) {
    var all = (state.config && state.config.catalog) || [];
    var f = state.filter, ql = (f.q || "").toLowerCase();
    var list = all.filter(function (c) {
      return (f.cat === "all" || c.category === f.cat) &&
        (f.verdict === "all" || c.verdict === f.verdict) &&
        (!f.fresh || c.is_new) &&
        (!f.q || (c.title_fa || "").indexOf(f.q) >= 0 || (((c.listing && c.listing.title) || "").toLowerCase().indexOf(ql) >= 0));
    });
    var sorters = {
      new: function (a, b) { return b.score - a.score; },
      score: function (a, b) { return b.score - a.score; },
      profit: function (a, b) { return b.pricing.profit_usd - a.pricing.profit_usd; },
      capital: function (a, b) { return a.starter_capital_usd - b.starter_capital_usd; },
    };
    list = list.slice().sort(sorters[f.sort] || sorters.new);
    var shown = state.catDemoShown || 24;
    var counts = (state.config && state.config.catalog_counts) || demoCatalogCounts(all);
    drawCatalog(main, { items: list.slice(0, shown), total: list.length, counts: counts });
  }

  function demoCatalogCounts(all) {
    var c = { total: all.length, green: 0, yellow: 0, red: 0, new: 0 }, cats = {};
    all.forEach(function (x) { c[x.verdict] = (c[x.verdict] || 0) + 1; if (x.is_new) c.new++; cats[x.category] = true; });
    c.categories = Object.keys(cats);
    return c;
  }

  function bindCatalog(root) {
    var cat = $("flt-cat"), sort = $("flt-sort"), v = $("flt-verdict"), q = $("flt-q"), fresh = $("flt-new"), more = $("cat-more");
    function changed() { state.catDemoShown = 24; state.catalog = null; render(); }
    if (cat) cat.onchange = function () { state.filter.cat = cat.value; changed(); };
    if (sort) sort.onchange = function () { state.filter.sort = sort.value; changed(); };
    if (v) each(v, "button", function (b) { b.onclick = function () { state.filter.verdict = b.dataset.v; changed(); }; });
    if (fresh) fresh.onclick = function () { state.filter.fresh = !state.filter.fresh; changed(); };
    if (q) {
      var t;
      var apply = function () { state.filter.q = q.value.trim(); state.catKeepFocus = true; changed(); };
      q.oninput = function () { clearTimeout(t); t = setTimeout(apply, 350); };
      q.onkeydown = function (e) { if (e.key === "Enter") { clearTimeout(t); apply(); } };
      if (state.catKeepFocus) { q.focus(); try { var n = q.value.length; q.setSelectionRange(n, n); } catch (e) {} state.catKeepFocus = false; }
    }
    if (more) more.onclick = function () {
      if (DEMO) { state.catDemoShown = (state.catDemoShown || 24) + 24; drawCatalogDemo($("main")); return; }
      fetchCatalog((state.catalog ? state.catalog.offset : 0) + 24, true);
    };
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

  // --- order cart (سبد سفارش): ثبت درخواست و خروجی اکسل برای راینومال -----------

  function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }

  // Build the request body a card turns into when added to the cart.
  function cartItemFromCard(c) {
    var o = c.offer || {}, p = c.pricing || {};
    var amazon = (c.matches || []).filter(function (m) { return m && m.source === "amazon"; })[0];
    var ref = amazon && amazon.url ? amazon.url : (c.listing && c.listing.url) || "";
    return {
      title_fa: c.title_fa || (c.listing && c.listing.title) || "محصول",
      category: c.category || "",
      product_url: o.url || "",
      reference_url: ref,
      keyword_en: "", keyword_zh: "",
      price_cny: o.price_cny || 0,
      units: c.pack_qty || 1,
      moq: o.moq || 1,
      weight_kg: c.weight_kg || 0.01,
      amazon_usd: p.amazon_usd || null,
      temu_usd: (p.benchmark_usd && !p.benchmark_estimated) ? p.benchmark_usd : null,
      capital_usd: c.starter_capital_usd || 0,
      qty: null, note: ""
    };
  }

  function orderBody(it, over) {
    var b = {
      title_fa: it.title_fa, category: it.category, product_url: it.product_url,
      reference_url: it.reference_url, keyword_en: it.keyword_en, keyword_zh: it.keyword_zh,
      price_cny: it.price_cny, units: it.units, moq: it.moq, weight_kg: it.weight_kg,
      amazon_usd: it.amazon_usd, temu_usd: it.temu_usd, capital_usd: it.capital_usd,
      qty: it.qty, note: it.note
    };
    return Object.assign(b, over || {});
  }

  // In the demo there's no server, so price each line from the card's own numbers.
  function demoQuote(body, p) {
    var landed = p.landed_usd, sell = p.price_usd, profit = p.profit_usd;
    var qty = body.qty != null ? Math.max(1, body.qty)
      : (body.capital_usd > 0 && landed > 0 ? Math.max(body.moq, Math.floor(body.capital_usd / landed)) : body.moq);
    return Object.assign({ id: "d" + Date.now() + Math.floor(Math.random() * 1000) }, body, {
      ok: true, qty: qty, landed_usd: landed, sell_usd: sell, profit_usd: profit,
      margin: p.margin, roi: p.roi, order_capital_usd: round2(qty * landed),
      order_income_usd: round2(qty * sell), order_profit_usd: round2(qty * profit)
    });
  }

  function demoRequote(it) {
    var qty = it.qty != null ? Math.max(1, it.qty)
      : (it.capital_usd > 0 && it.landed_usd > 0 ? Math.max(it.moq, Math.floor(it.capital_usd / it.landed_usd)) : it.moq);
    return Object.assign({}, it, {
      qty: qty, order_capital_usd: round2(qty * it.landed_usd),
      order_income_usd: round2(qty * it.sell_usd), order_profit_usd: round2(qty * it.profit_usd)
    });
  }

  function demoSummary(items) {
    var cats = {};
    items.forEach(function (it) { var k = it.category || "other"; cats[k] = (cats[k] || 0) + 1; });
    var cap = 0, inc = 0, prof = 0, qty = 0;
    items.forEach(function (it) { cap += it.order_capital_usd; inc += it.order_income_usd; prof += it.order_profit_usd; qty += it.qty; });
    return {
      count: items.length, total_qty: qty,
      capital_usd: round2(cap), income_usd: round2(inc), profit_usd: round2(prof),
      margin: inc ? round2(prof / inc) : 0,
      categories: Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })
        .map(function (k) { return { key: k, fa: catName(k), n: cats[k] }; })
    };
  }

  function addToCart(c, btn) {
    if (!c) return;
    var body = cartItemFromCard(c);
    if (!body.price_cny) { toast("قیمت 1688 این محصول نامشخصه."); return; }
    if (btn) { btn.disabled = true; setTimeout(function () { btn.disabled = false; }, 800); }
    if (DEMO) {
      state.demoCart = state.demoCart || [];
      state.demoCart.push(demoQuote(body, c.pricing || {}));
      toast("به سبد سفارش اضافه شد (" + state.demoCart.length + " قلم).");
      if (state.tab === "order") renderOrder();
      return;
    }
    api("/api/requests", { method: "POST", body: body }).then(function () {
      state.order = null;
      toast("به سبد سفارش اضافه شد.");
      if (state.tab === "order") renderOrder();
    }, function (e) { toast(errText(e)); });
  }

  function renderOrder() {
    var main = $("main");
    if (!DEMO && !state.me.active) { main.innerHTML = lockedHTML(); return; }
    if (DEMO) { drawOrder(main, { items: (state.demoCart || []), summary: demoSummary(state.demoCart || []) }); return; }
    if (!state.order) {
      main.innerHTML = '<p class="loading">در حال باز کردن سبد سفارش…</p>';
      api("/api/requests").then(function (cart) { state.order = cart; renderOrder(); },
        function (e) { main.innerHTML = '<div class="empty">' + esc(errText(e)) + "</div>"; });
      return;
    }
    drawOrder(main, state.order);
  }

  function drawOrder(main, cart) {
    var items = cart.items || [], s = cart.summary || {};
    var head = '<div class="page-head"><div><span class="eyebrow">آماده‌ی سفارش به راینومال</span>' +
      '<h1 class="section-title">سبد سفارش</h1>' +
      '<p class="section-sub" style="margin:0">محصول‌هایی که از شکار، تحلیل لینک یا ماشین‌حساب «افزودن به سبد» کردی این‌جان. تعداد و سرمایه‌ی هر قلم رو می‌تونی عوض کنی و آخرش یک فایل اکسل برای ثبت سفارش در راینومال بگیری.</p></div></div>';
    if (!items.length) {
      main.innerHTML = head + '<div class="empty">سبدت خالیه. از «شکار امروز» یا «تحلیل لینک»، روی هر محصول دکمه‌ی «افزودن به سبد سفارش» رو بزن.</div>';
      return;
    }
    var idNote = (!DEMO && state.me && !state.me.national_id)
      ? '<p class="hint">کد ملی‌ات توی «حساب من» خالیه؛ پرش کن تا توی فایل سفارش بیاد. ' +
        '<button type="button" class="linklike" data-go="account">رفتن به حساب من</button></p>' : "";
    var summary = '<div class="summary">' +
      '<span class="pill neutral">اقلام: <span class="num">' + count(s.count || 0) + "</span></span>" +
      '<span class="pill neutral">تعداد کل: <span class="num">' + count(s.total_qty || 0) + "</span></span>" +
      '<span class="pill neutral">سرمایه‌ی کل: <span class="num">' + usd(s.capital_usd || 0) + "</span> · " + toman(Math.round((s.capital_usd || 0) * rate() / 1e4) * 1e4) + " تومان</span>" +
      '<span class="pill green">درآمد انتظاری: <span class="num">' + usd(s.income_usd || 0) + "</span></span>" +
      '<span class="pill green">سود انتظاری: <span class="num">' + usd(s.profit_usd || 0) + "</span> (" + pct(s.margin || 0) + ")</span>" +
      "</div>";
    var rows = items.map(orderRow).join("");
    var table = '<div class="table-wrap"><table class="order-table"><thead><tr>' +
      "<th>محصول</th><th>دسته</th><th>1688 / مرجع</th><th>تمام‌شده</th><th>فروش</th><th>سود/عدد</th>" +
      "<th>تعداد</th><th>سرمایه ($)</th><th>سود این قلم</th><th></th></tr></thead><tbody>" +
      rows + "</tbody></table></div>";
    var actions = '<div class="order-actions">' +
      (DEMO
        ? '<button type="button" class="btn" id="order-xlsx">دانلود اکسل سفارش راینومال' + ic("download") + "</button>"
        : '<a class="btn" href="/order/export">دانلود اکسل سفارش راینومال' + ic("download") + "</a>") +
      '<button type="button" class="btn ghost" id="order-copy">کپی خلاصه برای تلگرام' + ic("copy") + "</button>" +
      '<button type="button" class="btn ghost" id="order-clear">خالی کردن سبد' + ic("trash") + "</button></div>";
    main.innerHTML = head + idNote + summary + table + actions +
      '<p class="hint" style="margin-top:10px">عددها برآوردی‌اند و با فرمول قرارداد راینومال حساب شدن. قبل از سفارش اصلی حتماً نمونه بگیر.</p>';
    bindOrder(main, cart);
  }

  function orderRow(it) {
    var cls = it.ok ? "" : ' class="order-bad"';
    var link = function (u, label) { return safeUrl(u) ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + label + " ↗</a>" : "—"; };
    return "<tr" + cls + ' data-row="' + esc(it.id) + '">' +
      "<td><b>" + esc(it.title_fa || "محصول") + "</b>" + (it.note ? '<div class="card-sub">' + esc(it.note) + "</div>" : "") + "</td>" +
      "<td>" + esc(catName(it.category)) + "</td>" +
      '<td class="nowrap">' + link(it.product_url, "1688") + " · " + link(it.reference_url, "مرجع") + "</td>" +
      "<td>" + usd(it.landed_usd) + "</td>" +
      "<td>" + (it.ok ? usd(it.sell_usd) : "—") + "</td>" +
      "<td>" + (it.ok ? usd(it.profit_usd) : "—") + "</td>" +
      '<td><input class="input num order-qty" type="number" min="1" step="1" value="' + (it.qty || 1) + '" data-id="' + esc(it.id) + '"></td>' +
      '<td><input class="input num order-cap" type="number" min="0" step="10" value="' + round2(it.order_capital_usd) + '" data-id="' + esc(it.id) + '"></td>' +
      "<td>" + (it.ok ? usd(it.order_profit_usd) : "—") + "</td>" +
      '<td><button type="button" class="icon-btn" title="حذف" data-del="' + esc(it.id) + '">' + ic("trash") + "</button></td>" +
      "</tr>";
  }

  function bindOrder(root, cart) {
    var items = cart.items || [];
    var find = function (id) { return items.filter(function (x) { return String(x.id) === String(id); })[0]; };

    function applyEdit(id, over) {
      var it = find(id); if (!it) return;
      if (DEMO) {
        state.demoCart = (state.demoCart || []).map(function (x) {
          return String(x.id) === String(id) ? demoRequote(Object.assign({}, x, over)) : x;
        });
        renderOrder(); return;
      }
      api("/api/requests/" + id, { method: "PUT", body: orderBody(it, over) }).then(function () {
        state.order = null; renderOrder();
      }, function (e) { toast(errText(e)); });
    }

    each(root, ".order-qty", function (inp) {
      inp.onchange = function () { applyEdit(inp.dataset.id, { qty: Math.max(1, Number(inp.value || 1)) }); };
    });
    each(root, ".order-cap", function (inp) {
      inp.onchange = function () { applyEdit(inp.dataset.id, { capital_usd: Math.max(0, Number(inp.value || 0)), qty: null }); };
    });
    each(root, "[data-del]", function (b) {
      b.onclick = function () {
        var id = b.dataset.del;
        if (DEMO) { state.demoCart = (state.demoCart || []).filter(function (x) { return String(x.id) !== String(id); }); renderOrder(); return; }
        api("/api/requests/" + id, { method: "DELETE" }).then(function () { state.order = null; renderOrder(); }, function (e) { toast(errText(e)); });
      };
    });
    var clear = $("order-clear");
    if (clear) clear.onclick = function () {
      if (!window.confirm("همه‌ی اقلام سبد پاک بشن؟")) return;
      if (DEMO) { state.demoCart = []; renderOrder(); return; }
      Promise.all(items.map(function (it) { return api("/api/requests/" + it.id, { method: "DELETE" }).catch(function () {}); }))
        .then(function () { state.order = null; renderOrder(); });
    };
    var copy = $("order-copy");
    if (copy) copy.onclick = function () { copyText(orderSummaryText(cart), copy); };
    var xlsx = $("order-xlsx");
    if (xlsx) xlsx.onclick = function () { toast("در نسخه‌ی واقعی اینجا فایل اکسل سفارش دانلود میشه."); };
  }

  function orderSummaryText(cart) {
    var s = cart.summary || {}, lines = ["سبد سفارش — " + ((state.config && state.config.brand) || "شکارچی")];
    (cart.items || []).forEach(function (it, i) {
      lines.push((i + 1) + ") " + (it.title_fa || "محصول") + " — " + it.qty + " عدد، سرمایه " + usd(it.order_capital_usd) + "، سود " + usd(it.order_profit_usd));
    });
    lines.push("—");
    lines.push("اقلام: " + (s.count || 0) + " · سرمایه‌ی کل: " + usd(s.capital_usd || 0) + " · سود انتظاری: " + usd(s.profit_usd || 0) + " (" + pct(s.margin || 0) + ")");
    return lines.join("\n");
  }

  function copyText(text, btn) {
    var done = function () { toast("کپی شد."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(t);
  }
  function rate() { return (state.config && state.config.toman_per_usd) || 255000; }

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
        (cfg.online_payment ? "" : '<p class="hint">پرداخت آنلاین هنوز فعال نشده؛ بعد از کارت‌به‌کارت، پشتیبانی اشتراکت رو فعال می‌کنه. ' + supportLine("") + "</p>") +
        '<div class="error" id="pay-error"></div></section>' +
      '<form class="panel" id="profile-form"><h2 class="section-title">مشخصات و علاقه‌مندی</h2>' +
        '<p class="section-sub">شکارهای اختصاصی از روی این دسته‌ها و بودجه‌ات انتخاب میشن. هیچ دسته‌ای نزنی یعنی همه.</p>' +
        '<div class="form-grid" style="margin-bottom:16px">' +
          '<div class="field"><label for="p-name">نام</label><input class="input" id="p-name" value="' + esc(me.name) + '"></div>' +
          '<div class="field"><label for="p-phone">موبایل</label><input class="input num" id="p-phone" value="' + esc(me.phone) + '"></div>' +
          '<div class="field"><label for="p-nid">کد ملی</label><input class="input num" id="p-nid" value="' + esc(me.national_id || "") + '"><span class="hint">برای فایل سفارش راینومال؛ اختیاریه</span></div>' +
          '<div class="field"><label for="p-budget">بودجه‌ی شروع (دلار)</label><input class="input num" id="p-budget" type="number" min="0" step="50" value="' + esc(me.budget_usd) + '"><span class="hint">هزینه‌ی اولین محموله‌ی همه‌ی محصولات با هم</span></div>' +
        "</div>" +
        '<div class="label" style="margin-bottom:6px">دسته‌هایی که کار می‌کنی</div><div class="cats">' + cats + "</div>" +
        '<div class="error" id="profile-error"></div><button class="btn" type="submit">ذخیره' + ic("save") + "</button></form>" +
      supportHTML() +
      (me.is_admin ? adminHTML() : "") +
      (me.is_admin || DEMO ? '<section class="panel" id="pricing-panel">' +
        (DEMO && cfg.pricing_report ? pricingHTML(cfg.pricing_report) : '<p class="section-sub">در حال محاسبه‌ی قیمت‌گذاری…</p>') + "</section>" : "") +
    "</div>";
  }

  // For the site's admin: what each plan costs us and brings in, by kind of cost, against the
  // target margin (hunter/economics.py). Each plan is costed at its full quota, no cache.
  var ECON_PARTS = [["analyses_usd", "تحلیل‌ها"], ["fixed_usd", "سهم هزینه‌ی ثابت"], ["sales_usd", "درگاه، مالیات، بازاریابی"], ["profit_usd", "سود خالص"]];
  function pricingHTML(r) {
    var unit = {
      usd_month: function (v) { return ltr(usd(v)) + " در ماه"; },
      usd_each: function (v) { return ltr(v > 0 && v < 0.1 ? "$" + String(Number(v.toFixed(4))) : usd(v)) + " هر بار"; },  // a fraction of a cent shows
      share: function (v) { return ltr(pct(v)) + " از قیمت"; },
    };
    var tm = function (v) { return toman(Math.round(v * r.toman_per_usd / 10000) * 10000); };
    var kinds = r.kinds.map(function (k, n) {
      return '<div class="cost-kind"><div class="head"><span class="n">0' + (n + 1) + "</span><h3>" + esc(k.fa) + "</h3></div><ul>" +
        k.items.map(function (c) {
          return "<li><span>" + esc(c.fa) + (c.note_fa ? "<small>" + esc(c.note_fa) + "</small>" : "") + "</span><b>" + unit[k.unit](c.value) + "</b></li>";
        }).join("") + '</ul><div class="total"><span>جمع</span><b>' + unit[k.unit](k.total) + "</b></div></div>";
    }).join("");
    var legend = ECON_PARTS.map(function (x, n) { return '<span><i class="e' + n + '"></i>' + x[1] + "</span>"; }).join("");
    var rows = r.plans.map(function (p) {
      var bar = ECON_PARTS.map(function (x, n) { return '<i class="e' + n + '" style="width:' + (Math.max(0, p[x[0]]) / p.price_usd * 100).toFixed(2) + '%" title="' + x[1] + ": " + usd(p[x[0]]) + '"></i>'; }).join("");
      return "<tr><th>" + esc(p.name_fa) + "<small>" + p.links + " تحلیل در ماه</small></th>" +
        '<td class="num">' + usd(p.price_usd) + "<small>" + toman(p.price_toman) + " تومان</small></td>" +
        '<td class="num">' + usd(p.analyses_usd) + '</td><td class="num">' + usd(p.fixed_usd) + '</td><td class="num">' + usd(p.sales_usd) + "</td>" +
        '<td class="num good">' + usd(p.profit_usd) + "<small>" + tm(p.profit_usd) + " تومان</small></td>" +
        '<td><span class="pill ' + (p.ok ? "green" : "red") + '">' + ic(p.ok ? "check" : "warn") + ltr(pct(p.margin)) + "</span></td>" +
        '<td class="bar-cell"><div class="econ-bar">' + bar + "</div></td></tr>";
    }).join("");
    var months = r.months.map(function (m) {
      return "<tr" + (m.subscribers === r.subscribers ? ' class="base"' : "") + '><th class="num">' + toman(m.subscribers) + '</th><td class="num">' + usd(m.revenue_usd) +
        '</td><td class="num">' + usd(m.cost_usd) + '</td><td class="num ' + (m.profit_usd >= 0 ? "good" : "bad") + '">' + usd(m.profit_usd) +
        '</td><td class="num">' + toman(m.profit_toman) + "</td></tr>";
    }).join("");
    return '<div class="econ-head"><div><h2 class="section-title">قیمت‌گذاری پلن‌ها و هزینه‌ها</h2>' +
        '<p class="section-sub">قیمت هر پلن از هزینه‌هاش و حد سود ساخته میشه: هزینه‌ی تحلیل‌ها + سهمش از هزینه‌ی ثابت، تقسیم بر (1 − سهم درگاه و مالیات و بازاریابی − حد سود)، بعد گرد به بالا تا عددی که به 99. دلار تموم میشه، و هیچ پلنی زیر ' + ltr(usd(r.min_price || 0)) + ' فروخته نمیشه؛ تومانش با نرخ روز حساب میشه. هر پلن با سهمیه‌ی کاملش و بدون کش حساب شده، یعنی بدترین حالت. مدل هوش مصنوعی: ' + esc(r.model || "") + "." +
        (DEMO ? " (در سایت واقعی فقط مدیر این بخش رو می‌بینه.)" : "") + "</p></div>" +
        '<div class="econ-kpis"><div><span>حد سود (حاشیه‌ی خالص هدف)</span><b>' + ltr(pct(r.margin)) + '</b><small>کف: ' + ltr(pct(r.min_margin)) + "</small></div>" +
          "<div><span>نقطه‌ی سربه‌سر</span><b>" + (r.break_even == null ? "—" : toman(r.break_even)) + "</b><small>مشترک در ماه</small></div>" +
          "<div><span>پایه‌ی محاسبه</span><b>" + toman(r.subscribers) + "</b><small>مشترک پولی</small></div>" +
          "<div><span>نرخ دلار</span><b>" + toman(r.toman_per_usd) + "</b><small>تومان</small></div></div></div>" +
      '<h3 class="econ-h3">دسته‌بندی هزینه‌ها</h3><div class="cost-kinds">' + kinds + "</div>" +
      '<h3 class="econ-h3">هر پلن برای هر مشترک در ماه</h3><div class="econ-legend">' + legend + "</div>" +
      '<div class="table-wrap"><table class="econ-table"><thead><tr><th>پلن</th><th>قیمت در ماه</th><th>تحلیل‌ها</th><th>سهم ثابت</th><th>درگاه، مالیات، بازاریابی</th><th>سود خالص</th><th>حاشیه</th><th>قیمت کجا می‌ره</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<h3 class="econ-h3">ماه با چند مشترک</h3><p class="hint">با این ترکیب مشترک‌ها: ' +
        r.plans.map(function (p) { return esc(p.name_fa) + " " + ltr(pct(r.mix[p.id] || 0)); }).join("، ") + ".</p>" +
      '<div class="table-wrap"><table class="econ-table months"><thead><tr><th>مشترک</th><th>فروش ماهانه</th><th>هزینه‌ی ماهانه</th><th>سود ماهانه</th><th>سود ماهانه (تومان)</th></tr></thead><tbody>' + months + "</tbody></table></div>" +
      '<p class="hint">همه‌ی این عددها از تنظیمات عوض میشن: HUNTER_MARGIN (حد سود)، HUNTER_MIN_MARGIN (کف)، HUNTER_SUBSCRIBERS و HUNTER_COSTS (هر هزینه با کلیدش). راهنما در hunter/README.md.</p>';
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
    var pricing = $("pricing-panel");
    if (pricing && !DEMO) api("/api/admin/pricing").then(function (r) { pricing.innerHTML = pricingHTML(r); }, function (e) {
      pricing.innerHTML = '<p class="error">' + esc(errText(e)) + "</p>";
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
      var body = { name: $("p-name").value, phone: $("p-phone").value, national_id: ($("p-nid") ? $("p-nid").value : ""), categories: cats, budget_usd: Number($("p-budget").value || 0) };
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
    return key === "fee" ? n + " (" + toman(sharePct()) + "%)" : n;
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
    sea: "دریایی: ارزون ولی کند، حدود 3 تا 6 هفته",
    site: "نرخ پیش‌فرض سایت (ترکیب رایج)",
    air: "هوایی: سریع ولی گرون، حدود 1 هفته",
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
      qty: p.min_starter_qty, monthly_sales: 40, toman_per_usd: state.config.toman_per_usd || 255000, cfg: {},
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
        '<section class="panel guest-cta" style="margin-top:20px"><div><h2 class="section-title">هر روز محصول‌هایی که این حساب‌وکتاب رو پاس می‌کنن، آماده‌ی تو</h2>' +
        '<p class="section-sub" style="margin:0">موتور شکار هر روز پرفروش‌های Temu و آمازون رو با همین فرمول‌ها حساب می‌کنه و سبزها رو با تأمین‌کننده‌ی 1688 تحویلت می‌ده.</p></div>' +
        '<button type="button" class="btn" data-go="signup">رایگان شروع کن' + ic("back") + "</button></section>");
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
          '<span class="hint">در ' + toman(state.config.pricing.license_installments || 10) + " قسط از درآمد؛ شرکای قبلی معافن (بند 4 قرارداد).</span></div>" +
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
      : "طول × عرض × ارتفاع ÷ 6000. اگه از وزن واقعی بیشتر باشه، کرایه روی اون حساب میشه.";
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
      '<div class="chart-note">' + ic("info") + "<span>هر ستون: وضعیت پولت در پایان هر ماه. زیر صفر یعنی هنوز سرمایه‌ات کامل برنگشته" + (Math.ceil(qty / monthly) > 12 ? "؛ فقط 12 ماه اول نشون داده شده" : "") + ".</span></div>";
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
      (s.over_shelf ? '<div class="notice" style="margin:12px 0 0"><b>بیش از ' + toman(s.shelf_months) + " ماه در انبار:</b> طبق بند 11-5 قرارداد، کالایی که به‌خاطر کم‌کاری فروشنده بیش از " +
        toman(s.shelf_months) + " ماه در انبار راینومال بمونه باید ظرف 30 روز خارج بشه. با " + toman(monthly) + " فروش در ماه، حداکثر " + toman(s.max_qty_on_shelf) + " عدد بفرست.</div>" : "") +
      '<p class="hint" style="margin:10px 0 0">تسویه‌ی راینومال هفتگیه: درخواست برداشت تا شنبه، حسابرسی یکشنبه، واریز ریالی دوشنبه (بند 8 قرارداد).</p>' +
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
    box.innerHTML = cardHead("مقایسه‌ی حالت‌ها", "table", "تا 4 حالت رو کنار هم ببین؛ فقط در همین مرورگر ذخیره میشه.", actions) + body;
    $("calc-save").onclick = function () {
      var cs = state.calc, all = memo().scenarios || [];
      if (all.length >= 4) { toast("حداکثر 4 حالت؛ اول یکی رو پاک کن."); return; }
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
    if (s.over_shelf) lines.push("⚠️ فروش کل محموله بیش از " + toman(s.shelf_months) + " ماه طول می‌کشه (بند 11-5 قرارداد)");
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
      state.me = null; state.picks = null; state.analysis = null; state.jobs = undefined; state.order = null; state.tab = "home"; return loadHunt();
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
