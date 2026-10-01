# از اینجا شروع کنید — تحویل به محیط کدنویسی

این پوشه کل پروژه است. همه‌اش را به محیط کدنویسی (Claude Code، Cursor یا هر ابزار مشابه) بدهید؛ چیزی را جدا نکنید.

## ۱. آماده‌سازی (یک بار)

```bash
unzip ai-receptionist.zip && cd ai-receptionist
git init && git add . && git commit -m "Starter package: prompts, worker, docs, build prompts"
# یک ریپوی خصوصی در GitHub بسازید و push کنید
cd worker && npm install && npm test        # باید ۱۴ تست پاس شود
```

## ۲. چه فایلی برای چه کاری

| می‌خواهید... | این فایل را بدهید |
| --- | --- |
| بک‌اند فعلی را deploy کنید | `README.md` (مرحله ۱ تا ۴) |
| ایجنت را در ElevenLabs بسازید | `prompts/` + `config/` |
| یک ماژول جدید بسازید | `build-prompts/00_master_context.md` + فایل همان ماژول |
| ترتیب ساخت را ببینید | `build-prompts/README.md` |
| مشتری جدید راه بیندازید | `docs/onboarding_checklist.md` |

## ۳. اولین پیام به دستیار کدنویسی

بعد از باز کردن پوشه در محیط کدنویسی، این را بفرستید:

```
Read START_HERE.md, README.md and build-prompts/00_master_context.md.
Then: 1) run the worker tests, 2) walk me through deploying the worker to my Cloudflare
account step by step (I will run the commands that need my login), 3) render the system
prompt for prompts/business_profile.example.json. Do not change any code yet.
```

بعد از اولین تماس واقعی موفق، ماژول‌ها را به ترتیب جدول `build-prompts/README.md` بسازید. برای هر ماژول:

```
Read build-prompts/00_master_context.md and build-prompts/01_qa_harness.md.
Create a branch, implement the task, and stop when every acceptance item passes.
List your assumptions first.
```

## ۴. حساب‌هایی که باید خودتان بسازید (دستیار کدنویسی نمی‌تواند)

- [ ] ElevenLabs (پلن Creator برای شروع)
- [ ] Twilio + خرید شماره UK (ثبت مدارک یکی دو روز طول می‌کشد)
- [ ] Cloudflare (پلن Workers Paid، ۵ دلار)
- [ ] ربات تلگرام از BotFather
- [ ] Stripe (از فاز ۴)
- [ ] ثبت شرکت و ICO قبل از اولین قرارداد پولی

## ۵. قوانین ثابت پروژه

- دو زبان: فارسی و انگلیسی. رابط کاربری فارسی‌اول (راست‌به‌چپ).
- مشتری‌ها: کسب‌وکارهای ایرانی خارج از ایران؛ نسخه ۱ فقط بریتانیا، ولی هیچ چیز نباید روی UK هاردکد شود (کشور، ارز و منطقه زمانی از پروفایل خوانده می‌شود).
- هیچ کلید یا رمزی داخل کد یا گیت نرود.
- برای ایران چیزی ساخته نشود تا نظر وکیل تحریم گرفته شود.
