/* The sellers' site. Talks to hunter/app.py; with window.HUNTER_DEMO set (the preview
   page) it runs on bundled sample data instead and never calls the server. */
(function () {
  "use strict";

  var DEMO = window.HUNTER_DEMO || null;
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    config: null, me: null, hunt: null, picks: null, tab: "hunt",
    filter: { cat: "all", verdict: "all", sort: "score" }, authMode: "signup", analysis: null,
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
    if (state.tab === "picks") return renderPicks();
    if (state.tab === "analyze") { main.innerHTML = analyzeHTML(); bindAnalyze(); return; }
    if (state.tab === "account") { main.innerHTML = accountHTML(); bindAccount(); return; }
    main.innerHTML = huntHTML(); bindHunt();
  }

  function vsChip(p) {
    if (p.vs_benchmark == null) return '<span class="vs-chip warn">؟</span>';
    var d = Math.round((p.vs_benchmark - 1) * 100);
    var cls = p.vs_benchmark <= 1.0 ? "good" : p.vs_benchmark <= 1.1 ? "warn" : "bad";
    return '<span class="vs-chip ' + cls + '">' + (d > 0 ? "+" : "") + d + "%</span>";
  }

  function cardHTML(c) {
    var title = esc(c.title_fa || (c.listing && c.listing.title) || "");
    var initial = esc((c.title_fa || "?").trim().charAt(0));
    var head =
      '<div class="card-head">' +
        '<div class="thumb">' + (c.listing && safeUrl(c.listing.image_url)
          ? '<img src="' + esc(c.listing.image_url) + '" alt="" loading="lazy" onerror="this.remove()">' : "") + initial + "</div>" +
        "<div><div class=\"card-title\">" + title + "</div>" +
          (c.listing && c.listing.title && c.title_fa ? '<div class="card-sub">' + esc(c.listing.title) + "</div>" : "") +
          '<div class="card-cat">' + esc(catName(c.category)) + ' · <span class="pill ' + c.verdict + '" style="padding:0 8px"><span class="dot"></span>' + VERDICT[c.verdict] + "</span></div></div>" +
        '<div class="score ' + c.verdict + '" title="امتیاز از ۱۰۰">' + c.score + "</div>" +
      "</div>";
    if (c.locked) {
      return '<article class="card locked">' + head +
        '<div class="ladder"><div class="rung"><div class="k">1688</div><div class="v">¥00.00</div></div><div class="rung"><div class="k">تا انبار</div><div class="v">$0.00</div></div><div class="rung ours"><div class="k">قیمت پیشنهادی</div><div class="v">$00.00</div></div><div class="rung vs"><div class="k">Temu</div><span class="vs-chip good">-0%</span></div></div>' +
        '<p class="lock-note">قیمت‌ها، تأمین‌کننده و لینک خرید برای مشترک‌ها باز میشه.</p></article>';
    }
    var p = c.pricing, o = c.offer, l = c.listing;
    var bench = p.benchmark_usd == null ? "—" : usd(p.benchmark_usd) + (p.benchmark_estimated ? "*" : "");
    var ladder =
      '<div class="ladder">' +
        '<div class="rung"><div class="k">خرید از 1688</div><div class="v">' + cny(o.price_cny * c.pack_qty) + "</div></div>" +
        '<div class="rung"><div class="k">تمام‌شده تا انبار</div><div class="v">' + usd(p.landed_usd) + "</div></div>" +
        '<div class="rung ours"><div class="k">قیمت پیشنهادی</div><div class="v">' + usd(p.price_usd) + "</div></div>" +
        '<div class="rung vs"><div class="k">Temu ' + bench + "</div>" + vsChip(p) + "</div>" +
      "</div>";
    var demand = l.monthly_sold != null ? l.monthly_sold : (l.sold_total != null ? Math.round(l.sold_total / 12) : null);
    var stats =
      '<div class="stats">' +
        '<div class="stat"><div class="k">سود هر عدد</div><div class="v">' + usd(p.profit_usd) + "</div></div>" +
        '<div class="stat"><div class="k">حاشیه‌ی سود</div><div class="v">' + pct(p.margin) + "</div></div>" +
        '<div class="stat"><div class="k">بازگشت سرمایه</div><div class="v">' + pct(p.roi) + "</div></div>" +
        '<div class="stat"><div class="k">فروش ماهانه‌ی بازار</div><div class="v">' + count(demand) + "</div></div>" +
        '<div class="stat"><div class="k">حداقل سفارش</div><div class="v">' + count(o.moq) + "</div></div>" +
        '<div class="stat"><div class="k">سرمایه‌ی شروع (' + count(c.starter_qty) + ' عدد)</div><div class="v">' + usd(c.starter_capital_usd) + "</div></div>" +
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
      " · سربه‌سر: " + usd(p.breakeven_usd) + " · " + p.multiplier + " برابر قیمت کارخونه" +
      (p.benchmark_estimated ? " · * قیمت Temu از روی قیمت آمازون تخمین زده شده" : "") + "</p></details>";
    var links = [];
    if (safeUrl(l.url)) links.push('<a href="' + esc(l.url) + '" target="_blank" rel="noopener">آگهی در ' + (l.source === "amazon" ? "آمازون" : "Temu") + " ↗</a>");
    if (safeUrl(o.url)) links.push('<a href="' + esc(o.url) + '" target="_blank" rel="noopener">تأمین‌کننده در 1688 ↗</a>');
    return '<article class="card">' + head + ladder + stats + reasons + flags + costs +
      '<div class="card-foot">' + links.join("") + "</div></article>";
  }
  function row(k, v) { return "<tr><td>" + esc(k) + "</td><td>" + usd(v) + "</td></tr>"; }

  // --- landing -------------------------------------------------------------------

  function landingHTML() {
    var cfg = state.config || {};
    var teaser = state.hunt && state.hunt.candidates || [];
    var plans = (cfg.plans || []).map(function (p) {
      return '<div class="plan"><div class="label">' + esc(p.name_fa) + '</div><div class="price">' + toman(p.price_toman) +
        ' <small>تومان</small></div><div class="hint" style="color:var(--ink-soft);font-size:13px">' + toman(p.days) + " روز دسترسی کامل</div></div>";
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
      "</div>";
    if (h.locked) {
      return head + '<div class="notice"><b>اشتراک نداری.</b> فقط چند نمونه قفل‌شده می‌بینی. از «حساب من» اشتراک بخر.</div><div class="grid">' +
        h.candidates.map(cardHTML).join("") + "</div>";
    }
    var cats = {};
    h.candidates.forEach(function (c) { cats[c.category] = true; });
    var f = state.filter;
    var list = h.candidates.filter(function (c) {
      return (f.cat === "all" || c.category === f.cat) && (f.verdict === "all" || c.verdict === f.verdict);
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

  function analyzeHTML() {
    if (!state.me.active) return lockedHTML();
    var a = state.analysis;
    return '<h1 class="section-title">تحلیل محصول خودم</h1>' +
      '<p class="section-sub">محصولی که خودت پیدا کردی رو وارد کن: قیمت 1688، وزن و قیمت Temu. همون محاسبه‌ی موتور روش انجام میشه و میگه با چه قیمتی بفروشی و ارزش آوردن داره یا نه.</p>' +
      '<form class="panel" id="an-form" novalidate><div class="form-grid">' +
        '<div class="field" style="grid-column:1/-1"><label for="an-title">اسم یا عنوان آگهی (برای تشخیص دسته و محدودیت‌ها)</label><input class="input" id="an-title" dir="auto" placeholder="مثلاً: Car Seat Gap Filler 2 Pack"></div>' +
        num("an-cny", "قیمت هر عدد در 1688 (یوان)", "12", "0.1") +
        num("an-weight", "وزن هر آگهی با بسته‌بندی (کیلو)", "0.4", "0.01") +
        num("an-temu", "قیمت همین محصول در Temu (دلار)", "11.99", "0.01") +
        num("an-lpack", "چند عدد در هر آگهی؟", "1", "1") +
        num("an-moq", "حداقل سفارش در 1688", "10", "1") +
        num("an-sold", "فروش ماهانه (اختیاری)", "", "1") +
        num("an-reviews", "تعداد نظرهای رقیب اصلی (اختیاری)", "", "1") +
        num("an-cart", "معمولاً چند قلم در هر سفارش؟", "3", "1") +
        '<div class="field"><label for="an-market">مشتری چطور پول می‌ده؟</label><select class="input" id="an-market"><option value="prepaid">آنلاین (مثل Temu)</option><option value="cod">پرداخت در محل</option></select></div>' +
      '</div><div class="error" id="an-error"></div><button class="btn" type="submit">تحلیل کن</button></form>' +
      (a ? '<div style="margin-top:18px" class="grid">' + cardHTML(a) + "</div>" : "");
  }
  function num(id, label, value, step) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input num" id="' + id + '" type="number" min="0" step="' + step + '" value="' + value + '"></div>';
  }
  function bindAnalyze() {
    var form = $("an-form");
    if (!form) { bindLocked(); return; }
    form.onsubmit = function (ev) {
      ev.preventDefault();
      var v = function (id) { var x = $(id).value; return x === "" ? null : Number(x); };
      var body = {
        title: $("an-title").value, price_cny: v("an-cny"), weight_kg: v("an-weight"),
        temu_price_usd: v("an-temu"), listing_pack: v("an-lpack") || 1, moq: v("an-moq") || 1,
        monthly_sold: v("an-sold"), reviews: v("an-reviews"), items_per_cart: v("an-cart") || 3,
        market: $("an-market").value,
      };
      $("an-error").textContent = "";
      if (!body.price_cny || !body.weight_kg) { $("an-error").textContent = "قیمت 1688 و وزن لازمه."; return; }
      var ids = ["an-title", "an-cny", "an-weight", "an-temu", "an-lpack", "an-moq", "an-sold", "an-reviews", "an-cart", "an-market"];
      var done = function (res) {
        var typed = {};
        ids.forEach(function (id) { typed[id] = $(id).value; });
        state.analysis = res; render();
        ids.forEach(function (id) { $(id).value = typed[id]; });  // keep what was typed
      };
      if (DEMO) { done(demoAnalyze(body)); return; }
      api("/api/analyze", { method: "POST", body: body }).then(done, function (e) { $("an-error").textContent = errText(e); });
    };
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
    var status = me.active
      ? (me.is_admin ? "مدیر سایت: دسترسی کامل." : "اشتراکت تا " + esc(faDate(me.paid_until)) + " فعاله.")
      : "اشتراک فعالی نداری.";
    var plans = cfg.plans.map(function (p) {
      return '<div class="plan"><div class="label">' + esc(p.name_fa) + '</div><div class="price">' + toman(p.price_toman) + ' <small>تومان</small></div>' +
        '<button type="button" class="btn" data-plan="' + esc(p.id) + '"' + (cfg.online_payment ? "" : " disabled") + ">" + (me.active ? "تمدید" : "خرید") + " با درگاه</button></div>";
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
      offer: { price_cny: b.price_cny, moq: b.moq || 1, url: "" },
      pricing: {
        factory_usd: r2(factory), china_side_usd: r2(china), freight_usd: r2(freight), packaging_usd: cfg.packaging_usd,
        landed_usd: r2(landed), last_mile_usd: r2(lastMile), price_usd: r2(price), floor_usd: r2(floor),
        breakeven_usd: r2(unit / keep), platform_fee_usd: r2(price * cfg.platform_pct), gateway_usd: r2(price * cfg.gateway_pct),
        marketing_usd: r2(price * cfg.marketing_pct), returns_reserve_usd: r2(price * returns), profit_usd: r2(profit),
        margin: margin, roi: profit / landed, multiplier: r2(price / factory), benchmark_usd: b.temu_price_usd,
        benchmark_estimated: false, vs_benchmark: ratio,
      },
      score: Math.min(score, 100), verdict: verdict, pros: pros, cons: cons, flags: [],
      starter_qty: starter, starter_capital_usd: r2(starter * landed),
    };
  }

  // --- navigation ----------------------------------------------------------------

  function go(tab) { state.tab = tab; render(); window.scrollTo(0, 0); }
  function logout() {
    api("/api/logout", { method: "POST" }).then(function () {
      state.me = null; state.picks = null; state.analysis = null; return loadHunt();
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
