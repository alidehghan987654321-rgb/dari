# تنظیمات پیشنهادی ایجنت در ElevenLabs

این‌ها نقطه شروع هستند؛ در فاز ۳ (کیفیت فارسی) با تماس‌های تستی تنظیم دقیق می‌شوند.

| تنظیم | مقدار پیشنهادی | چرا |
| --- | --- | --- |
| Agent language | English | زبان پایه |
| Additional languages | Persian (fa) | با ابزار language_detection سوییچ می‌کند |
| LLM | Claude Sonnet یا GPT-4.1 | فراخوانی ابزار قابل اعتماد؛ برای ارزانی Gemini Flash را تست کنید |
| Temperature | 0.3 | جواب‌های ثابت، بدون خلاقیت اضافه |
| TTS model | Flash v2.5 (سریع‌ترین) یا v4 Turbo (طبیعی‌تر) | هر دو فارسی را پشتیبانی می‌کنند؛ هر دو را A/B تست کنید |
| Voice (fa) | یک صدای فارسی زن یا مرد از Voice Library | لهجه تهرانی معیار، آرام |
| Voice (en) | صدای بریتانیایی از Voice Library | |
| Stability / Similarity | 0.5 / 0.75 | پیش‌فرض خوب برای تلفن |
| ASR | Scribe، کیفیت بالا | |
| Keywords (ASR boost) | اسم کسب‌وکار، اسم خدمات، اسم خیابان‌ها و ایستگاه‌ها | کم کردن خطای تشخیص |
| Turn timeout | 7 ثانیه | فارسی‌زبان‌ها وسط جمله مکث می‌کنند |
| Max call duration | 600 ثانیه | جلوگیری از تماس‌های طولانی و هزینه |
| Silence end call | 20 ثانیه | |
| Audio format (Twilio) | μ-law 8000 Hz | الزام تلفن |
| Data collection (Analysis) | caller_intent, booking_made, language, callback_needed | برای گزارش و پنل |
| Evaluation criteria | «آیا هدف تماس انجام شد؟» | معیار موفقیت در پنل |
| Post-call webhook | `https://WORKER_URL/webhooks/post-call` + HMAC secret | ارسال خلاصه به تلگرام صاحب کار |
| Privacy / Retention | 90 روز | مطابق سیاست GDPR ما |

## Dynamic variables که در پرامپت استفاده شده

- `{{system__time_utc}}` و `{{system__caller_id}}`: متغیرهای سیستمی ElevenLabs (خودکار پر می‌شوند؛ نام دقیق را در داشبورد چک کنید).
- `{{business_name}}`، `{{assistant_name}}`، `{{business_type}}`، `{{city}}`، `{{transfer_hours}}`، `{{business_profile}}`: با اسکریپت `scripts/build_prompt.mjs` از فایل پروفایل هر کسب‌وکار پر می‌شوند و متن نهایی در فیلد System prompt چسبانده می‌شود.
