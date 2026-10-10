"use strict";

// English and Persian texts for the page. Visitors get Persian if their
// browser's first language is Persian, English otherwise, and can switch;
// the choice is remembered. Elements with data-i18n="key" get the text.
(function () {
  const STRINGS = {
    en: {
      our_projects: "Our projects",
      discover_more: "More from Gryffin",
      visit_project: "Visit website",
      promotion: "Our promotion",
      privacy: "Free for now. Anonymous usage is counted to improve the service.",
      title: "Video Downloader",
      brand: "Video Downloader",
      other_lang: "فارسی",
      tg_bot: "Telegram bot",
      badge: "Free, no sign-up",
      h1_1: "Any video,",
      h1_2: "with just a link",
      sub: "Paste a post or video link here — we'll do the rest.",
      url_label: "Video link",
      paste: "Paste",
      download: "Download",
      error_title: "Download failed",
      sites_title: "Where from?",
      site_instagram: "Instagram",
      site_tiktok: "TikTok",
      site_youtube: "YouTube",
      site_x: "X (Twitter)",
      site_facebook: "Facebook",
      site_reddit: "Reddit",
      site_pinterest: "Pinterest",
      site_soundcloud: "SoundCloud",
      site_aparat: "Aparat",
      site_more: "and 1000+ more sites",
      n1: "1",
      n2: "2",
      n3: "3",
      step1_title: "Copy the link",
      step1_text: "In the app, tap “Share”, then “Copy link”.",
      step2_title: "Paste it here",
      step2_text: "Paste the link in the box above and hit “Download”.",
      step3_title: "Save it",
      step3_text: "Watch the video right here and save it with one click.",
      tg_title: "We're on Telegram too",
      tg_text: "Send links to the bot, or add it to your group or channel and it'll reply to every video link with the video.",
      tg_start: "Start the bot",
      tg_group: "Add to group",
      tg_channel: "Add to channel",
      footer: "Only download content you have the right to use.",
      // while working
      queued: "Waiting in line...",
      queued_detail: "Other downloads are running; hang on a moment.",
      checking: "Checking the link...",
      downloading: "Downloading...",
      of: "of",
      per_second: "/s",
      mb: "MB",
      kb: "KB",
      percent: "{n}%",
      // results
      video: "Video",
      download_video: "Download video",
      download_file: "Download file",
      source: "Original post",
      partly: "{n} file(s) were too large to download.",
      // errors (codes from the server)
      err_bad_link: "Please enter a video link.",
      err_unsupported_link: "This link isn't supported. Send the link of the post or video itself (not a profile or channel).",
      err_too_many_jobs: "You already have downloads in progress; please wait a moment.",
      err_busy: "The server is very busy right now; try again in a few minutes.",
      err_not_found: "This download wasn't found or has expired.",
      err_unexpected: "Something went wrong. Please try again.",
      err_unsupported: "This link isn't supported.",
      err_login: "This site needs a login to download, or it's limiting requests right now. Try again later.",
      err_private: "This content is private and can't be downloaded.",
      err_unavailable: "This content isn't available or has been removed.",
      err_no_video: "No video found at this link.",
      err_failed: "The download failed. Check the link and try again.",
      err_too_large: "The file is bigger than the {limit_mb} MB limit.",
      err_network: "Couldn't reach the server. Check your internet connection.",
    },
    fa: {
      our_projects: "پروژه‌های ما",
      discover_more: "بیشتر از گریفین",
      visit_project: "مشاهدهٔ سایت",
      promotion: "معرفی از مجموعهٔ ما",
      privacy: "فعلاً رایگان است. برای بهبود سرویس، تعداد استفاده‌ها با شناسهٔ ناشناس ثبت می‌شود.",
      title: "دانلودر ویدیو",
      brand: "دانلودر ویدیو",
      other_lang: "English",
      tg_bot: "ربات تلگرام",
      badge: "رایگان و بدون ثبت‌نام",
      h1_1: "هر ویدیویی،",
      h1_2: "فقط با یک لینک",
      sub: "لینک پست یا ویدیو را اینجا بگذارید؛ بقیه‌اش با ما.",
      url_label: "لینک ویدیو",
      paste: "چسباندن",
      download: "دانلود",
      error_title: "دانلود نشد",
      sites_title: "از کجاها؟",
      site_instagram: "اینستاگرام",
      site_tiktok: "تیک‌تاک",
      site_youtube: "یوتیوب",
      site_x: "توییتر (X)",
      site_facebook: "فیسبوک",
      site_reddit: "ردیت",
      site_pinterest: "پینترست",
      site_soundcloud: "ساندکلاد",
      site_aparat: "آپارات",
      site_more: "و بیش از ۱۰۰۰ سایت دیگر",
      n1: "۱",
      n2: "۲",
      n3: "۳",
      step1_title: "لینک را کپی کنید",
      step1_text: "در اپ، روی «اشتراک‌گذاری» و بعد «کپی لینک» بزنید.",
      step2_title: "اینجا بگذارید",
      step2_text: "لینک را در کادر بالا بچسبانید و «دانلود» را بزنید.",
      step3_title: "ذخیره کنید",
      step3_text: "ویدیو را همین‌جا ببینید و با یک کلیک ذخیره کنید.",
      tg_title: "در تلگرام هم هستیم",
      tg_text: "لینک را برای ربات بفرستید، یا ربات را به گروه و کانالتان اضافه کنید تا زیر هر لینک، خود ویدیو را بفرستد.",
      tg_start: "شروع ربات",
      tg_group: "افزودن به گروه",
      tg_channel: "افزودن به کانال",
      footer: "فقط محتوایی را دانلود کنید که اجازه‌ی استفاده از آن را دارید.",
      queued: "در صف دانلود...",
      queued_detail: "چند دانلود دیگر در جریان است؛ کمی صبر کنید.",
      checking: "در حال بررسی لینک...",
      downloading: "در حال دانلود...",
      of: "از",
      per_second: "/ثانیه",
      mb: "مگابایت",
      kb: "کیلوبایت",
      percent: "{n}٪",
      video: "ویدیو",
      download_video: "دانلود ویدیو",
      download_file: "دانلود فایل",
      source: "پست اصلی",
      partly: "{n} فایل به دلیل حجم زیاد دانلود نشد.",
      err_bad_link: "لطفاً لینک ویدیو را وارد کنید.",
      err_unsupported_link: "این لینک پشتیبانی نمی‌شود. لینک خود پست یا ویدیو را بفرستید (نه لینک پیج یا کانال).",
      err_too_many_jobs: "چند دانلود شما هنوز تمام نشده؛ کمی صبر کنید.",
      err_busy: "سرور الان خیلی شلوغ است؛ چند دقیقه‌ی دیگر امتحان کنید.",
      err_not_found: "این دانلود پیدا نشد یا منقضی شده است.",
      err_unexpected: "خطای غیرمنتظره رخ داد. دوباره امتحان کنید.",
      err_unsupported: "این لینک پشتیبانی نمی‌شود.",
      err_login: "این سایت برای دانلود نیاز به ورود (لاگین) دارد یا موقتاً محدودیت گذاشته است. کمی بعد امتحان کنید.",
      err_private: "این محتوا خصوصی است و قابل دانلود نیست.",
      err_unavailable: "این محتوا در دسترس نیست یا حذف شده است.",
      err_no_video: "در این لینک ویدیویی پیدا نشد.",
      err_failed: "دانلود ناموفق بود. لینک را بررسی کنید و دوباره امتحان کنید.",
      err_too_large: "حجم فایل بیشتر از حد مجاز ({limit_mb} مگابایت) است.",
      err_network: "ارتباط با سرور برقرار نشد. اینترنت خود را بررسی کنید.",
    },
  };
  const STORAGE_KEY = "lang";
  const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

  function detect() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved in STRINGS) return saved;
    } catch {
      // storage blocked: fall back to the browser's language
    }
    const first = (navigator.languages && navigator.languages[0]) || navigator.language || "";
    return first.toLowerCase().startsWith("fa") ? "fa" : "en";
  }

  let lang = detect();
  const listeners = [];

  function num(value) {
    const text = String(value);
    return lang === "fa" ? text.replace(/\d/g, (d) => FA_DIGITS[d]).replace(/\./g, "٫") : text;
  }

  function t(key, vars = {}) {
    const text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_, name) =>
      typeof vars[name] === "number" ? num(vars[name]) : String(vars[name] ?? ""),
    );
  }

  function apply() {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = lang === "fa" ? "rtl" : "ltr";
    document.title = t("title");
    for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll("[data-i18n-aria]")) {
      el.setAttribute("aria-label", t(el.dataset.i18nAria));
    }
  }

  function setLang(next) {
    if (!(next in STRINGS)) return;
    lang = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not remembered, that's fine
    }
    apply();
    for (const listener of listeners) listener(lang);
  }

  window.I18N = {
    get lang() {
      return lang;
    },
    t,
    num,
    setLang,
    toggle: () => setLang(lang === "fa" ? "en" : "fa"),
    onChange: (listener) => listeners.push(listener),
    strings: STRINGS,
  };
  apply();
})();
