# minimum — دليل التشغيل (v2: حسابات + تسجيل دخول جوجل + لوحة أدمن)

## اللي اتضاف في النسخة دي
- **حسابات حقيقية**: كل مستخدم لازم يسجّل دخول بجوجل عشان يستخدم التطبيق.
- **تسجيل دخول بجوجل** عبر Supabase Auth.
- **لوحة أدمن مخفية**: اضغط على شعار `minimum` في شاشة تسجيل الدخول **دبل كليك (double-click)** فيظهر رابط صغير "دخول الأدمن". الدخول نفسه هو نفس زرار جوجل — لكن التطبيق بيتعرف إنك أدمن تلقائيًا لأن قاعدة البيانات بتربط صلاحية الأدمن بإيميلك (`abdelrahmanalaaegy@gmail.com`) مش بأي زرار. يعني حتى لو حد لقى الزرار المخفي، مش هيقدر يدخل كأدمن إلا لو سجل بنفس الإيميل ده.
- **تحليلات سلوك المستخدمين** (زيارات، أكثر الصفحات استخدامًا، عدد المستخدمين الجدد، عدد عمليات التحسين) — تظهر في تبويب الأدمن فقط.
- الـ Worker بقى يرفض أي طلب مش مرفق بيه توكن دخول Supabase صحيح (يمنع استخدام الـ API من غير حساب).

## الترتيب المطلوب منك (مرة واحدة بس)

### 1) قاعدة البيانات (Supabase)
1. افتح مشروعك في supabase.com → **SQL Editor**.
2. الصق محتوى ملف `schema.sql` كامل ونفّذه (Run). الملف آمن يتنفذ أكتر من مرة.
3. لو حابب تغيّر إيميل الأدمن مستقبلًا، غيّره في مكانين جوه `schema.sql`: داخل `handle_new_user()` وفي جملة الـ backfill في آخر الملف، وأعد تنفيذ الملف.

### 2) تفعيل تسجيل الدخول بجوجل
**أ. Google Cloud Console** (console.cloud.google.com):
1. أنشئ مشروع (أو استخدم موجود) → **APIs & Services → OAuth consent screen** → اضبطه كـ External واملأ البيانات الأساسية.
2. **Credentials → Create Credentials → OAuth client ID** → النوع **Web application**.
3. في **Authorized redirect URIs** ضيف:
   `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
   (تلاقي الرابط ده جاهز في Supabase Dashboard → Authentication → Providers → Google).
4. سجّل **Client ID** و **Client Secret**.

**ب. Supabase Dashboard:**
1. **Authentication → Providers → Google** → فعّله والصق الـ Client ID/Secret.
2. **Authentication → URL Configuration** → ضيف رابط موقعك (ورابط `http://localhost` لو هتجرب محليًا) في Site URL و Redirect URLs.

### 3) اضبط إعدادات الواجهة الأمامية
افتح `index.html` ودوّر على `CONFIG` في أول السكريبت (تحت `<!-- BOTTOM NAV -->`) واملأ:
```js
const CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-KEY',      // Project Settings → API → anon public
  WORKER_URL: 'https://minimum-api.YOUR-SUBDOMAIN.workers.dev/api/optimize',
  ADMIN_EMAIL: 'abdelrahmanalaaegy@gmail.com',
};
```
مفتاح `anon` آمن إنه يكون في الواجهة — الحماية الحقيقية موجودة في RLS جوه `schema.sql`.

### 4) نشر الـ Worker (Cloudflare)
```bash
npm install -g wrangler
wrangler login
wrangler secret put GROQ_API_KEY          # مفتاح Groq بتاعك
wrangler secret put SUPABASE_ANON_KEY     # نفس الـ anon key اللي حطيته في index.html
wrangler deploy
```
هتاخد رابط زي `https://minimum-api.<subdomain>.workers.dev` — ده اللي تحطه في `WORKER_URL` فوق.
لو عايز تستخدم Gemini بدل Groq، غيّر `AI_PROVIDER = "gemini"` في `wrangler.toml` وضيف `wrangler secret put GEMINI_API_KEY`.

### 5) GitHub
```bash
cd minimum-pwa
git init
git add .
git commit -m "minimum: accounts, Google sign-in, admin dashboard"
gh repo create minimum-pwa --private --source=. --remote=origin --push
# أو يدوي:
# git remote add origin https://github.com/USERNAME/minimum-pwa.git
# git branch -M main
# git push -u origin main
```

### 6) نشر الواجهة (اختياري لكن موصى بيه)
اربط الـ repo بـ **Cloudflare Pages** أو **Vercel** (استيراد من GitHub مباشرة):
- Build command: (فاضي — الملفات static)
- Output directory: `/` (الجذر)
كده أي `git push` جديد هينشر تحديث تلقائي.

## اختبار سريع
1. افتح الموقع → هتلاقي شاشة تسجيل دخول → اضغط "تسجيل الدخول بجوجل".
2. جرّب تحسين برومبت — هيتحفظ تلقائيًا في `prompts_history` مرتبط بحسابك.
3. لتجربة الأدمن: من نفس شاشة الدخول (لو خرجت)، دوس على الشعار دبل كليك (double-click) → هيظهر "دخول الأدمن" → ادخل بإيميل `abdelrahmanalaaegy@gmail.com` → هيظهر تبويب **Admin** تحت لوحدك.

## ملاحظات أمان
- أي شخص تاني هيسجل دخول بجوجل هيبقى مستخدم عادي بس (`is_admin = false`) — مفيش طريقة يوصل بيها للوحة الأدمن غير إنه يملك نفس إيميل الأدمن المسجل في قاعدة البيانات.
- الـ Worker دلوقتي بيتأكد من صحة توكن Supabase قبل ما يكلم Groq/Gemini، فمحدش هيقدر يستهلك رصيدك من غير تسجيل دخول.
