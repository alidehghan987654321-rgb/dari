# منشی تلفنی AI دوزبانه — پکیج شروع

همه چیز برای ساختن نسخه اول، از صفر تا اولین تماس واقعی. طرح محصول، هزینه‌ها و نقشه راه در سند «منشی تلفنی AI دوزبانه — طرح محصول» است.

## ساختار پوشه

```
ai-receptionist/
├── README.md                         ← همین راهنما (مسیر صفر تا صد)
├── prompts/
│   ├── system_prompt.template.md     ← پرامپت اصلی منشی (قلب محصول)
│   ├── first_message.md              ← جمله خوشامد دوزبانه + اعلام AI و ضبط
│   ├── business_profile.example.json ← پروفایل نمونه یک آرایشگاه (برای هر مشتری یکی)
│   └── test_scenarios.md             ← ۲۴ سناریوی تست فارسی/انگلیسی + جدول نتیجه
├── config/
│   ├── tools.json                    ← تعریف ۶ ابزار وب‌هوک + ابزارهای سیستمی
│   ├── agent_template.json           ← قالب نسخه‌دار ایجنت ElevenLabs (M5)
│   └── agent_settings.md             ← تنظیمات پیشنهادی ایجنت (مدل، صدا، تایم‌اوت...)
├── shared/prompt-core.mjs            ← ساخت پرامپت بدون فایل‌خوانی (مشترک Worker و Node)
├── provisioning/cli.mjs              ← ساخت خودکار ایجنت از خط فرمان (M5)
├── scripts/
│   ├── build_prompt.mjs              ← ساخت پرامپت نهایی هر مشتری از پروفایلش
│   └── prompt.mjs                    ← منطق مشترک ساخت پرامپت (CLI، تست خودکار، ساخت ایجنت)
├── qa/                               ← تست خودکار مکالمه (M1): ۲۳ سناریو، گزارش دقت نوبت و اطلاعات ساختگی
├── web/index.html, site.js           ← صفحه فروش و ثبت‌نام (M8)
├── web/panel/                        ← پنل صاحب کسب‌وکار (M3) + ویزارد راه‌اندازی (M8)
├── worker/                           ← بک‌اند ابزارها روی Cloudflare Workers + D1 (تست‌شده)
│   ├── src/index.js                  ← مسیرها: نوبت، لغو، جابه‌جایی، پیام، وب‌هوک، ادمین
│   ├── src/lib.js                    ← منطق وقت خالی، ساعت UK، شماره تلفن، امضا
│   ├── src/notify.js                 ← تلگرام صاحب کار + پیامک Twilio
│   ├── migrations/                   ← جدول‌های دیتابیس (migration‌های شماره‌دار D1)
│   ├── wrangler.toml
│   └── test/                         ← تست‌های واحد + test/integration (روی wrangler dev با D1 محلی)
├── build-prompts/                    ← ۹ پرامپت ساخت ماژول‌های باقی‌مانده + master context (README داخلش)
└── docs/
    ├── onboarding_checklist.md       ← چک‌لیست راه‌اندازی هر مشتری جدید
    ├── compliance_pack.md            ← متن‌های GDPR، اطلاعیه حریم خصوصی، DPA
    └── sales_script.md               ← اسکریپت فروش حضوری/تلفنی به کسب‌وکارها
```

## مسیر صفر تا صد

### مرحله ۱ — حساب‌ها (روز ۱)

1. **ElevenLabs**: ثبت‌نام، پلن Creator یا Pro (دقیقه‌های ماهانه بیشتر). از Settings یک API key بسازید.
2. **Twilio**: ثبت‌نام، اضافه کردن اعتبار، خرید یک **شماره لوکال UK**. برای شماره UK باید آدرس/مدارک (Regulatory Bundle) ثبت شود؛ یکی دو روز طول می‌کشد، پس روز اول انجامش دهید.
3. **Cloudflare**: همان حساب Gryffin کافی است.
4. **ربات تلگرام**: با BotFather یک ربات بسازید (اعلان‌ها به صاحب کار). chat id صاحب کار را با پیام دادن به ربات و `getUpdates` بگیرید.

### مرحله ۲ — بک‌اند (روز ۱ تا ۳)

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create receptionist            # id را در wrangler.toml بگذارید
npm run db:init:remote                          # همه migration‌ها را اعمال می‌کند؛ بعد از هر به‌روزرسانی دوباره اجرا کنید
npx wrangler secret put TOOL_SECRET            # یک رشته تصادفی بلند
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put ELEVENLABS_WEBHOOK_SECRET   # بعد از ساخت webhook در ElevenLabs
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM            # شماره Twilio با فرمت +44...
npm test                                        # تست واحد
npm run test:integration                        # تست یکپارچه روی wrangler dev محلی (بدون حساب Cloudflare)
npm run deploy                                  # آدرس Worker را یادداشت کنید
```

ثبت پروفایل کسب‌وکار (بعد از ساخت ایجنت، `agent_id` را هم بگذارید):

```bash
jq '{agent_id:"AGENT_ID", profile:.}' ../prompts/business_profile.example.json \
 | curl -X PUT https://WORKER_URL/admin/businesses \
     -H "Authorization: Bearer ADMIN_SECRET" -H "content-type: application/json" -d @-
```

### مرحله ۳ — ساخت ایجنت در ElevenLabs (روز ۲)

1. Agents → Create agent → Blank.
2. **System prompt**: خروجی این دستور را بچسبانید:
   `node scripts/build_prompt.mjs prompts/business_profile.example.json`
3. **First message**: از `prompts/first_message.md`.
4. **Language**: English + additional language: Persian. ابزار سیستمی `language_detection` را روشن کنید.
5. **LLM، صدا و بقیه تنظیمات**: طبق `config/agent_settings.md`.
6. **Tools**: شش ابزار وب‌هوک را طبق `config/tools.json` اضافه کنید (آدرس Worker + هدر Authorization با TOOL_SECRET به‌صورت Secret). ابزارهای سیستمی `end_call`، `transfer_to_number`، `skip_turn` را روشن کنید.
7. **Analysis**: فیلدهای Data collection و Post-call webhook را طبق `agent_settings.md` تنظیم کنید.
8. در خود داشبورد با **Test AI agent** چند مکالمه فارسی و انگلیسی بزنید.

### مرحله ۴ — وصل کردن تلفن (روز ۳)

1. ElevenLabs → Phone Numbers → Import from Twilio (Account SID + Auth Token + شماره).
2. شماره را به ایجنت اختصاص دهید.
3. با موبایل به شماره زنگ بزنید؛ باید خوشامد دوزبانه را بشنوید.
4. برای مشتری واقعی: صاحب کسب‌وکار روی خط فعلی‌اش **Call forwarding when busy / no answer** را به شماره Twilio فعال می‌کند؛ شماره‌اش عوض نمی‌شود.

### مرحله ۵ — کیفیت فارسی (هفته ۴ و ۵)

اول تست خودکار: `cd qa && npm run qa` (راهنما: `qa/README.md`). بعد `prompts/test_scenarios.md` را با آدم‌های واقعی و لهجه‌های مختلف اجرا کنید. هر خطا → یک خط اصلاح در پرامپت یا پروفایل → تست دوباره. اسم‌هایی که بد تلفظ می‌شوند را در Pronunciation dictionary و کلمات کلیدی ASR اضافه کنید.

### مرحله ۶ — پایلوت و فروش (هفته ۶ تا ۸)

- `docs/onboarding_checklist.md` برای هر مشتری
- `docs/compliance_pack.md` قبل از روشن کردن شماره واقعی
- `docs/sales_script.md` برای جذب پایلوت‌ها

## مانیتورینگ و هشدار (M2)

تیم قبل از صاحب کسب‌وکار باخبر می‌شود که منشی خراب است.

- **راه‌اندازی**: ربات تلگرام را به گروه تیم اضافه کنید و chat id گروه را در `wrangler.toml` به‌صورت `TEAM_ALERT_CHAT_ID` بگذارید (یا `wrangler secret put TEAM_ALERT_CHAT_ID`). بعد `npm run db:init:remote` و `npm run deploy`.
- **لاگ**: هر فراخوانی ابزار یک خط JSON است: `{ts, business_id, tool, ok, error, ms}`، بدون اسم، شماره یا متن پیام. در داشبورد Cloudflare (Workers Logs) قابل جست‌وجوست. همین داده در جدول `tool_events` (۳۰ روز) ذخیره می‌شود.
- **قانون‌های هشدار** (هر ۵ دقیقه، به گروه تیم، هر هشدار حداکثر یک بار در ساعت، و پیام «Resolved» وقتی برطرف شد):
  - خطای سیستمی یک ابزار بیش از ۲۰٪ در ۱۵ دقیقه (حداقل ۵ فراخوانی). جواب‌های عادی مثل «وقت پر است» خطا حساب نمی‌شوند.
  - p95 زمان ابزارها بیش از ۲۵۰۰ میلی‌ثانیه در ۱۵ دقیقه
  - ۳ پیامک یا پیام تلگرام ناموفق در ۱۵ دقیقه
  - کسب‌وکاری که معمولاً روزی ۵ تماس یا بیشتر دارد، ۲۴ ساعت (با حداقل ۴ ساعت باز بودن) هیچ تماسی نداشته: احتمالاً call forwarding قطع است
  - دیتابیس جواب نمی‌دهد
  - تست روزانه ناموفق
- **تست روزانه** (۰۳:۱۷ UTC): برای هر کسب‌وکار فعال، `availability` و یک رزرو آزمایشی با `dry_run: true` (همه‌چیز چک می‌شود، چیزی ذخیره یا ارسال نمی‌شود).
- **وضعیت**: `GET /admin/health` (با ADMIN_SECRET): ۲۴ ساعت گذشته برای هر کسب‌وکار: تعداد تماس، نرخ خطای ابزار، p95، پیامک‌های ناموفق، نتیجه تست روزانه.
- کسب‌وکار تستی یا متوقف‌شده را با `"active": false` در `PUT /admin/businesses` از تست روزانه و هشدار سکوت خارج کنید.

## پنل صاحب کسب‌وکار (M3)

آدرس: `https://WORKER_URL/panel/` (همان Worker سرو می‌کند تا کوکی ورود first-party بماند). فارسی و راست‌به‌چپ، با دکمه انگلیسی، مناسب گوشی.

- **راه‌اندازی**:
  ```bash
  npx wrangler secret put SESSION_SECRET          # یک رشته تصادفی بلند (کلید HMAC کدها و نشست‌ها)
  npx wrangler secret put RESEND_API_KEY          # اختیاری: ورود با ایمیل (و EMAIL_FROM در vars)
  npx wrangler secret put ELEVENLABS_API_KEY      # اختیاری: پخش صدای تماس در پنل
  npm run db:init:remote && npm run deploy
  ```
- **ساخت کاربر اول** هر کسب‌وکار (یا عضو تیم با `"role": "superadmin"` بدون business_id):
  ```bash
  curl -X PUT https://WORKER_URL/admin/users -H "Authorization: Bearer ADMIN_SECRET" -H "content-type: application/json" \
    -d '{"business_id":"demo-barber-london","name":"Ali","phone":"07700900000","role":"owner"}'
  ```
  صاحب کار بعداً خودش از صفحه «حساب» کارمند اضافه می‌کند.
- **ورود**: کد ۶ رقمی با پیامک یا ایمیل، ۱۰ دقیقه اعتبار، حداکثر ۵ تلاش؛ بعد کوکی ۳۰ روزه (HttpOnly, Secure, SameSite=Lax). رمز عبور ندارد. درخواست کد برای هر شماره/ایمیل و هر IP محدود است.
- **صفحه‌ها**: امروز (نوبت‌ها، تماس‌ها، پیام‌های خوانده‌نشده، دقیقه مصرف)، نوبت‌ها (روز/هفته، نوبت حضوری، جابه‌جایی، لغو؛ همان منطق ظرفیت منشی AI)، تماس‌ها (خلاصه، متن، صدا)، پیام‌ها، تنظیمات (ساعت کاری، تعطیلی، خدمات و قیمت، ظرفیت، قوانین، سؤال‌ها، انتقال تماس)، حساب (پلن، کاربران، زبان، اعداد فارسی).
- **نقش‌ها**: `owner` همه‌چیز؛ `staff` فقط دفتر نوبت و تماس و پیام؛ `superadmin` (تیم ما) بین کسب‌وکارها جابه‌جا می‌شود. هر کاربر فقط داده کسب‌وکار خودش را می‌بیند (تست شده).
- **ذخیره تنظیمات** `profile_json` را عوض می‌کند و `needs_sync` را روشن می‌کند؛ منشی تلفنی (ابزارها) فوراً از ساعت/خدمات جدید استفاده می‌کند، ولی متن پرامپت ایجنت تا هماهنگی تیم (و بعداً خودکار با M5) قدیمی می‌ماند. پنل این را با یک بنر نشان می‌دهد.

## مصرف و سقف پلن (M4)

- **پلن‌ها** در جدول `plans` هستند (نه در کد): Basic ‏£۷۹ / ۳۰۰ دقیقه / ۲۵ پنی هر دقیقه اضافه، Pro ‏£۱۴۹ / ۶۰۰ دقیقه / ۲۰ پنی. قیمت‌ها موقت‌اند؛ با SQL عوض کنید. همه مبالغ به واحد خرد (پنی) با ارز ذخیره می‌شوند.
- **اشتراک** هر کسب‌وکار (تا وقتی Stripe در M6 خودکارش کند):
  ```bash
  curl -X PUT https://WORKER_URL/admin/subscriptions -H "Authorization: Bearer ADMIN_SECRET" -H "content-type: application/json" \
    -d '{"business_id":"demo-barber-london","plan_id":"basic","status":"trial","period_start":"2026-10-01","period_end":"2026-11-01"}'
  ```
- **شمارش**: هر تماس از وب‌هوک post-call یک ردیف در `usage` می‌سازد (تکرار وب‌هوک نادیده گرفته می‌شود)، با گرد کردن رو به بالا برای هر تماس (۶۱ ثانیه = ۲ دقیقه). پیامک‌ها به قطعه شمرده می‌شوند (فارسی UCS-2: ۷۰ کاراکتر، ۶۷ در هر قطعه).
- **قانون‌ها** (هر ساعت و بعد از هر تماس):
  - ۸۰٪ دقیقه‌ها: تلگرام + پیامک (یا ایمیل) به صاحب کار، یک بار در هر دوره
  - ۱۰۰٪: خبر به صاحب کار؛ منشی ادامه می‌دهد و اضافه حساب می‌شود، مگر صاحب کار در تنظیمات پنل «سقف مصرف» را روشن کرده باشد؛ آن‌وقت **حالت فقط‌پیام**
  - اشتراک `past_due` یا `paused`: بعد از ۳ روز مهلت، حالت فقط‌پیام. `cancelled`: فوراً
- **حالت فقط‌پیام**: منشی همچنان جواب می‌دهد ولی ابزارهای نوبت خطای `message_only` برمی‌گردانند و منشی پیام می‌گیرد. پرامپت ساخته‌شده هم یک بند «نوبت‌دهی متوقف است» دارد. پنل یک بنر قرمز نشان می‌دهد.
- **گزارش حاشیه سود**: `GET /admin/usage?period=YYYY-MM` درآمد (پلن + اضافه) در برابر هزینه تخمینی (صدا، LLM، تلفن، پیامک) برای هر کسب‌وکار. نرخ‌های هزینه در `COST_RATES` داخل `wrangler.toml` (موقت؛ از فاکتورهای واقعی به‌روز کنید).

## ساخت خودکار ایجنت (M5)

راه‌اندازی هر مشتری از ۲ ساعت کلیک در داشبورد ElevenLabs به یک دستور می‌رسد، و تغییر تنظیمات در پنل خودکار روی ایجنت زنده می‌نشیند.

- **یک بار**: در ElevenLabs یک post-call webhook با آدرس `https://WORKER_URL/webhooks/post-call` بسازید (secret آن همان `ELEVENLABS_WEBHOOK_SECRET` است) و id آن را بردارید. بعد:
  ```bash
  npx wrangler secret put ELEVENLABS_API_KEY
  # در wrangler.toml: WORKER_PUBLIC_URL، ELEVENLABS_POST_CALL_WEBHOOK_ID، ELEVENLABS_VOICES (id صدای انگلیسی و فارسی)
  npm run db:init:remote && npm run deploy
  export WORKER_URL=https://... ADMIN_SECRET=...
  node provisioning/cli.mjs setup               # secret ابزارها را در workspace ElevenLabs می‌سازد
  ```
- **هر مشتری جدید**:
  ```bash
  node provisioning/cli.mjs create --profile prompts/my-business.json --number +44XXXXXXXXXX   # شماره موجود در Twilio
  node provisioning/cli.mjs create --profile prompts/my-business.json --buy                    # خرید شماره جدید
  ```
  ایجنت با پرامپت ساخته‌شده، پیام خوشامد، فارسی و انگلیسی، صداها، LLM، شش ابزار وب‌هوک (با هدر Authorization از secret)، ابزارهای سیستمی، فیلدهای تحلیل، post-call webhook و نگهداری ۹۰ روزه ساخته می‌شود. اجرای دوباره ایجنت دوم نمی‌سازد.
- **شماره UK**: خرید خودکار به Regulatory Bundle تأییدشده در Twilio نیاز دارد (`TWILIO_BUNDLE_SID` و `TWILIO_ADDRESS_SID`). بدون آن، پیام خطای روشن می‌دهد؛ شماره را دستی بخرید و با `--number` وصل کنید.
- **همگام‌سازی**: ذخیره تنظیمات در پنل همان لحظه پرامپت ایجنت را به‌روز می‌کند. حالت فقط‌پیام (M4) هم خودکار روی پرامپت می‌رود. `node provisioning/cli.mjs sync <id> --force` برای همگام‌سازی دستی.
- **دستورهای دیگر**: `pause` / `resume` (فقط‌پیام به دست تیم؛ قانون‌های مصرف آن را برنمی‌دارند)، `delete` (ایجنت، ابزارها و اتصال شماره؛ خود شماره Twilio می‌ماند).
- **بررسی روزانه**: هر روز تنظیمات زنده هر ایجنت با چیزی که باید باشد مقایسه می‌شود و اختلاف (مثلاً ویرایش دستی در داشبورد) به گروه تیم گزارش می‌شود. ایجنت کسب‌وکارهایی که بیش از دوره نگهداری لغو شده‌اند حذف می‌شود.
- **تغییر قالب**: `config/agent_template.json` را عوض کنید و `template_version` را یکی بالا ببرید؛ همگام‌سازی بعدی همه ایجنت‌ها و ابزارها را به‌روز می‌کند.

## پرداخت با Stripe (M6)

صاحب کار بعد از ۱۴ روز آزمایش با کارت ماهانه پرداخت می‌کند؛ ما هیچ‌وقت اطلاعات کارت را نمی‌بینیم.

- **راه‌اندازی** (اول در حالت test):
  ```bash
  npx wrangler secret put STRIPE_SECRET_KEY        # sk_test_... بعداً sk_live_...
  # در داشبورد Stripe یک webhook به https://WORKER_URL/webhooks/stripe بسازید با رویدادهای:
  #   checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed, invoice.created
  npx wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_... همان webhook
  npm run db:init:remote && npm run deploy
  curl -X POST https://WORKER_URL/admin/stripe/setup -H "Authorization: Bearer ADMIN_SECRET"   # محصول و قیمت هر پلن
  ```
  Customer Portal را یک بار در داشبورد Stripe (Settings → Billing → Customer portal) فعال کنید.
- **پنل**: صفحه «حساب» دکمه «شروع اشتراک» برای هر پلن دارد (Stripe Checkout). روزهای باقی‌مانده آزمایش به Stripe منتقل می‌شود؛ آزمایش تمام‌شده تکرار نمی‌شود. «فاکتورها و پرداخت» Customer Portal را باز می‌کند (کارت، فاکتورها، لغو). فقط صاحب کار.
- **وب‌هوک**: امضا با Web Crypto چک می‌شود و هر رویداد فقط یک بار پردازش می‌شود. وضعیت اشتراک (آزمایشی، فعال، پرداخت معوق، متوقف، لغو) و دوره در جدول `subscriptions` به‌روز می‌شود؛ پرداخت ناموفق به صاحب کار پیامک و تلگرام می‌دهد و بعد از ۳ روز مهلت منشی فقط پیام می‌گیرد (M4). آزمایشی که بدون پرداخت تمام شود هم بعد از ۳ روز همین‌طور.
- **دقیقه اضافه**: موقع تمدید، Stripe یک فاکتور پیش‌نویس می‌سازد؛ دقیقه‌های اضافه دوره تمام‌شده (از جدول `usage` خودمان) یک بار به همان فاکتور اضافه می‌شود.
- **مالیات (VAT)**: `PRICES_INCLUDE_VAT` در `wrangler.toml` تعیین می‌کند قیمت‌ها با مالیات‌اند یا بدون. Checkout آدرس و شماره VAT کسب‌وکار را می‌گیرد. محاسبه خودکار مالیات روشن نیست تا وضعیت ثبت VAT ما مشخص شود (تصمیم تجاری).

## صفحه فروش و ثبت‌نام خودکار (M8)

صاحب کسب‌وکار ما را پیدا می‌کند، دمو را می‌شنود، ثبت‌نام می‌کند و با کمترین کمک ما منشی‌اش راه می‌افتد.

- **صفحه فروش**: `https://WORKER_URL/` (فارسی، با دکمه انگلیسی). جدول قیمت از جدول `plans` و شماره دمو از `DEMO_NUMBER` می‌آید. بدون کوکی ردیابی؛ فقط شمارش ناشناس بازدید. دو فایل نمونه صدا را در `web/audio/` بگذارید (راهنما: `web/audio/README.md`)؛ تا نباشند، بخش «بشنوید» نشان داده نمی‌شود. Lighthouse موبایل: Performance ۱۰۰ و LCP حدود ۰٫۹ ثانیه روی 4G شبیه‌سازی‌شده؛ Accessibility ۱۰۰.
- **ثبت‌نام**: نام کسب‌وکار، نام و موبایل → کسب‌وکار (غیرفعال تا پایان ویزارد)، حساب صاحب کار و ۱۴ روز آزمایشی ساخته می‌شود و کد ورود پیامک می‌شود.
- **ویزارد** (در پنل، خودکار بعد از اولین ورود): مشخصات کسب‌وکار ← ساعت کاری ← خدمات و قیمت ← قوانین و سؤال‌ها ← انتقال تماس ← انتخاب صدا ← بازبینی. هر مرحله اعتبارسنجی می‌شود و پایان ویزارد فقط با پروفایل کامل و پرامپت بدون جای خالی ممکن است.
- **تماس آزمایشی**: پایان ویزارد ایجنت آزمایشی را می‌سازد (M5) و یک شماره UK می‌خرد (Regulatory Bundle لازم است). اگر شماره نشد، تیم در تلگرام خبردار می‌شود و با `provisioning/cli.mjs` کار را تمام می‌کند. بعد راهنمای انتقال تماس برای EE، Vodafone، O2، Three، Virgin Mobile، BT و Virgin Media نشان داده می‌شود.
- **آزمایشی**: روز دهم پیامک و تلگرام یادآوری با آمار (تماس، نوبت، پیام). بعد از ۱۴ روز اشتراک از پنل (M6)؛ اگر پرداخت نشود، بعد از ۳ روز منشی فقط پیام می‌گیرد.
- **قیف فروش**: `GET /admin/funnel?days=30` → بازدید ← تماس با دمو ← ثبت‌نام ← پایان ویزارد ← تماس آزمایشی ← روشن کردن انتقال ← پرداخت، با درصد تبدیل هر مرحله.
- **تنظیمات**: `DEMO_NUMBER` و `ELEVENLABS_VOICES` با فهرست `options` (id، زبان، نام فارسی و انگلیسی، آدرس نمونه صدا) برای انتخاب صدا در ویزارد.

## نکته‌های مهم

- **هیچ secret را داخل کد یا گیت نگذارید**؛ فقط با `wrangler secret put`.
- پیامک فارسی به‌صورت UCS-2 فرستاده می‌شود (۷۰ کاراکتر هر قطعه)، پس هر پیامک تأیید حدود ۳ تا ۴ قطعه است. اگر هزینه مهم شد، پیامک را کوتاه‌تر یا انگلیسی کنید.
- قالب امضای وب‌هوک و نام متغیرهای سیستمی (`system__caller_id`، `system__time_utc`) را هنگام راه‌اندازی در مستندات فعلی ElevenLabs چک کنید؛ پلتفرم مرتب به‌روز می‌شود.
- اگر مشتری از سیستم نوبت‌دهی خود ما استفاده می‌کند، در پروفایلش `"booking_provider": "external"` بگذارید و `EXTERNAL_BOOKING_API` را تنظیم کنید؛ Worker درخواست‌ها را با همان قرارداد به آن می‌فرستد.
- ظرفیت (`capacity`) یعنی چند نفر هم‌زمان خدمت می‌دهند. بررسی تداخل محافظه‌کارانه است و هیچ‌وقت بیش از ظرفیت نوبت نمی‌دهد.
