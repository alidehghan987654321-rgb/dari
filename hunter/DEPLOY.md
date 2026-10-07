# آنلاین کردن شکارچی

دو راه هست:

- **Cloudflare** (پیشنهادی): سرور لازم نیست. سایت روی **https://hunter.gryffin.uk** بالا میاد، مثل ربات که روی
  `dl.gryffin.uk` هست.
- **یه سرور مجازی (VPS)** با Docker: از بخش «۱. سرور کجا باشه؟» به بعد.

## روی Cloudflare: hunter.gryffin.uk

ساختار:

- یه Worker روی `hunter.gryffin.uk` هر درخواست رو به یه کانتینر می‌ده که از
  `hunter/deploy/Dockerfile.cloudflare` ساخته شده (`cloudflare/hunter.jsonc` و `cloudflare/src/hunter.ts`).
- Cloudflare رکورد DNS و گواهی HTTPS رو خودش می‌سازه.
- **دیتابیس در R2 نگه داشته میشه.** دیسک کانتینر با هر بار خوابیدن یا به‌روزرسانی پاک میشه، پس
  [Litestream](https://litestream.io) دیتابیس رو لحظه‌به‌لحظه در باکت R2 به اسم `hunter-db` می‌نویسه و موقع روشن
  شدن برمی‌گردونه. ۳۰ روز تاریخچه هم نگه می‌داره.
- **شکار روزانه** با cron خود Cloudflare، ساعت ۰۱:۰۰ UTC (۴:۳۰ صبح تهران)، کانتینر رو بیدار می‌کنه.
- کانتینر بعد از ۲ ساعت بی‌کاری می‌خوابه. اولین بازدید بعد از خواب چند ثانیه طول می‌کشه.
- هر تغییری که در کد هیونتر به گیت‌هاب برسه، GitHub Actions تست می‌کنه و دوباره مستقر می‌کنه
  (`.github/workflows/deploy-hunter.yml`).

### کارهای یک‌باره

اگه این‌ها رو برای ربات انجام دادی، مرحله‌ی ۱ تا ۳ تکراریه؛ فقط مطمئن شو توکن دسترسی R2 داره.

1. **پلن Workers Paid** (ماهی حدود ۵ دلار؛ Containers بدون اون کار نمی‌کنه): در
   [dash.cloudflare.com](https://dash.cloudflare.com) ← **Workers & Pages** ← **Plans**.
2. **API Token:** عکس پروفایل ← **My Profile** ← **API Tokens** ← **Create Token** ← قالب
   **Edit Cloudflare Workers** ← **Use template**. با **+ Add more** این‌ها رو اضافه کن:
   - Account ← **Containers** ← Edit
   - Zone ← **DNS** ← Edit
   - Zone ← **Zone** ← Read

   در **Zone Resources** دامنه‌ی `gryffin.uk` رو انتخاب کن و توکن رو بساز و کپی کن. دسترسی **Workers R2 Storage ←
   Edit** توی همین قالب هست و برای دیتابیس لازمه؛ پاکش نکن.
3. **Account ID:** در صفحه‌ی **Workers & Pages**، سمت راست.
4. **Secretها در گیت‌هاب:** مخزن ← **Settings** ← **Secrets and variables** ← **Actions** ←
   **New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = توکن مرحله‌ی ۲
   - `CLOUDFLARE_ACCOUNT_ID` = شناسه‌ی مرحله‌ی ۳
   - `HUNTER_ENV` (اختیاری): تنظیمات سایت، هر خط یه `اسم=مقدار`، مثل `.env`. فقط `HUNTER_*`، `KEEPA_*`،
     `APIFY_*`، `ZARINPAL_*` و `ANTHROPIC_*` خونده میشن. مثلاً:

     ```
     HUNTER_ADMINS=you@example.com
     HUNTER_ADMIN_TOKEN=یه-رمز-تصادفی-حداقل-۲۴-حرفی
     KEEPA_API_KEY=...
     APIFY_TOKEN=...
     HUNTER_TEMU_ACTOR=...
     HUNTER_1688_IMAGE_ACTOR=...
     ZARINPAL_MERCHANT_ID=...
     HUNTER_TOMAN_PER_USD=255000
     ```

     `HUNTER_ADMINS` ایمیل(های) مدیره و `HUNTER_ADMIN_TOKEN` رمز مدیر شدن (بسازش با
     `python -c "import secrets; print(secrets.token_urlsafe(32))"`). با همون ایمیل ثبت‌نام کن، در **حساب من**
     کادر «ورود مدیر سایت» میاد؛ رمز رو بزن. فقط ایمیل کافی نیست، چون هر کسی می‌تونه با هر ایمیلی ثبت‌نام کنه.
     بعد از مدیر شدن `HUNTER_ADMIN_TOKEN` رو از `HUNTER_ENV` پاک کن. چون روی Cloudflare خط فرمان نداری، فعال
     کردن اشتراک فروشنده‌ها از **حساب من ← مدیریت** انجام میشه.
5. **اجرا:** مخزن ← **Actions** ← **Deploy the hunter to Cloudflare** ← **Run workflow**. بار اول چند دقیقه طول
   می‌کشه. بعد https://hunter.gryffin.uk باز میشه. خلاصه‌ی اجرا نشون می‌ده دیتابیس در R2 هست یا نه، و کلید داده
   داری یا نه.

### نکته‌ها

- **بدون کلید داده** سایت شکار نمونه رو نشون می‌ده. با اضافه شدن Keepa یا Apify به `HUNTER_ENV` و اجرای دوباره،
  اولین شکار زنده همون موقع شروع میشه.
- **هر تغییر `HUNTER_ENV`:** دوباره **Run workflow** بزن.
- **اگه خلاصه‌ی اجرا گفت «Database kept in R2: no»:** توکن دسترسی R2 نداره و با هر ری‌استارت داده‌ها پاک میشن.
  یا دسترسی **Workers R2 Storage ← Edit** رو به توکن بده، یا در R2 ← **Manage API tokens** یه توکن Object Read &
  Write برای باکت `hunter-db` بساز و `R2_ACCESS_KEY_ID` و `R2_SECRET_ACCESS_KEY` رو به Secretها اضافه کن.
- **لاگ‌ها:** Cloudflare ← **Workers & Pages** ← `hunter` ← **Logs**.
- **آدرس دیگه:** `hunter.gryffin.uk` رو در `cloudflare/hunter.jsonc` (دو جا) عوض کن.
- **هزینه:**
  - پلن Workers Paid
  - زمان روشن بودن کانتینر (نوع `basic`: ربع هسته، ۱ گیگ رم)
  - R2، که برای این اندازه در سهم رایگانش جا می‌گیره

  قیمت‌های روز در صفحه‌ی Pricing خود Cloudflare هست.
- **زرین‌پال:** درخواست‌ها از آی‌پی‌های Cloudflare به زرین‌پال می‌رن. قبل از افتتاح، با `ZARINPAL_SANDBOX=1` یه
  پرداخت آزمایشی بزن (مرحله‌ی ۱ پایین).

---

## ۱. سرور کجا باشه؟

**بیرون از ایران.** Keepa، Apify و API هوش مصنوعی از آی‌پی ایران جواب نمی‌دن. پیشنهاد:

- یه VPS لینوکسی (Ubuntu 22.04 یا 24.04) در آلمان، فنلاند، هلند، ترکیه یا امارات
- ۲ هسته، ۲ تا ۴ گیگ رم و ۴۰ گیگ دیسک، که حدود ۵ تا ۲۰ دلار در ماه میشه

دو چیز رو قبل از خرید سرور چک کن:

- **زرین‌پال:** برای فعال شدن merchant، احراز هویت، ثبت دامنه و معمولاً اینماد لازمه. بعضی درگاه‌های ایرانی
  درخواست از آی‌پی خارج رو رد می‌کنن. پس اول با `ZARINPAL_SANDBOX=1`، از همون سرور، یه پرداخت آزمایشی بزن
  (مرحله‌ی ۵). اگه رد شد، با پشتیبانی زرین‌پال درباره‌ی آی‌پی سرور صحبت کن.
- **دسترسی از ایران:** سایت رو از داخل ایران، هم با اینترنت همراه و هم ثابت، باز کن. بعضی دیتاسنترها از ایران
  کند یا فیلترن.
- **اسم فارسی با Claude اختیاریه:** قبل از فعال کردنش، شرایط استفاده و کشورهای پشتیبانی‌شده‌ی Anthropic رو
  بخون. بدون اون هم سایت کامل کار می‌کنه.

## ۲. دامنه

یه زیردامنه انتخاب کن (مثلاً `shop.example.com`) و یه رکورد **A** به آی‌پی سرور بده. اگه DNS دست Cloudflareه،
«Proxy status» رو روی **DNS only** بذار تا Caddy بتونه گواهی HTTPS بگیره.

## ۳. نصب با یه دستور

روی سرور با کاربر root:

```bash
curl -fsSL https://raw.githubusercontent.com/alidehghan987654321-rgb/dari/refs/heads/claude/trusting-cori-54e2u9/hunter/deploy/install.sh | bash
```

این اسکریپت:

1. Docker و git رو نصب می‌کنه.
2. کد رو در `/opt/hunter` می‌ذاره.
3. دامنه رو می‌پرسه و `.env` رو می‌سازه.
4. سایت، شکار روزانه و HTTPS رو بالا میاره.
5. اگه هنوز کلید داده نداری، شکار نمونه رو می‌ذاره تا سایت خالی نباشه.

اجرای دوباره‌اش کد رو به‌روز می‌کنه و به تنظیمات و داده‌ها دست نمی‌زنه. بعد از ادغام PR، اگه شاخه عوض شد:
`HUNTER_BRANCH=main bash install.sh`.

نصب دستی (همون کار، قدم‌به‌قدم):

```bash
git clone -b claude/trusting-cori-54e2u9 https://github.com/alidehghan987654321-rgb/dari.git /opt/hunter
cd /opt/hunter && cp .env.example .env && nano .env      # HUNTER_DOMAIN و HUNTER_PUBLIC_URL=https://...
docker compose -f docker-compose.hunter.yml up -d --build
```

## ۴. مدیر سایت

روی سایت ثبت‌نام کن، بعد:

```bash
cd /opt/hunter
docker compose -f docker-compose.hunter.yml exec site python -m hunter make-admin you@example.com
```

فعال کردن دستی یه فروشنده (مثلاً بعد از کارت‌به‌کارت):

```bash
docker compose -f docker-compose.hunter.yml exec site python -m hunter grant seller@example.com --days 30 --plan pro
```

## ۵. کلیدها و درگاه

همه در `/opt/hunter/.env` (توضیح هر کدوم در همون فایل و در [README](README.md)):

| چی | متغیر |
|---|---|
| آدرس سایت | `HUNTER_DOMAIN=shop.example.com` و `HUNTER_PUBLIC_URL=https://shop.example.com` |
| آمازون | `KEEPA_API_KEY` |
| Temu و 1688 | `APIFY_TOKEN` و `HUNTER_TEMU_ACTOR`، `HUNTER_1688_IMAGE_ACTOR`، `HUNTER_1688_DETAIL_ACTOR`، … |
| درگاه | `ZARINPAL_MERCHANT_ID`، اول با `ZARINPAL_SANDBOX=1` |
| نرخ دلار | `HUNTER_TOMAN_PER_USD`؛ قیمت پلن‌ها و ماشین‌حساب از این حساب میشن |
| ساعت شکار روزانه | `HUNTER_HUNT_AT=01:00` (به وقت UTC؛ یعنی ۴:۳۰ صبح تهران) |

بعد از هر تغییر:

```bash
docker compose -f docker-compose.hunter.yml up -d
```

در پنل زرین‌پال، دامنه‌ی سایت رو ثبت کن. خریدار بعد از پرداخت به `https://دامنه/pay/callback` برمی‌گرده.
**`HUNTER_PAYMENT` هیچ‌وقت روی سرور واقعی `demo` نباشه.**

## ۶. شکار روزانه و پشتیبان

سرویس `hunt` هر روز سر ساعت `HUNTER_HUNT_AT` شکار می‌کنه و بعد از دیتابیس پشتیبان می‌گیره. پشتیبان‌ها در
`/data/backups` داخل volume هستن و ۱۴ تای آخر نگه داشته میشن.

```bash
cd /opt/hunter
docker compose -f docker-compose.hunter.yml exec site python -m hunter hunt      # همین الان یه شکار
docker compose -f docker-compose.hunter.yml exec site python -m hunter backup    # همین الان یه پشتیبان
docker compose -f docker-compose.hunter.yml cp site:/data/backups ./backups      # کپی پشتیبان‌ها بیرون از Docker
```

هر هفته یه نسخه از پشتیبان‌ها رو بیرون از سرور هم نگه دار. برگردوندن یه پشتیبان:

```bash
docker compose -f docker-compose.hunter.yml exec site python -m hunter restore /data/backups/hunter-20261001-010000.db
```

## ۷. به‌روزرسانی

```bash
cd /opt/hunter && git pull && docker compose -f docker-compose.hunter.yml up -d --build
```

یا همون دستور نصب رو دوباره اجرا کن. آدرس فایل‌های CSS و JS با هر نسخه عوض میشه، پس مرورگر فروشنده‌ها نسخه‌ی
قدیمی رو نگه نمی‌داره.

## ۸. سلامت و لاگ‌ها

- `https://دامنه/healthz` باید `{"ok": true, ...}` بده. `last_hunt` تاریخ آخرین شکاره؛ اگه چند روزه عوض نشده،
  لاگ `hunt` رو ببین.
- لاگ‌ها:

  ```bash
  docker compose -f docker-compose.hunter.yml logs -f site
  docker compose -f docker-compose.hunter.yml logs -f hunt
  ```

- برای خبردار شدن از قطعی، یه سرویس مانیتورینگ رایگان (مثل UptimeRobot) رو روی `/healthz` بذار.

## ۹. امنیت (خودکار انجام شده)

- HTTPS با تمدید خودکار.
- کوکی ورود فقط روی اتصال امن، با `HttpOnly` و `SameSite`.
- هدرهای امنیتی: CSP، `X-Frame-Options`، `nosniff` و HSTS وقتی آدرس https باشه.
- محدودیت تلاش برای ورود، بر اساس آی‌پی واقعی کاربر (از Caddy).
- برنامه داخل Docker با کاربر غیر root اجرا میشه، و پورت سایت فقط از طریق Caddy در دسترسه.

کارهایی که با خودته:

- `.env` رو به کسی نده.
- فقط پورت‌های ۲۲، ۸۰ و ۴۴۳ رو باز بذار.
- ورود SSH رو با کلید انجام بده.

## ۱۰. چک‌لیست قبل از افتتاح

- [ ] `https://دامنه` باز میشه و `/healthz` جواب `ok` می‌ده.
- [ ] خودت مدیر شدی (مرحله‌ی ۴).
- [ ] پرداخت آزمایشی sandbox از همین سرور موفق شد؛ بعد `ZARINPAL_SANDBOX` رو خالی کردی.
- [ ] `HUNTER_PAYMENT=zarinpal` (نه `demo`).
- [ ] برای GitHub، Cloudflare، زرین‌پال و ایمیل پشتیبانی ورود دومرحله‌ای (2FA) روشنه.
- [ ] `HUNTER_ADMIN_TOKEN` بعد از مدیر شدن خالی شده.
- [ ] یه شکار زنده با کلیدهای واقعی انجام شد (اول با `--categories home_kitchen --per-category 5`) و عددهاش
      منطقیه.
- [ ] نرخ دلار (`HUNTER_TOMAN_PER_USD`) به‌روزه.
- [ ] سایت از داخل ایران، با موبایل و اینترنت ثابت، باز میشه.
- [ ] قوانین، حریم خصوصی و راه تماس روی سایت هست. اینماد گرفتی.
- [ ] یه نسخه‌ی پشتیبان بیرون از سرور داری.

## عیب‌یابی

| مشکل | راه |
|---|---|
| گواهی HTTPS گرفته نمیشه | رکورد A به آی‌پی همین سرور باشه، پورت ۸۰ و ۴۴۳ باز باشه، و در Cloudflare «DNS only» باشه. لاگ: `logs caddy` |
| صفحه‌ی 502 | سرویس `site` بالا نیست؛ `logs site` رو ببین. |
| شکار خالیه | کلیدهای Keepa یا Apify درست نیستن؛ `logs hunt` رو ببین. |
| درگاه خطا می‌ده | merchant ID، دامنه‌ی ثبت‌شده در زرین‌پال و آی‌پی سرور (مرحله‌ی ۱) رو چک کن. |
