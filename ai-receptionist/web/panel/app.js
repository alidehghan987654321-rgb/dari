// Owner panel (M3). Vanilla JS, no build step. Hash routes: #/today #/bookings #/calls #/call/<id>
// #/messages #/settings #/account #/login. All data comes from /api on the same origin (session cookie).
// User data is only ever inserted as text (never innerHTML).

import { t, setLang, setDigits, lang, num, fmtDate, fmtDateTime, fmtMoney } from './i18n.js';

const S = { user: null, business: null, businesses: [], bizId: store('bizId'), unread: 0 };
const app = document.getElementById('app');

// ---------------- utilities ----------------

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* private mode: fine */ }
  return null;
}

/** replaceChildren that skips null/false (optional blocks). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
}

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'required', 'hidden']);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const ICONS = {
  today: 'M8 2v3M16 2v3M3.5 9h17M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
  bookings: 'M4 6h16M4 12h16M4 18h10',
  calls: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  messages: 'M4 5h16v11H8l-4 4V5Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

class ApiError extends Error {
  constructor(code, data) { super(code); this.code = code; this.data = data; }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (S.user?.role === 'superadmin' && S.bizId) headers['x-business-id'] = S.bizId;
  let r;
  try {
    r = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('offline');
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/auth/')) {
    S.user = null;
    location.hash = '#/login';
    throw new ApiError('unauthorized');
  }
  if (!r.ok || data.ok === false) throw new ApiError(data.error || 'error_generic', data);
  return data;
}

function errText(e) {
  const code = e?.code || 'error_generic';
  if (code === 'offline') return t('offline');
  const key = `err_${code}`;
  return t(key) === key ? t('error_generic') : t(key);
}

let toastTimer;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3000);
}

const time = hhmm => num(hhmm);
// Times and ranges are left-to-right even inside Persian text, and never wrap.
const range = (a, b) => h('bdi', { dir: 'ltr', class: 'nowrap' }, `${time(a)}–${time(b)}`);
const duration = secs => `${num(Math.floor((secs || 0) / 60))}:${num(String((secs || 0) % 60).padStart(2, '0'))}`;
const serviceName = b => (lang() === 'fa' ? b.service_fa : b.service_en);
const tz = () => S.business?.timezone || 'Europe/London';
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date());
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const telLink = (phone, label) => h('a', { class: 'btn icon', href: `tel:${phone}`, 'aria-label': label }, icon('phone'));

// ---------------- shell ----------------

const TABS = [['today', 'nav_today'], ['bookings', 'nav_bookings'], ['calls', 'nav_calls'], ['messages', 'nav_messages'], ['settings', 'nav_settings'], ['account', 'nav_account']];

function shell(active) {
  const header = h('header', { class: 'topbar' }, h('h1', {}, S.business?.name || t('app_name')));
  if (S.user.role === 'superadmin') {
    const sel = h('select', {
      'aria-label': t('choose_business'),
      onchange: async e => { S.bizId = e.target.value; store('bizId', S.bizId); await loadBusiness(); render(); },
    }, h('option', { value: '' }, t('choose_business')), S.businesses.map(b => h('option', { value: b.id, selected: b.id === S.bizId }, b.name)));
    header.append(sel);
  }
  const nav = h('nav', { class: 'tabbar', 'aria-label': t('app_name') },
    TABS.map(([id, key]) => h('a', { href: `#/${id}`, 'aria-current': id === active ? 'page' : null },
      icon(id), h('span', {}, t(key)),
      id === 'messages' && S.unread ? h('span', { class: 'badge', 'aria-label': `${num(S.unread)} ${t('unread_messages')}` }, num(S.unread)) : null)));
  const main = h('main', { id: 'main', tabindex: '-1' }, h('p', { class: 'muted' }, t('loading')));
  fill(app, 
    header,
    S.business?.message_only ? h('div', { class: 'banner danger', role: 'alert' }, t(`message_only_${S.business.message_only_reason || 'hard_cap'}`)) : null,
    S.business?.needs_sync ? h('div', { class: 'banner', role: 'note' }, t('sync_banner')) : null,
    main,
    nav,
  );
  return main;
}

// ---------------- boot & routing ----------------

async function loadBusiness() {
  const me = await api('GET', '/me');
  S.user = me.user;
  S.business = me.business;
  setLang(S.user.prefs.lang || 'fa');
  setDigits(S.user.prefs.digits || 'fa');
}

async function boot() {
  try {
    await loadBusiness();
    if (S.user.role === 'superadmin') {
      S.businesses = (await api('GET', '/businesses')).businesses;
      if (S.bizId && !S.businesses.some(b => b.id === S.bizId)) { S.bizId = null; store('bizId', null); }
      if (!S.bizId && S.businesses.length) { S.bizId = S.businesses[0].id; store('bizId', S.bizId); }
      if (S.bizId) await loadBusiness();
    }
    if (!location.hash || location.hash === '#/login') location.hash = '#/today';
    else render();
  } catch (e) {
    if (e.code !== 'unauthorized') renderLogin();
  }
}

const SCREENS = { today: screenToday, bookings: screenBookings, calls: screenCalls, call: screenCall, messages: screenMessages, settings: screenSettings, account: screenAccount };

async function render() {
  const [route, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, arg] = route.split('/');
  const params = new URLSearchParams(query);
  if (params.get('checkout') === 'success') setTimeout(() => toast(t('checkout_success')), 300);
  if (name === 'login' || !S.user) return renderLogin();
  const screen = SCREENS[name] || screenToday;
  const main = shell(name === 'call' ? 'calls' : (SCREENS[name] ? name : 'today'));
  if (!S.business) { fill(main, h('p', { class: 'empty' }, t('choose_business'))); return; }
  try {
    await screen(main, arg ? decodeURIComponent(arg) : undefined);
  } catch (e) {
    if (e.code !== 'unauthorized') fill(main, h('p', { class: 'error', role: 'alert' }, errText(e)));
  }
}

window.addEventListener('hashchange', () => render());

// ---------------- login ----------------

function renderLogin() {
  setLang(lang());
  let identifier = '';
  const error = h('p', { class: 'error', role: 'alert', 'aria-live': 'assertive' });
  const step1 = h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      error.textContent = '';
      identifier = e.target.identifier.value.trim();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        const r = await api('POST', '/auth/request-code', { identifier });
        step1.hidden = true;
        step2.hidden = false;
        sentNote.textContent = t(r.channel === 'email' ? 'code_sent_email' : 'code_sent_sms');
        step2.code.focus();
      } catch (err) {
        error.textContent = errText(err);
      } finally {
        btn.disabled = false;
      }
    },
  },
  h('div', { class: 'field' }, h('label', { for: 'identifier' }, t('identifier')),
    h('input', { id: 'identifier', name: 'identifier', type: 'text', inputmode: 'email', autocomplete: 'username', required: true, dir: 'ltr' })),
  h('button', { class: 'btn primary block', type: 'submit' }, t('send_code')));

  const sentNote = h('p', { class: 'muted', 'aria-live': 'polite' });
  const step2 = h('form', {
    class: 'stack', hidden: true,
    onsubmit: async e => {
      e.preventDefault();
      error.textContent = '';
      try {
        await api('POST', '/auth/verify', { identifier, code: e.target.code.value.trim() });
        S.user = null;
        location.hash = '#/today';
        await boot();
      } catch (err) {
        error.textContent = errText(err);
      }
    },
  },
  sentNote,
  h('div', { class: 'field' }, h('label', { for: 'code' }, t('code')),
    h('input', { id: 'code', name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9۰-۹]{6}', maxlength: '6', required: true, dir: 'ltr' })),
  h('button', { class: 'btn primary block', type: 'submit' }, t('verify')),
  h('button', { class: 'btn block', type: 'button', onclick: () => { step2.hidden = true; step1.hidden = false; } }, t('change_identifier')));

  const langToggle = h('button', { class: 'btn', type: 'button', onclick: () => { setLang(lang() === 'fa' ? 'en' : 'fa'); renderLogin(); } }, lang() === 'fa' ? 'English' : 'فارسی');
  fill(app, h('main', { class: 'login' },
    h('div', { class: 'row' }, h('span', { class: 'spacer' }), langToggle),
    h('h1', {}, t('login_title')), h('p', { class: 'muted' }, t('login_hint')), step1, step2, error));
}

// ---------------- today ----------------

function bookingItem(b, onClick) {
  return h('li', { class: `item${b.status === 'cancelled' ? ' cancelled' : ''}` },
    h('div', { class: 'time' }, time(b.time)),
    h('button', {
      class: 'body item-btn', type: 'button', onclick: onClick,
      'aria-label': `${time(b.time)} ${b.customer_name} ${serviceName(b)}`,
    },
    h('div', { class: 'title' }, b.customer_name),
    h('div', { class: 'small muted' }, serviceName(b), ' · ', range(b.time, b.end)),
    h('div', { class: 'row small' },
      b.status === 'cancelled' ? h('span', { class: 'pill danger' }, t('status_cancelled')) : null,
      h('span', { class: 'pill' }, t(`source_${b.source}`)),
      b.notes ? h('span', { class: 'muted' }, b.notes) : null)),
    b.customer_phone && b.status !== 'cancelled' ? telLink(b.customer_phone, t('call_customer', { name: b.customer_name })) : null);
}

function usageBlock(u, bare = false) {
  if (!u) return null;
  const used = u.minutes_used || 0;
  const included = u.included_minutes;
  const pct = included ? Math.min(100, Math.round((100 * used) / included)) : 0;
  return h('div', { class: bare ? 'stack' : 'card stack' },
    h('div', { class: 'row' }, h('b', {}, num(used)), h('span', { class: 'muted' }, t('minutes_used')),
      h('span', { class: 'spacer' }), included ? h('span', { class: 'small muted' }, t('of_plan', { n: included })) : null),
    included ? h('div', { class: `meter${used > included ? ' over' : ''}`, role: 'meter', 'aria-valuenow': used, 'aria-valuemin': 0, 'aria-valuemax': included, 'aria-label': t('minutes_used') },
      h('div', { style: `width:${pct}%` })) : null);
}

async function screenToday(main) {
  const d = await api('GET', '/today');
  S.unread = d.unread_messages;
  const active = d.bookings.filter(b => b.status === 'confirmed');
  fill(main, 
    h('div', { class: 'stats' },
      h('a', { class: 'stat', href: '#/bookings' }, h('b', {}, num(active.length)), h('span', {}, t('nav_bookings'))),
      h('a', { class: 'stat', href: '#/calls' }, h('b', {}, num(d.calls_today)), h('span', {}, t('calls_today'))),
      h('a', { class: 'stat', href: '#/messages' }, h('b', {}, num(d.unread_messages)), h('span', {}, t('unread_messages')))),
    h('div', { class: 'row' }, h('h2', {}, t('today_bookings'), ' · ', fmtDate(d.date)), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => bookingDialog({ date: d.date }) }, '+ ', t('new_booking'))),
    d.bookings.length
      ? h('ul', { class: 'list' }, d.bookings.map(b => bookingItem(b, () => bookingActions(b))))
      : h('p', { class: 'empty' }, t('no_bookings_today')),
    h('h2', {}, t('usage')),
    usageBlock(d.usage),
  );
  const badge = document.querySelector('.tabbar a[href="#/messages"]');
  if (badge && S.unread && !badge.querySelector('.badge')) badge.append(h('span', { class: 'badge' }, num(S.unread)));
}

// ---------------- bookings ----------------

const B = { view: 'day', from: null };

async function screenBookings(main) {
  B.from ||= todayLocal();
  const days = B.view === 'week' ? 7 : 1;
  const d = await api('GET', `/bookings?from=${B.from}&days=${days}`);
  const shift = n => { B.from = addDays(B.from, n * days); render(); };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('nav_bookings') },
    ['day', 'week'].map(v => h('button', { type: 'button', 'aria-pressed': String(B.view === v), onclick: () => { B.view = v; render(); } }, t(`${v}_view`))));
  const groups = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(B.from, i);
    const list = d.bookings.filter(b => b.date === date);
    if (days === 1 || list.length) {
      groups.push(h('section', { class: 'day-block' },
        h('h2', {}, fmtDate(date)),
        list.length ? h('ul', { class: 'list' }, list.map(b => bookingItem(b, () => bookingActions(b)))) : h('p', { class: 'muted' }, t('no_bookings'))));
    }
  }
  fill(main, 
    h('div', { class: 'row wrap' }, seg, h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => bookingDialog({ date: B.from }) }, '+ ', t('new_booking'))),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn', onclick: () => shift(-1) }, lang() === 'fa' ? '→ ' : '← ', t('prev')),
      h('button', { class: 'btn', onclick: () => { B.from = todayLocal(); render(); } }, t('today')),
      h('button', { class: 'btn', onclick: () => shift(1) }, t('next'), lang() === 'fa' ? ' ←' : ' →')),
    groups.length ? groups : h('p', { class: 'empty' }, t('no_bookings')),
  );
}

function openDialog(content) {
  const dlg = h('dialog', { 'aria-modal': 'true' }, content);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** Slot picker: loads free times for service+date and lets the user pick one. */
function slotPicker({ getService, getDate, exclude }, onPick) {
  const box = h('div', { class: 'slots', role: 'group', 'aria-label': t('pick_time') });
  const note = h('p', { class: 'muted small', 'aria-live': 'polite' });
  let chosen = null;
  async function load() {
    chosen = null;
    onPick(null);
    fill(box);
    note.textContent = t('loading');
    try {
      const q = new URLSearchParams({ service_id: getService(), date: getDate() });
      if (exclude) q.set('exclude', exclude);
      const { slots } = await api('GET', `/availability?${q}`);
      note.textContent = slots.length ? t('pick_time') : t('no_slots');
      fill(box, ...[...slots].sort().map(s => h('button', {
        type: 'button', 'aria-pressed': 'false',
        onclick: e => {
          box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false'));
          e.currentTarget.setAttribute('aria-pressed', 'true');
          chosen = s;
          onPick(s);
        },
      }, time(s))));
    } catch (err) {
      note.textContent = errText(err);
    }
  }
  return { el: h('div', {}, note, box), load, value: () => chosen };
}

function bookingDialog({ date }) {
  const services = S.business.services || [];
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn primary block', type: 'submit', disabled: true }, t('book'));
  const svc = h('select', { id: 'f-service', name: 'service', required: true },
    services.map(s => h('option', { value: s.id }, lang() === 'fa' ? s.name_fa : s.name_en, ` · ${num(s.duration_min)} ${t('minutes_short')}`)));
  const dateIn = h('input', { id: 'f-date', type: 'date', value: date, required: true });
  const picker = slotPicker({ getService: () => svc.value, getDate: () => dateIn.value }, s => { submit.disabled = !s; });
  svc.addEventListener('change', picker.load);
  dateIn.addEventListener('change', picker.load);
  const phone = h('input', { id: 'f-phone', name: 'phone', type: 'tel', autocomplete: 'off', dir: 'ltr' });
  const sms = h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'sms' }), t('send_sms'));

  const form = h('form', {
    method: 'dialog', class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await api('POST', '/bookings', {
          service_id: svc.value, date: dateIn.value, time: picker.value(), customer_name: form.name.value,
          customer_phone: phone.value || undefined, notes: form.notes.value || undefined, send_sms: form.sms.checked, language: lang(),
        });
        dlg.close();
        toast(t('saved'));
        render();
      } catch (err) {
        error.textContent = errText(err);
        if (err.code === 'slot_taken') picker.load(); else submit.disabled = false;
      }
    },
  },
  h('h2', {}, t('walk_in')),
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'f-service' }, t('service')), svc),
    h('div', {}, h('label', { for: 'f-date' }, t('date')), dateIn)),
  picker.el,
  h('div', { class: 'field' }, h('label', { for: 'f-name' }, t('customer_name')), h('input', { id: 'f-name', name: 'name', required: true, autocomplete: 'off' })),
  h('div', { class: 'field' }, h('label', { for: 'f-phone' }, t('customer_phone')), phone),
  h('div', { class: 'field' }, h('label', { for: 'f-notes' }, t('notes')), h('input', { id: 'f-notes', name: 'notes', autocomplete: 'off' })),
  sms, error, submit,
  h('button', { class: 'btn block', type: 'button', onclick: () => dlg.close() }, t('cancel')));
  const dlg = openDialog(form);
  picker.load();
}

function bookingActions(b) {
  if (b.status !== 'confirmed') return;
  const error = h('p', { class: 'error', role: 'alert' });
  const notify = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!b.customer_phone, disabled: !b.customer_phone }), t('notify_customer'));
  const dateIn = h('input', { id: 'm-date', type: 'date', value: b.date });
  const moveBtn = h('button', { class: 'btn primary block', type: 'button', disabled: true }, t('move'));
  const picker = slotPicker({ getService: () => b.service_id, getDate: () => dateIn.value, exclude: b.id }, s => { moveBtn.disabled = !s; });
  dateIn.addEventListener('change', picker.load);
  const notifyOn = () => notify.querySelector('input').checked;

  moveBtn.addEventListener('click', async () => {
    error.textContent = '';
    try {
      await api('POST', `/bookings/${b.id}/move`, { date: dateIn.value, time: picker.value(), notify: notifyOn() });
      dlg.close(); toast(t('saved')); render();
    } catch (err) { error.textContent = errText(err); }
  });
  const cancelBtn = h('button', {
    class: 'btn danger block', type: 'button',
    onclick: async () => {
      if (!confirm(t('confirm_cancel'))) return;
      try {
        await api('POST', `/bookings/${b.id}/cancel`, { notify: notifyOn() });
        dlg.close(); toast(t('saved')); render();
      } catch (err) { error.textContent = errText(err); }
    },
  }, t('cancel_booking'));

  const dlg = openDialog(h('div', { class: 'sheet stack' },
    h('h2', {}, b.customer_name),
    h('p', {}, serviceName(b), h('br'), fmtDate(b.date), ' · ', range(b.time, b.end)),
    b.customer_phone ? h('p', {}, h('a', { href: `tel:${b.customer_phone}`, dir: 'ltr' }, b.customer_phone)) : null,
    h('h3', {}, t('move_to')),
    h('div', {}, h('label', { for: 'm-date' }, t('date')), dateIn),
    picker.el, moveBtn,
    h('hr'),
    notify, cancelBtn, error,
    h('button', { class: 'btn block', type: 'button', onclick: () => dlg.close() }, t('close'))));
  picker.load();
}

// ---------------- calls ----------------

const langPill = l => (l ? h('span', { class: 'pill' }, t(l === 'fa' ? 'lang_fa' : l === 'en' ? 'lang_en' : 'unknown')) : null);
const outcomePill = s => h('span', { class: `pill ${s === 'success' ? 'accent' : s === 'failure' ? 'danger' : ''}` }, t(s === 'success' || s === 'failure' ? s : 'unknown'));

async function screenCalls(main) {
  const { calls } = await api('GET', '/calls?limit=50');
  fill(main, 
    h('h2', {}, t('nav_calls')),
    calls.length
      ? h('ul', { class: 'list' }, calls.map(c => h('li', {}, h('a', { class: 'item', href: `#/call/${encodeURIComponent(c.id)}` },
        h('div', { class: 'body' },
          h('div', { class: 'row' }, h('span', { class: 'title', dir: 'ltr' }, c.caller && c.caller !== 'hidden' ? c.caller : t('hidden_number')),
            h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, fmtDateTime(c.created_at, tz()))),
          h('div', { class: 'row small' }, h('span', {}, duration(c.duration_secs)), langPill(c.language), outcomePill(c.success),
            c.booking_made === true || c.booking_made === 'true' ? h('span', { class: 'pill accent' }, t('booking_made')) : null),
          c.summary ? h('div', { class: 'small muted', dir: 'auto' }, c.summary.length > 140 ? `${c.summary.slice(0, 140)}…` : c.summary) : null)))))
      : h('p', { class: 'empty' }, t('no_calls')));
}

async function screenCall(main, id) {
  const { call: c } = await api('GET', `/calls/${encodeURIComponent(id)}`);
  const audioSrc = `/api/calls/${encodeURIComponent(c.id)}/audio${S.user.role === 'superadmin' ? `?b=${encodeURIComponent(S.bizId)}` : ''}`;
  fill(main, 
    h('a', { href: '#/calls', class: 'btn' }, lang() === 'fa' ? '→ ' : '← ', t('back')),
    h('h2', { dir: 'auto' }, c.caller && c.caller !== 'hidden' ? c.caller : t('hidden_number')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row wrap small' }, h('span', {}, fmtDateTime(c.created_at, tz())), h('span', {}, t('duration'), ': ', duration(c.duration_secs)), langPill(c.language), outcomePill(c.success)),
      c.summary ? h('div', {}, h('b', {}, t('summary'), ': '), h('bdi', { dir: 'auto' }, c.summary)) : null,
      c.caller && c.caller !== 'hidden' ? h('a', { class: 'btn', href: `tel:${c.caller}` }, icon('phone'), t('call_back')) : null),
    c.audio ? h('section', {}, h('h3', {}, t('recording')), h('audio', { controls: true, preload: 'none', src: audioSrc, style: 'width:100%' })) : null,
    h('h3', {}, t('transcript')),
    c.transcript?.length
      ? h('div', { class: 'transcript' }, c.transcript.map(m => h('div', { class: `bubble ${m.role === 'agent' ? 'agent' : 'user'}`, dir: 'auto' },
        h('span', { class: 'sr-only' }, t(m.role === 'agent' ? 'agent' : 'caller'), ': '), m.message)))
      : h('p', { class: 'muted' }, t('transcript_deleted')));
}

// ---------------- messages ----------------

const M = { all: false };

async function screenMessages(main) {
  const { messages } = await api('GET', `/messages?status=${M.all ? 'all' : 'open'}`);
  if (!M.all) S.unread = messages.length;
  fill(main, 
    h('div', { class: 'row' }, h('h2', {}, t('nav_messages')), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { M.all = !M.all; render(); } }, t(M.all ? 'show_open' : 'show_all'))),
    messages.length
      ? h('ul', { class: 'list' }, messages.map(m => h('li', { class: `item${m.done_at ? ' cancelled' : ''}` },
        h('div', { class: 'body' },
          h('div', { class: 'row' }, h('span', { class: 'title' }, m.caller_name || t('caller')),
            m.urgency === 'urgent' ? h('span', { class: 'pill danger' }, t('urgent')) : null,
            h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, fmtDateTime(m.created_at, tz()))),
          h('p', { dir: 'auto', style: 'margin:4px 0' }, m.message),
          h('div', { class: 'row' },
            m.caller_phone ? h('a', { class: 'btn', href: `tel:${m.caller_phone}` }, icon('phone'), t('call_back')) : null,
            h('button', {
              class: 'btn',
              onclick: async () => { await api('POST', `/messages/${m.id}/done`, { done: !m.done_at }); render(); },
            }, t(m.done_at ? 'mark_open' : 'mark_done')))))))
      : h('p', { class: 'empty' }, t('no_messages')));
}

// ---------------- settings ----------------

const DAY_KEYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

function slug(s) {
  const base = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return base.length >= 2 ? base : `service-${Math.random().toString(36).slice(2, 7)}`;
}

async function screenSettings(main) {
  const res = await api('GET', '/settings');
  const draft = structuredClone(res.settings);
  draft.opening_hours ||= {};
  draft.closed_dates ||= [];
  draft.policies ||= [];
  draft.faq ||= [];
  const existingIds = new Set(draft.services.map(s => s.id));
  const error = h('p', { class: 'error', role: 'alert' });
  const sections = h('div');

  const input = (id, label, value, onInput, attrs = {}) => h('div', { class: 'field' },
    h('label', { for: id }, label),
    h('input', { id, value: value ?? '', oninput: e => onInput(e.target.value), ...attrs }));

  function draw() {
    let n = 0;
    const uid = p => `${p}-${n++}`;
    fill(sections, 
      h('section', { class: 'card' }, h('h2', {}, t('opening_hours')),
        DAY_KEYS.map(day => {
          const ranges = draft.opening_hours[day] ||= [];
          return h('div', { class: 'day-block' },
            h('div', { class: 'row' }, h('b', {}, t('days')[day]), h('span', { class: 'spacer' }),
              ranges.length ? null : h('span', { class: 'muted small' }, t('closed')),
              h('button', { type: 'button', class: 'btn', onclick: () => { ranges.push(['10:00', '18:00']); draw(); } }, '+ ', t('add_range'))),
            ranges.map((r, i) => {
              const a = uid('from'), b = uid('to');
              return h('div', { class: 'editor-row' },
                h('div', {}, h('label', { for: a }, t('open_from')), h('input', { id: a, type: 'time', value: r[0], oninput: e => { r[0] = e.target.value; } })),
                h('div', {}, h('label', { for: b }, t('open_to')), h('input', { id: b, type: 'time', value: r[1], oninput: e => { r[1] = e.target.value; } })),
                h('button', { type: 'button', class: 'btn danger', 'aria-label': `${t('remove')} ${t('days')[day]}`, onclick: () => { ranges.splice(i, 1); draw(); } }, '✕'));
            }));
        })),

      h('section', { class: 'card', style: 'margin-top:12px' }, h('h2', {}, t('closed_dates')),
        draft.closed_dates.map((d, i) => {
          const id = uid('cd');
          return h('div', { class: 'editor-row', style: 'grid-template-columns:1fr auto' },
            h('div', {}, h('label', { for: id, class: 'sr-only' }, t('date')), h('input', { id, type: 'date', value: d, oninput: e => { draft.closed_dates[i] = e.target.value; } })),
            h('button', { type: 'button', class: 'btn danger', 'aria-label': t('remove'), onclick: () => { draft.closed_dates.splice(i, 1); draw(); } }, '✕'));
        }),
        h('button', { type: 'button', class: 'btn', style: 'margin-top:8px', onclick: () => { draft.closed_dates.push(todayLocal()); draw(); } }, '+ ', t('add_date'))),

      h('section', { class: 'card', style: 'margin-top:12px' }, h('h2', {}, t('services')),
        draft.services.map((s, i) => h('div', { class: 'day-block' },
          h('div', { class: 'grid2' },
            input(uid('sfa'), t('name_fa'), s.name_fa, v => { s.name_fa = v; }),
            input(uid('sen'), t('name_en'), s.name_en, v => { s.name_en = v; if (!existingIds.has(s.id)) s.id = slug(v); }, { dir: 'ltr' }),
            input(uid('sdur'), t('duration_min'), s.duration_min, v => { s.duration_min = Number(v); }, { type: 'number', min: '5', max: '480', step: '5', inputmode: 'numeric' }),
            input(uid('sprice'), `${t('price')} (${draft.currency})`, s.price, v => { s.price = Number(v); }, { type: 'number', min: '0', step: '0.5', inputmode: 'decimal' })),
          draft.services.length > 1
            ? h('button', { type: 'button', class: 'btn danger', style: 'margin-top:8px', onclick: () => { draft.services.splice(i, 1); draw(); } }, t('remove'))
            : null)),
        h('button', { type: 'button', class: 'btn', style: 'margin-top:8px', onclick: () => { draft.services.push({ id: slug(''), name_fa: '', name_en: '', duration_min: 30, price: 0 }); draw(); } }, '+ ', t('add_service'))),

      h('section', { class: 'card', style: 'margin-top:12px' },
        input('capacity', t('capacity'), draft.capacity, v => { draft.capacity = Number(v); }, { type: 'number', min: '1', max: '20', inputmode: 'numeric' })),

      h('section', { class: 'card', style: 'margin-top:12px' }, h('h2', {}, t('policies')),
        draft.policies.map((p, i) => {
          const id = uid('pol');
          return h('div', { class: 'editor-row', style: 'grid-template-columns:1fr auto' },
            h('div', {}, h('label', { for: id, class: 'sr-only' }, t('policies')), h('textarea', { id, dir: 'auto', oninput: e => { draft.policies[i] = e.target.value; } }, p)),
            h('button', { type: 'button', class: 'btn danger', 'aria-label': t('remove'), onclick: () => { draft.policies.splice(i, 1); draw(); } }, '✕'));
        }),
        h('button', { type: 'button', class: 'btn', style: 'margin-top:8px', onclick: () => { draft.policies.push(''); draw(); } }, '+ ', t('add_policy'))),

      h('section', { class: 'card', style: 'margin-top:12px' }, h('h2', {}, t('faq')),
        draft.faq.map((f, i) => h('div', { class: 'day-block' },
          input(uid('q'), t('question'), f.q, v => { f.q = v; }, { dir: 'auto' }),
          input(uid('a'), t('answer'), f.a, v => { f.a = v; }, { dir: 'auto' }),
          h('button', { type: 'button', class: 'btn danger', style: 'margin-top:8px', onclick: () => { draft.faq.splice(i, 1); draw(); } }, t('remove')))),
        h('button', { type: 'button', class: 'btn', style: 'margin-top:8px', onclick: () => { draft.faq.push({ q: '', a: '' }); draw(); } }, '+ ', t('add_faq'))),

      h('section', { class: 'card', style: 'margin-top:12px' }, h('h2', {}, t('plan_limit')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!draft.hard_cap, onchange: e => { draft.hard_cap = e.target.checked; } }), t('hard_cap')),
        h('p', { class: 'small muted' }, t('hard_cap_help'))),

      h('section', { class: 'card', style: 'margin-top:12px' }, h('h2', {}, t('transfer')),
        input('transfer-number', t('transfer_number'), draft.phone_for_transfer, v => { draft.phone_for_transfer = v; }, { type: 'tel', dir: 'ltr' }),
        input('transfer-hours', t('transfer_hours'), draft.transfer_hours, v => { draft.transfer_hours = v; }, { dir: 'auto' })),
    );
  }
  draw();

  const save = async e => {
    e.preventDefault();
    error.textContent = '';
    const body = {
      ...draft,
      opening_hours: Object.fromEntries(DAY_KEYS.map(d => [d, draft.opening_hours[d] || []])),
      closed_dates: draft.closed_dates.filter(Boolean),
      policies: draft.policies.map(p => p.trim()).filter(Boolean),
      faq: draft.faq.filter(f => f.q.trim() || f.a.trim()),
      currency: undefined,
    };
    try {
      await api('PUT', '/settings', body);
      S.business.needs_sync = true;
      toast(t('saved'));
      render();
    } catch (err) {
      error.textContent = err.code === 'invalid'
        ? `${t('err_invalid')} (${(err.data?.errors || []).map(x => x.field).join('، ')})`
        : errText(err);
      error.scrollIntoView({ block: 'center' });
    }
  };

  fill(main, h('form', { onsubmit: save },
    h('h2', {}, t('nav_settings')),
    res.can_edit ? null : h('p', { class: 'banner', role: 'note' }, t('read_only')),
    h('fieldset', { disabled: !res.can_edit, style: 'border:0;padding:0;margin:0' }, sections),
    error,
    res.can_edit ? h('button', { class: 'btn primary block', type: 'submit', style: 'margin-top:16px' }, t('save')) : null));
}

// ---------------- account ----------------

/** Owner-only billing actions (M6): start a subscription through Stripe Checkout, or open the Customer Portal. */
function billingBlock(b) {
  if (!b?.enabled) return h('div', { class: 'row' }, h('span', {}, t('invoices')), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, t('invoices_soon')));
  const error = h('p', { class: 'error', role: 'alert' });
  const go = async (path, body) => {
    error.textContent = '';
    try { location.href = (await api('POST', path, body)).url; } catch (err) { error.textContent = errText(err); }
  };
  return h('div', { class: 'stack' },
    b.can_checkout ? h('div', { class: 'stack' },
      h('h3', {}, t('choose_plan')),
      b.plans.map(p => h('div', { class: 'card stack' },
        h('div', { class: 'row wrap' }, h('b', {}, p.name), h('span', { class: 'spacer' }),
          h('b', {}, fmtMoney(p.monthly_price / 100, p.currency)), h('span', { class: 'muted small' }, t('per_month'))),
        h('div', { class: 'small muted' }, t('plan_minutes', { n: p.included_minutes }), ' · ', t('plan_overage', { p: fmtMoney(p.overage_per_min / 100, p.currency) })),
        h('button', { class: 'btn primary block', onclick: () => go('/billing/checkout', { plan_id: p.id }) }, t('subscribe'), ' — ', p.name)))) : null,
    b.cancel_at_period_end ? h('p', { class: 'banner', role: 'note' }, t('cancels_at_period_end')) : null,
    b.has_portal ? h('button', { class: 'btn block', onclick: () => go('/billing/portal', {}) }, t('invoices')) : null,
    error);
}

async function screenAccount(main) {
  const d = await api('GET', '/account');
  const u = d.usage;
  const prefs = S.user.prefs;
  const setPref = async p => {
    const r = await api('PUT', '/me/prefs', p);
    S.user.prefs = r.prefs;
    setLang(r.prefs.lang || 'fa');
    setDigits(r.prefs.digits || 'fa');
    render();
  };

  const userError = h('p', { class: 'error', role: 'alert' });
  const addUser = h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      userError.textContent = '';
      const f = e.target;
      try {
        await api('POST', '/users', { name: f.uname.value, phone: f.uphone.value || undefined, email: f.uemail.value || undefined, role: f.urole.value });
        toast(t('saved'));
        render();
      } catch (err) { userError.textContent = errText(err); }
    },
  },
  h('h3', {}, t('add_user')),
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'uname' }, t('name')), h('input', { id: 'uname', name: 'uname', required: true })),
    h('div', {}, h('label', { for: 'urole' }, t('role')), h('select', { id: 'urole', name: 'urole' },
      h('option', { value: 'staff' }, t('role_staff')), h('option', { value: 'owner' }, t('role_owner'))))),
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'uphone' }, t('phone')), h('input', { id: 'uphone', name: 'uphone', type: 'tel', dir: 'ltr' })),
    h('div', {}, h('label', { for: 'uemail' }, t('email')), h('input', { id: 'uemail', name: 'uemail', type: 'email', dir: 'ltr' }))),
  userError,
  h('button', { class: 'btn', type: 'submit' }, '+ ', t('add_user')));

  fill(main, 
    h('h2', {}, t('plan')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('b', {}, u?.plan?.name || t('no_plan')),
        u?.plan?.monthly_price != null ? h('span', { class: 'muted' }, fmtMoney(u.plan.monthly_price / 100, u.plan.currency)) : null,
        u?.status ? h('span', { class: `pill ${u.status === 'active' ? 'accent' : u.status === 'trial' ? '' : 'danger'}` }, t(`status_${u.status}`)) : null),
      usageBlock(u, true),
      billingBlock(d.billing)),

    d.users.length ? h('section', {},
      h('h2', {}, t('users')),
      h('ul', { class: 'list' }, d.users.map(x => h('li', { class: 'item' },
        h('div', { class: 'body' }, h('div', { class: 'title' }, x.name),
          h('div', { class: 'small muted', dir: 'ltr', style: 'text-align:start' }, [x.phone, x.email].filter(Boolean).join(' · ')),
          h('span', { class: 'pill' }, t(`role_${x.role}`))),
        x.id !== S.user.id ? h('button', {
          class: 'btn danger', 'aria-label': `${t('remove')} ${x.name}`,
          onclick: async () => { if (confirm(`${t('remove')} ${x.name}?`)) { await api('DELETE', `/users/${x.id}`); render(); } },
        }, t('remove')) : null))),
      h('div', { class: 'card', style: 'margin-top:12px' }, addUser)) : null,

    h('h2', {}, t('preferences')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('span', { id: 'ui-lang' }, t('ui_language')), h('span', { class: 'spacer' }),
        h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'ui-lang' },
          h('button', { type: 'button', lang: 'fa', 'aria-pressed': String(lang() === 'fa'), onclick: () => setPref({ lang: 'fa' }) }, 'فارسی'),
          h('button', { type: 'button', lang: 'en', 'aria-pressed': String(lang() === 'en'), onclick: () => setPref({ lang: 'en' }) }, 'English'))),
      lang() === 'fa' ? h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: (prefs.digits || 'fa') === 'fa', onchange: e => setPref({ digits: e.target.checked ? 'fa' : 'latn' }) }),
        t('persian_digits')) : null),

    h('button', {
      class: 'btn danger block', style: 'margin-top:24px',
      onclick: async () => { await api('POST', '/auth/logout', {}); S.user = null; location.hash = '#/login'; },
    }, t('logout')));
}

boot();
