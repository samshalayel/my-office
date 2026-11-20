# AGENTE — نسخة Python + LangGraph (DEV-16)
> نسخة منفصلة كاملة من AGENTE بلغة Python: نفس السلوك ونفس العقود ونفس الحمايات، والوكيل جراف **LangGraph** (`agent ⇄ tools`).
> تعمل بجانب نسخة TypeScript (منفذ 8481 بدل 8480، ومجلد `data/` خاص بها). التعليمات (`prompts/`) والعينات (`samples/`)
> وحالات التقييم (`evals/cases` و `redteam/cases`) تُقرأ من مجلد `AGENTE/` الأب — مصدر حقيقة واحد للنسختين.

## التشغيل
المتطلب: Python 3.12 أو أحدث. قاعدة البيانات `sqlite3` والخادم `http.server` من المكتبة القياسية؛
المكتبات الخارجية حصراً: `langgraph` و `langchain-core` و `langchain-openai` (بنسخ مثبتة في `requirements.txt`).

```bash
cd AGENTE/python
python -m venv .venv
.venv/bin/pip install -r requirements.txt            # على Windows: .venv\Scripts\pip install -r requirements.txt
.venv/bin/python -m agente set-password owner        # كلمة السر من AGENTE_NEW_PASSWORD أو من إدخال مخفي
```
على Windows استبدل `.venv/bin/python` بـ `.venv\Scripts\python`.

**تجربة الواجهة بلا نموذج (بيانات اصطناعية):**
```bash
echo '{"model":{"provider":"demo"}}' > config/settings.local.json
python -m agente demo-data                 # بيانات اصطناعية إلى data/inbox (as_of المرجعي 2026-11-20)
python -m agente cycle --as-of=2026-11-20
python -m agente serve                     # http://127.0.0.1:8481
```
الوضع التجريبي يبني «التوقع» من قاعدة ثابتة معلنة، وكل صفحة تعرض تحذيراً أحمر: للتجربة فقط.

**التشغيل الحقيقي على خادم المشفى (DEC-14 أ):**
1. `config/settings.local.json`: النموذج المثبت (`model.model`، و`model.base_url` إن لم يكن OpenRouter)، ومسار ملف التصدير وأسماء حقوله (`source`)، وشهادة HTTPS (`server.tls_cert` و`tls_key`).
2. المفتاح في متغير البيئة فقط: `AGENTE_MODEL_API_KEY` (BASE-A7).
3. `python -m agente eval --live`: لازم ينجح. الوكيل لا يعمل بنموذج حي قبل تقييم ناجح لنفس النموذج ونفس إصدار التعليمات (MIT-8).
4. `python -m agente serve`: الدورة اليومية الساعة 06:00، والنسخة الاحتياطية 02:30، والتذكير كل ساعة (القيم من الإعدادات).

**الأوامر:**
```bash
python -m agente serve                               # الواجهة + الجدولة
python -m agente cycle [--as-of=YYYY-MM-DD]          # دورة توقع الآن
python -m agente eval [--live] [--runs=N] [--only=EV-1,RT-6]
python -m agente backup
python -m agente restore backups/office-....sqlite   # والخادم متوقف
python -m agente set-password <user>
python -m agente demo-data
```

**الفحوص:**
```bash
pip install -r requirements-dev.txt
python -m pytest           # 18 اختباراً: الـ 15 المنقولة من نسخة TypeScript + 3 للمسار الحي أمام خادم OpenAI محلي مُحاكى
python -m agente eval      # 14 حالة: EV-1..EV-8 و RT-1..RT-6 (نموذج مكتوب، حتمي)
python -m agente eval --live
```
CI الريبو (`.github/workflows/ci.yml`) يشغّل `pytest` لهذا المجلد على Python 3.12.

## هيكل الكود
| المسار | المكوّن | المقابل في TypeScript |
|---|---|---|
| `agente/config/` | الإعدادات C-11 (`config/settings.json` + `settings.local.json`) | `config/` |
| `agente/observability/` | التتبع JSONL وتنقية الأسرار والمعرفات + أخطاء موحدة | `observability/` |
| `agente/storage/` | SQLite: نفس الجداول والـ triggers + التدقيق + النسخ | `storage/` |
| `agente/guards/` | مفتاح الإيقاف، السقوف، إخفاء الهوية، التحقق الصارم | `guards/` |
| `agente/tools/` | TL-1..TL-4 والصلاحية داخل كل أداة | `tools/` |
| `agente/agents/` | جراف LangGraph (`loop.py`)، نماذج LangChain (`model.py`)، AGT-1 (`agt1.py`) | `agents/` (فرع agente/langgraph) |
| `agente/hitl/` | قرارات HITL-1/2/3 + التنبيهات + المؤشرات | `hitl/` |
| `agente/web/` | الواجهة العربية RTL بلا JavaScript + الدخول الآمن + CSV | `web/` |
| `agente/evals/` | فحوص EV/RT والمشغّل والبيئة المعزولة | `evals/` |
| `agente/scripts/` | الأوامر والجدولة | `scripts/` |
| `agente/jsutil.py` | مطابقة سلوك JavaScript (JSON، الأرقام، التواريخ، trim) حيث يهم | — |
| `tests/` | pytest | `tests/` |

حسابات `auth_user` متوافقة بين النسختين (نفس صيغة scrypt)، لكن لكل نسخة قاعدة بياناتها في `data/` الخاص بها.
