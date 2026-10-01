// Panel text. Persian first; English toggle. Keys are grouped by screen.

const fa = {
  app_name: 'پنل منشی',
  loading: 'در حال بارگذاری…',
  error_generic: 'مشکلی پیش آمد. دوباره تلاش کنید.',
  offline: 'اتصال اینترنت برقرار نیست.',
  save: 'ذخیره',
  saved: 'ذخیره شد',
  cancel: 'انصراف',
  close: 'بستن',
  add: 'افزودن',
  remove: 'حذف',
  yes: 'بله',
  no: 'خیر',
  minutes_short: 'دقیقه',

  // login
  login_title: 'ورود به پنل منشی',
  login_hint: 'شماره موبایل یا ایمیلی که به ما داده‌اید را وارد کنید. یک کد ۶ رقمی برایتان می‌فرستیم.',
  identifier: 'موبایل یا ایمیل',
  send_code: 'ارسال کد',
  code: 'کد ۶ رقمی',
  code_sent_sms: 'کد با پیامک فرستاده شد.',
  code_sent_email: 'کد به ایمیل شما فرستاده شد.',
  verify: 'ورود',
  change_identifier: 'تغییر شماره یا ایمیل',
  err_bad_identifier: 'شماره یا ایمیل درست نیست.',
  err_rate_limited: 'درخواست زیاد بود. چند دقیقه بعد دوباره امتحان کنید.',
  err_bad_code: 'کد اشتباه است.',
  err_expired: 'کد منقضی شده. یک کد جدید بگیرید.',
  err_too_many_attempts: 'تلاش‌ها زیاد بود. یک کد جدید بگیرید.',

  // nav
  nav_today: 'امروز',
  nav_bookings: 'نوبت‌ها',
  nav_calls: 'تماس‌ها',
  nav_messages: 'پیام‌ها',
  nav_settings: 'تنظیمات',
  nav_account: 'حساب',
  choose_business: 'انتخاب کسب‌وکار',
  sync_banner: 'تغییرات بعد از هماهنگی تیم روی منشی تلفنی اعمال می‌شود.',

  // today
  today_bookings: 'نوبت‌های امروز',
  no_bookings_today: 'امروز نوبتی ثبت نشده.',
  calls_today: 'تماس امروز',
  unread_messages: 'پیام خوانده‌نشده',
  minutes_used: 'دقیقه مصرف این ماه',
  of_plan: 'از {n} دقیقه پلن',
  call_customer: 'تماس با {name}',

  // bookings
  day_view: 'روز',
  week_view: 'هفته',
  prev: 'قبلی',
  next: 'بعدی',
  today: 'امروز',
  new_booking: 'نوبت جدید',
  walk_in: 'نوبت حضوری یا تلفنی',
  service: 'خدمت',
  date: 'تاریخ',
  time: 'ساعت',
  customer_name: 'نام مشتری',
  customer_phone: 'موبایل مشتری (اختیاری)',
  notes: 'یادداشت (اختیاری)',
  send_sms: 'پیامک تأیید برای مشتری',
  pick_time: 'یک ساعت انتخاب کنید',
  no_slots: 'این روز وقت خالی ندارد.',
  book: 'ثبت نوبت',
  move: 'جابه‌جایی',
  move_to: 'جابه‌جایی به',
  cancel_booking: 'لغو نوبت',
  confirm_cancel: 'این نوبت لغو شود؟',
  notify_customer: 'به مشتری پیامک بده',
  status_cancelled: 'لغو شده',
  source_phone_ai: 'منشی AI',
  source_panel: 'پنل',
  no_bookings: 'نوبتی نیست.',
  err_slot_taken: 'این ساعت دیگر خالی نیست.',
  err_closed: 'کسب‌وکار این روز تعطیل است.',
  err_past_date: 'این تاریخ گذشته است.',
  err_too_far: 'این تاریخ خیلی دور است.',
  err_bad_phone: 'شماره موبایل درست نیست.',
  err_missing_name: 'نام مشتری را وارد کنید.',

  // calls
  no_calls: 'هنوز تماسی ثبت نشده.',
  duration: 'مدت',
  language: 'زبان',
  outcome: 'نتیجه',
  summary: 'خلاصه',
  transcript: 'متن مکالمه',
  transcript_deleted: 'متن مکالمه طبق سیاست نگهداری داده حذف شده است.',
  recording: 'صدای تماس',
  hidden_number: 'شماره پنهان',
  lang_fa: 'فارسی',
  lang_en: 'انگلیسی',
  success: 'موفق',
  failure: 'ناموفق',
  unknown: 'نامشخص',
  booking_made: 'نوبت ثبت شد',
  callback_needed: 'نیاز به تماس',
  agent: 'منشی',
  caller: 'تماس‌گیرنده',
  back: 'بازگشت',

  // messages
  no_messages: 'پیامی نیست.',
  urgent: 'فوری',
  mark_done: 'انجام شد',
  mark_open: 'برگرداندن',
  show_all: 'نمایش همه',
  show_open: 'فقط باز',
  call_back: 'تماس',

  // settings
  opening_hours: 'ساعت کاری',
  closed: 'تعطیل',
  open_from: 'از',
  open_to: 'تا',
  add_range: 'افزودن بازه',
  closed_dates: 'روزهای تعطیل خاص',
  add_date: 'افزودن تاریخ',
  services: 'خدمات',
  name_fa: 'نام فارسی',
  name_en: 'نام انگلیسی',
  duration_min: 'مدت (دقیقه)',
  price: 'قیمت',
  add_service: 'افزودن خدمت',
  capacity: 'ظرفیت هم‌زمان (چند نفر هم‌زمان خدمت می‌دهند)',
  policies: 'قوانین',
  add_policy: 'افزودن قانون',
  faq: 'سؤال‌های پرتکرار',
  question: 'سؤال',
  answer: 'جواب',
  add_faq: 'افزودن سؤال',
  transfer: 'انتقال تماس',
  transfer_number: 'شماره برای انتقال تماس',
  transfer_hours: 'ساعت‌های انتقال تماس',
  read_only: 'فقط صاحب کسب‌وکار می‌تواند تنظیمات را تغییر دهد.',
  err_invalid: 'بعضی فیلدها درست نیستند.',
  days: { mon: 'دوشنبه', tue: 'سه‌شنبه', wed: 'چهارشنبه', thu: 'پنجشنبه', fri: 'جمعه', sat: 'شنبه', sun: 'یکشنبه' },

  // account
  plan: 'پلن',
  no_plan: 'دوره آزمایشی',
  usage: 'مصرف این دوره',
  invoices: 'فاکتورها و پرداخت',
  invoices_soon: 'به‌زودی',
  users: 'کاربران',
  add_user: 'افزودن کاربر',
  name: 'نام',
  phone: 'موبایل',
  email: 'ایمیل (اختیاری)',
  role: 'نقش',
  role_owner: 'صاحب کسب‌وکار',
  role_staff: 'کارمند',
  role_superadmin: 'تیم پشتیبانی',
  preferences: 'تنظیمات نمایش',
  ui_language: 'زبان پنل',
  persian_digits: 'اعداد فارسی',
  logout: 'خروج',
  err_exists: 'این شماره یا ایمیل قبلاً ثبت شده.',
  err_cannot_remove_self: 'نمی‌توانید خودتان را حذف کنید.',
};

const en = {
  app_name: 'Receptionist panel',
  loading: 'Loading…',
  error_generic: 'Something went wrong. Please try again.',
  offline: 'You are offline.',
  save: 'Save',
  saved: 'Saved',
  cancel: 'Cancel',
  close: 'Close',
  add: 'Add',
  remove: 'Remove',
  yes: 'Yes',
  no: 'No',
  minutes_short: 'min',

  login_title: 'Sign in to your receptionist panel',
  login_hint: 'Enter the mobile number or email you gave us. We will send you a 6-digit code.',
  identifier: 'Mobile or email',
  send_code: 'Send code',
  code: '6-digit code',
  code_sent_sms: 'We texted you a code.',
  code_sent_email: 'We emailed you a code.',
  verify: 'Sign in',
  change_identifier: 'Use another number or email',
  err_bad_identifier: 'That number or email does not look right.',
  err_rate_limited: 'Too many requests. Please try again in a few minutes.',
  err_bad_code: 'Wrong code.',
  err_expired: 'The code has expired. Ask for a new one.',
  err_too_many_attempts: 'Too many tries. Ask for a new code.',

  nav_today: 'Today',
  nav_bookings: 'Bookings',
  nav_calls: 'Calls',
  nav_messages: 'Messages',
  nav_settings: 'Settings',
  nav_account: 'Account',
  choose_business: 'Choose a business',
  sync_banner: 'Changes go live on the phone after the team syncs them.',

  today_bookings: "Today's bookings",
  no_bookings_today: 'No bookings today.',
  calls_today: 'calls today',
  unread_messages: 'unread messages',
  minutes_used: 'minutes used this month',
  of_plan: 'of {n} in your plan',
  call_customer: 'Call {name}',

  day_view: 'Day',
  week_view: 'Week',
  prev: 'Previous',
  next: 'Next',
  today: 'Today',
  new_booking: 'New booking',
  walk_in: 'Walk-in or phone booking',
  service: 'Service',
  date: 'Date',
  time: 'Time',
  customer_name: 'Customer name',
  customer_phone: 'Customer mobile (optional)',
  notes: 'Notes (optional)',
  send_sms: 'Text the customer a confirmation',
  pick_time: 'Pick a time',
  no_slots: 'No free times that day.',
  book: 'Book',
  move: 'Move',
  move_to: 'Move to',
  cancel_booking: 'Cancel booking',
  confirm_cancel: 'Cancel this booking?',
  notify_customer: 'Text the customer',
  status_cancelled: 'Cancelled',
  source_phone_ai: 'AI receptionist',
  source_panel: 'Panel',
  no_bookings: 'No bookings.',
  err_slot_taken: 'That time is no longer free.',
  err_closed: 'The business is closed that day.',
  err_past_date: 'That date is in the past.',
  err_too_far: 'That date is too far ahead.',
  err_bad_phone: 'That mobile number is not valid.',
  err_missing_name: 'Enter the customer name.',

  no_calls: 'No calls yet.',
  duration: 'Duration',
  language: 'Language',
  outcome: 'Outcome',
  summary: 'Summary',
  transcript: 'Transcript',
  transcript_deleted: 'The transcript was deleted under the data retention policy.',
  recording: 'Recording',
  hidden_number: 'Hidden number',
  lang_fa: 'Persian',
  lang_en: 'English',
  success: 'Success',
  failure: 'Failed',
  unknown: 'Unknown',
  booking_made: 'Booking made',
  callback_needed: 'Call back needed',
  agent: 'Receptionist',
  caller: 'Caller',
  back: 'Back',

  no_messages: 'No messages.',
  urgent: 'Urgent',
  mark_done: 'Done',
  mark_open: 'Reopen',
  show_all: 'Show all',
  show_open: 'Open only',
  call_back: 'Call',

  opening_hours: 'Opening hours',
  closed: 'Closed',
  open_from: 'From',
  open_to: 'To',
  add_range: 'Add hours',
  closed_dates: 'Special closed days',
  add_date: 'Add date',
  services: 'Services',
  name_fa: 'Persian name',
  name_en: 'English name',
  duration_min: 'Duration (min)',
  price: 'Price',
  add_service: 'Add service',
  capacity: 'Capacity (how many people serve at the same time)',
  policies: 'Policies',
  add_policy: 'Add policy',
  faq: 'Frequent questions',
  question: 'Question',
  answer: 'Answer',
  add_faq: 'Add question',
  transfer: 'Call transfer',
  transfer_number: 'Number to transfer calls to',
  transfer_hours: 'Transfer hours',
  read_only: 'Only the business owner can change settings.',
  err_invalid: 'Some fields are not valid.',
  days: { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' },

  plan: 'Plan',
  no_plan: 'Trial',
  usage: 'Usage this period',
  invoices: 'Invoices and payment',
  invoices_soon: 'Coming soon',
  users: 'Users',
  add_user: 'Add user',
  name: 'Name',
  phone: 'Mobile',
  email: 'Email (optional)',
  role: 'Role',
  role_owner: 'Owner',
  role_staff: 'Staff',
  role_superadmin: 'Support team',
  preferences: 'Display',
  ui_language: 'Panel language',
  persian_digits: 'Persian digits',
  logout: 'Sign out',
  err_exists: 'That number or email is already registered.',
  err_cannot_remove_self: 'You cannot remove yourself.',
};

const DICTS = { fa, en };
let current = 'fa';
let persianDigits = true;

export function setLang(l) {
  current = l === 'en' ? 'en' : 'fa';
  document.documentElement.lang = current;
  document.documentElement.dir = current === 'fa' ? 'rtl' : 'ltr';
}
export const lang = () => current;
export function setDigits(d) { persianDigits = d !== 'latn'; }
const useFaDigits = () => current === 'fa' && persianDigits;

/** Translate a key; {name} placeholders are filled from vars. Unknown keys fall back to English, then the key. */
export function t(key, vars = {}) {
  const s = DICTS[current][key] ?? en[key] ?? key;
  return typeof s === 'string' ? s.replace(/\{(\w+)\}/g, (_, k) => num(vars[k] ?? '')) : s;
}

/** Digits in the user's chosen style. */
export function num(v) {
  const s = String(v);
  return useFaDigits() ? s.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]) : s;
}

function locale() {
  return current === 'fa' ? `fa-IR-u-ca-gregory-nu-${useFaDigits() ? 'arabext' : 'latn'}` : 'en-GB';
}

/** 'YYYY-MM-DD' -> "سه‌شنبه ۶ اکتبر" / "Tue 6 Oct" (Gregorian: appointments are in UK dates). */
export function fmtDate(iso, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** SQLite/ISO timestamp (UTC) -> local date and time in the business timezone. */
export function fmtDateTime(ts, timeZone) {
  const d = new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat(locale(), { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

export function fmtMoney(amount, currency) {
  return new Intl.NumberFormat(locale(), { style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(amount);
}
