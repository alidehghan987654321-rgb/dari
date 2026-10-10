"use strict";
(() => {
  const el = id => document.getElementById(id);
  const number = value => new Intl.NumberFormat('fa-IR').format(value);
  let key = '';
  function rows(id, stats, labels) {
    el(id).replaceChildren();
    for (const [field, label] of labels) {
      const row = document.createElement('tr');
      for (const value of [label, number(stats.telegram[field]), number(stats.web[field])]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      el(id).append(row);
    }
  }
  async function load() {
    el('report').hidden = true;
    el('feedback').textContent = 'در حال دریافت آمار…';
    try {
      const response = await fetch('/api/admin/stats', { headers:{Authorization:`Bearer ${key}`}, cache:'no-store' });
      if (response.status === 401) throw new Error('کلید مدیریت صحیح نیست یا هنوز روی سرور تنظیم نشده است.');
      if (!response.ok) throw new Error('آمار در دسترس نیست. اتصال ذخیره‌سازی را بررسی و دوباره تلاش کنید.');
      const stats = await response.json();
      rows('users', stats, [['total_users','کل کاربران'],['active_24h','فعال در ۲۴ ساعت'],['active_30d','فعال در ۳۰ روز']]);
      rows('downloads', stats, [['requests','درخواست'],['completed','موفق'],['failed','ناموفق']]);
      el('visitors').textContent = `مرورگرهای بازدیدکننده: ${number(stats.web.visitors)}`;
      el('starts').textContent = `حساب‌هایی که /start زده‌اند: ${number(stats.telegram.starts)}`;
      el('groups').textContent = `گروه‌ها و کانال‌های دارای روبات: ${number(stats.telegram.active_groups_channels)}`;
      const plan = stats.subscription;
      el('threshold').textContent = `${number(stats.telegram.active_30d)} از ${number(plan.threshold)} کاربر فعال ماهانهٔ تلگرام. ${plan.ready_for_review ? 'هدف رسیده؛ زمان بررسی اشتراک است.' : 'هنوز در مرحلهٔ رشد رایگان.'}`;
      el('growth').value = stats.telegram.active_30d;
      el('estimate').textContent = `با پرداخت ماهانهٔ ۱ پوند توسط همهٔ کاربران فعال: ${number(plan.illustrative_gross_gbp)} پوند درآمد ناخالص فرضی در ماه.`;
      el('since').textContent = stats.recording_since ? `شروع ثبت: ${new Date(stats.recording_since*1000).toLocaleDateString('fa-IR')}` : 'هنوز فعالیتی ثبت نشده است.';
      el('report').hidden = false; el('login').hidden = true; el('feedback').textContent = '';
    } catch (error) { el('feedback').textContent = error.message; el('login').hidden = false; }
  }
  el('login').addEventListener('submit', event => { event.preventDefault(); key=el('token').value; el('token').value=''; load(); });
  el('refresh').addEventListener('click', load);
  el('logout').addEventListener('click', () => { key=''; el('report').hidden=true; el('login').hidden=false; el('feedback').textContent=''; });
})();
