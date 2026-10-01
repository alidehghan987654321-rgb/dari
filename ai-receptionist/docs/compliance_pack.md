# بسته انطباق (UK GDPR) — پیش‌نویس

> این متن‌ها پیش‌نویس کاری هستند، نه مشاوره حقوقی. قبل از فروش یک بار توسط وکیل یا مشاور GDPR بررسی شوند.

## نقش‌ها

- **کسب‌وکار مشتری** = Data Controller (صاحب داده تماس‌گیرنده‌ها)
- **ما** = Data Processor
- **زیرپردازشگرها**: ElevenLabs (صدا و متن)، ارائه‌دهنده LLM انتخاب‌شده، Twilio (تلفن و پیامک)، Cloudflare (میزبانی و دیتابیس)، Telegram (اعلان به صاحب کار)

## ۱. اعلام در ابتدای تماس (در First message)

> «سلام، [اسم کسب‌وکار]. من دستیار هوشمند هستم و تماس برای کیفیت ضبط می‌شه.»
> "Hello, you're through to [Business]. I'm the AI assistant, and this call is recorded."

## ۲. متن حریم خصوصی برای سایت مشتری (Privacy notice, بخش تماس تلفنی)

```
Phone calls to [Business] may be answered by an AI assistant provided by [Our company].
We record and transcribe calls to take bookings, pass on messages and improve our service.
We use your name, phone number and booking details only for these purposes.
Our lawful basis is legitimate interests (running our bookings) and, where you book, performance of a contract.
Recordings and transcripts are kept for 90 days, booking records for as long as needed for our accounts.
You can ask for a copy or deletion of your data, or to speak to a person, by contacting [email/phone].
Our suppliers (voice, telephony and hosting providers) process data on our behalf under contract.
```

## ۳. نکات قرارداد پردازش داده (DPA) با هر مشتری

- موضوع، مدت، ماهیت و هدف پردازش (پاسخ تماس، ثبت نوبت، پیام)
- انواع داده: نام، شماره تلفن، صدای تماس، متن مکالمه، جزئیات نوبت
- پردازش فقط طبق دستور مکتوب مشتری
- محرمانگی کارکنان ما
- اقدامات امنیتی: رمزنگاری در انتقال، دسترسی محدود، secrets جدا، حذف خودکار ۹۰ روزه
- فهرست زیرپردازشگرها و اطلاع‌رسانی قبل از تغییر
- کمک به پاسخ درخواست‌های دسترسی/حذف (ظرف ۳۰ روز)
- اطلاع نقض داده ظرف ۴۸ ساعت از اطلاع ما
- حذف یا بازگرداندن داده پس از پایان قرارداد

## ۴. کارهای یک‌باره ما

- [ ] ثبت در ICO (data protection fee)
- [ ] LIA (Legitimate Interest Assessment) با قالب ICO
- [ ] DPIA برای کل محصول
- [ ] بررسی DPA و محل پردازش داده هر زیرپردازشگر (انتقال خارج از UK)
- [ ] تنظیم Retention در ElevenLabs روی ۹۰ روز + کران حذف در Worker (فعال است)
- [ ] فرایند مکتوب پاسخ به درخواست دسترسی/حذف

## ۵. کلینیک‌ها و مطب‌ها (سخت‌گیری بیشتر)

- منشی هیچ توصیه پزشکی نمی‌دهد و درباره علائم سؤال نمی‌کند؛ فقط نوبت و پیام.
- اگر تماس‌گیرنده اطلاعات سلامت گفت، در پیام به صاحب کار حداقل لازم منتقل شود.
- اورژانس: ۹۹۹؛ مشاوره فوری غیر اورژانسی: NHS 111.
