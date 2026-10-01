// Landing page (M8): English toggle, pricing and demo number from the API, sign-up -> code -> setup wizard,
// contact form. No cookies; page funnel steps (visit, demo call) are anonymous counters.

const EN = {
  brand: 'AI Receptionist', nav: 'Menu', nav_pricing: 'Pricing', nav_faq: 'FAQ', nav_login: 'Sign in',
  hero_title: 'Never miss a call again.',
  hero_lead: 'An AI phone receptionist that answers in Persian and English, day and night: it books, moves and cancels appointments and takes messages. Built for Iranian-owned businesses in the UK.',
  cta_trial: 'Try it free for 14 days', cta_demo: 'Call the demo now',
  hero_note: 'Keep your number. No long contract.',
  samples_title: 'Listen', sample_fa: 'A call in Persian', sample_en: 'A call in English',
  how_title: 'How it works',
  how1_t: 'Sign up in 15 minutes', how1_d: 'Enter your opening hours, services and prices.',
  how2_t: 'Try it', how2_d: 'You get a number and hear your own receptionist.',
  how3_t: 'Connect your line', how3_d: 'When you are busy or do not answer, calls go to the receptionist.',
  features_title: 'What it does',
  f1: 'Everyday spoken Persian and British English; it detects which one the caller speaks',
  f2: 'Books, moves and cancels appointments, never over your capacity',
  f3: 'Text confirmation for the customer and a summary of every call on Telegram for you',
  f4: 'Puts the caller through to you when needed',
  f5: 'A Persian panel on your phone: bookings, calls, messages',
  pricing_title: 'Pricing', pricing_note: 'Monthly prices, ex VAT. The first 14 days are free. Cancel any time.',
  plan_minutes: '{n} minutes a month', plan_overage: 'Extra minutes {p} each', plan_trial: '14-day free trial',
  per_month: '/month',
  signup_title: 'Start free', s_business: 'Business name', s_type: 'Type of business', s_owner: 'Your name',
  s_phone: 'Mobile (we text you a sign-in code)', s_email: 'Email (optional)', s_submit: 'Sign up and get a code',
  s_privacy: 'By signing up you accept the terms and privacy policy (bottom of this page).',
  t_barber: 'Barber shop', t_salon: 'Hair salon', t_beauty: 'Beauty salon', t_restaurant: 'Restaurant', t_takeaway: 'Takeaway',
  t_clinic: 'Clinic', t_dental: 'Dental clinic', t_other: 'Other',
  code_sent: 'We texted you a 6-digit code.', s_code: 'Code', s_verify: 'Sign in and start setup',
  faq_title: 'Frequent questions',
  q1: 'Do callers know they are talking to an AI?', a1: 'Yes. At the start of the call it says it is an AI assistant and that the call is recorded; UK law expects transparency and so do we.',
  q2: 'What if a customer wants to talk to me?', a2: 'During the hours you choose it puts them through to you; outside those hours it takes a message and sends it to you on Telegram straight away.',
  q3: 'What do you do with my customers\' data?', a3: 'Under UK GDPR we are your data processor: we keep only what a booking needs, call transcripts are deleted after 90 days, and we never sell data.',
  q4: 'Does my number change?', a4: 'No. You switch on "forward when busy or unanswered" on your current line; the panel has a guide for each provider.',
  q5: 'How do I cancel?', a5: 'Any time, in the panel (Account -> Invoices and payment). No long contract.',
  q6: 'Does it cope with accents?', a6: 'It is designed for different Persian accents. If it does not understand something it asks again politely and never guesses a name, number or time.',
  contact_title: 'Another question?', c_name: 'Name', c_contact: 'Mobile or email', c_message: 'Message', c_send: 'Send',
  contact_ok: 'Thank you, we will get back to you soon.',
  privacy: 'Privacy: this site uses no tracking cookies. We only count visits, without identifying you. Call data is kept under our data processing agreement (DPA) and UK GDPR and deleted after 90 days.',
  err_bad_phone: 'That mobile number does not look right.', err_missing_fields: 'Please fill in the required fields.',
  err_rate_limited: 'Too many tries. Please wait a few minutes.', err_bad_code: 'Wrong code.', err_expired: 'The code has expired.',
  err_email_taken: 'That email is already registered.', err_generic: 'Something went wrong. Please try again.',
};
const FA = {
  plan_minutes: '{n} دقیقه در ماه', plan_overage: 'هر دقیقه اضافه {p}', plan_trial: '۱۴ روز رایگان', per_month: '/ ماه',
  contact_ok: 'ممنون، به‌زودی با شما تماس می‌گیریم.',
  err_bad_phone: 'شماره موبایل درست نیست.', err_missing_fields: 'لطفاً فیلدهای لازم را پر کنید.',
  err_rate_limited: 'درخواست زیاد بود. چند دقیقه دیگر امتحان کنید.', err_bad_code: 'کد اشتباه است.', err_expired: 'کد منقضی شده است.',
  err_email_taken: 'این ایمیل قبلاً ثبت شده.', err_generic: 'مشکلی پیش آمد. دوباره امتحان کنید.',
};

let lang = 'fa';
const original = new Map();
const faDigits = s => String(s).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const tr = (key, vars = {}) => {
  const s = (lang === 'en' ? EN : FA)[key] ?? EN[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (lang === 'fa' ? faDigits(vars[k]) : vars[k]));
};
const money = (minor, currency) => new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-GB', { style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(minor / 100);

function setLang(l) {
  lang = l;
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'fa' ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    if (!original.has(el)) original.set(el, el.textContent);
    el.textContent = l === 'en' ? EN[el.dataset.i18n] ?? original.get(el) : original.get(el);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', l === 'en' ? EN[el.dataset.i18nAria] : 'منو');
  const btn = document.getElementById('lang');
  btn.textContent = l === 'en' ? 'فارسی' : 'English';
  btn.lang = l === 'en' ? 'fa' : 'en';
  document.title = l === 'en' ? 'AI phone receptionist — Persian and English' : 'منشی تلفنی هوشمند — فارسی و انگلیسی';
  renderPlans();
}

async function api(path, body) {
  const r = await fetch(`/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw Object.assign(new Error(data.error || 'generic'), { code: data.error || 'generic' });
  return data;
}
const errText = e => tr(`err_${e.code}`) === `err_${e.code}` ? tr('err_generic') : tr(`err_${e.code}`);

let plans = [];
function renderPlans() {
  const box = document.getElementById('plans');
  box.replaceChildren(...plans.map(p => {
    const card = document.createElement('div');
    card.className = 'card plan';
    const name = document.createElement('h3');
    name.textContent = p.name;
    const price = document.createElement('b');
    price.className = 'price';
    price.textContent = `${money(p.monthly_price, p.currency)} ${tr('per_month')}`;
    const ul = document.createElement('ul');
    for (const line of [tr('plan_minutes', { n: p.included_minutes }), tr('plan_overage', { p: money(p.overage_per_min, p.currency) }), tr('plan_trial')]) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.append(li);
    }
    card.append(name, price, ul);
    return card;
  }));
}

async function init() {
  document.getElementById('lang').addEventListener('click', () => setLang(lang === 'fa' ? 'en' : 'fa'));
  if (new URLSearchParams(location.search).get('lang') === 'en') setLang('en');

  api('/public/event', { event: 'visit' }).catch(() => {});
  api('/public/plans').then(r => { plans = r.plans; renderPlans(); }).catch(() => {});
  api('/public/config').then(c => {
    if (!c.demo_number) return;
    const demo = document.getElementById('demo');
    demo.href = `tel:${c.demo_number}`;
    document.getElementById('demo-number').textContent = c.demo_number;
    demo.hidden = false;
    demo.addEventListener('click', () => api('/public/event', { event: 'demo_call' }).catch(() => {}));
  }).catch(() => {});

  // Audio samples are shown only once the recordings exist (web/audio/README.md).
  const audios = [...document.querySelectorAll('audio[data-src]')];
  Promise.all(audios.map(a => fetch(a.dataset.src, { method: 'HEAD' }).then(r => r.ok && (r.headers.get('content-type') || '').startsWith('audio')).catch(() => false)))
    .then(ok => {
      if (!ok.every(Boolean)) return;
      for (const a of audios) a.src = a.dataset.src;
      document.getElementById('samples').hidden = false;
    });

  const err = document.getElementById('signup-error');
  const signup = document.getElementById('signup-form');
  const codeForm = document.getElementById('code-form');
  let phone = '';
  signup.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const f = new FormData(signup);
    if (!f.get('business_name') || !f.get('owner_name') || !f.get('phone')) { err.textContent = tr('err_missing_fields'); return; }
    const btn = signup.querySelector('button');
    btn.disabled = true;
    try {
      phone = f.get('phone');
      await api('/public/signup', Object.fromEntries(f));
      signup.hidden = true;
      codeForm.hidden = false;
      codeForm.code.focus();
    } catch (x) {
      err.textContent = errText(x);
    } finally {
      btn.disabled = false;
    }
  });
  codeForm.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api('/auth/verify', { identifier: phone, code: codeForm.code.value.trim().replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)) });
      location.href = '/panel/#/onboarding';
    } catch (x) {
      err.textContent = errText(x);
    }
  });

  const contact = document.getElementById('contact-form');
  contact.addEventListener('submit', async e => {
    e.preventDefault();
    const status = document.getElementById('contact-status');
    try {
      await api('/public/contact', Object.fromEntries(new FormData(contact)));
      contact.reset();
      status.textContent = tr('contact_ok');
    } catch (x) {
      status.textContent = errText(x);
    }
  });
}

init();
