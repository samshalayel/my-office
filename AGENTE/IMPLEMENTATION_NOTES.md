# AGENTE — ملاحظات التنفيذ (S4)
> كود النظام كما بُني من حزمة S3 (`AGENTE_s3_*`) وقرارات `AGENTE_decisions.md` (DEC-1..DEC-18).
> هذا الملف مدخل لروبوت S4 لتوثيق المرحلة: حالة كل مهمة بالدليل، والانحرافات (DEV-N) التي تحتاج قرارك.
> ملفات المراحل (PD → S3) لم تُعدَّل.

## التشغيل
المتطلب: Node.js 22.18 أو أحدث. لا مكتبات تشغيل خارجية: SQLite من `node:sqlite` المدمج، والخادم من `node:http`.
أدوات التطوير فقط: `typescript` و `@types/node`.

```bash
cd AGENTE
npm ci
npm run set-password -- owner          # كلمة السر من الإدخال أو AGENTE_NEW_PASSWORD
```

**تجربة الواجهة بلا نموذج (بيانات اصطناعية):**
```bash
echo '{"model":{"provider":"demo"}}' > config/settings.local.json
npm run demo-data                      # بيانات اصطناعية إلى data/inbox (as_of المرجعي 2026-11-20)
npm run cycle -- --as-of=2026-11-20
npm start                              # http://127.0.0.1:8480
```
الوضع التجريبي يبني «التوقع» من قاعدة ثابتة معلنة، وكل صفحة تعرض تحذيراً أحمر: للتجربة فقط.

**التشغيل الحقيقي على خادم المشفى (DEC-14 أ):**
1. `config/settings.local.json`: النموذج المثبت (`model.model`، و`model.base_url` إن لم يكن OpenRouter)، ومسار ملف التصدير وأسماء حقوله (`source`)، وشهادة HTTPS (`server.tls_cert` و`tls_key`).
2. المفتاح في متغير البيئة فقط: `AGENTE_MODEL_API_KEY` (BASE-A7).
3. `npm run eval:live`: لازم ينجح. الوكيل لا يعمل بنموذج حي قبل تقييم ناجح لنفس النموذج ونفس إصدار التعليمات (MIT-8).
4. `npm start`: الدورة اليومية الساعة 06:00، والنسخة الاحتياطية 02:30، والتذكير كل ساعة (القيم من الإعدادات).

**الفحوص:**
```bash
npm run typecheck
npm test               # 15 اختباراً، منها تشغيل كل حالات EV/RT
npm run eval           # 14 حالة: EV-1..EV-8 و RT-1..RT-6 (نموذج مكتوب، حتمي)
npm run eval:live      # الحالات المعتمدة على سلوك النموذج تُشغَّل 3 مرات بالنموذج الحي
```
CI الريبو (`.github/workflows/ci.yml`) صار يشغّل `typecheck` و `npm test` للمشروع على Node 22.

## هيكل الكود
| المسار | المكوّن | العقود / المهام |
|---|---|---|
| `config/` | الإعدادات C-11، والقيم الافتراضية بلا أسرار | base-T1، BASE-8، BASE-A4 |
| `observability/` | التتبع JSONL (C-10) وتنقية الأسرار والمعرفات + أخطاء موحدة | base-T3، base-T9 |
| `storage/` | SQLite: الجداول + triggers القفل والإلحاق فقط + التدقيق C-12 + النسخ C-14 | base-T2، base-T4، base-T11 |
| `guards/` | مفتاح الإيقاف، السقوف، إخفاء الهوية، التحقق الصارم | MIT-1..MIT-7، base-T5 |
| `tools/` | TL-1..TL-4، والصلاحية تُفرض داخل كل أداة | C-1..C-4، tools-T1..T8 |
| `agents/` | AGT-1: حلقة أدوات بلا إطار، عميل النموذج، التعليمات بإصدار | agent-T1..T9، C-5..C-7 |
| `prompts/AGT-1.md` | تعليمات الوكيل (`version: AGT-1@v1.0`) | base-T7 |
| `hitl/` | قرارات HITL-1/2/3 + C-8/C-9 + سجل نقاط الإنسان + التنبيهات + مؤشرات DEC-3 | hitl-T1..T7 |
| `web/` | الواجهة الداخلية العربية + الدخول الآمن + تصدير CSV | hitl-T1..T10 |
| `evals/` و `redteam/` | حالات C-13 ومشغّل التقييم وخط الأساس | base-T8، agent-T10، verify-T1..T6 |
| `scripts/` | أوامر التشغيل والجدولة | — |
| `tests/` | 15 اختباراً (وحدات + تكامل + HTTP حقيقي) | verify-T7، verify-T8 |

## حالة الحمايات
| MIT | الحالة | الدليل |
|---|---|---|
| MIT-1 فصل البيانات عن التعليمات | ✅ | `tools/tl1_cases.ts`، `agents/loop.ts` (asData)، `guards/pii.ts` (injectionFlag)، RT-1 |
| MIT-2 تحقق الإدخال اليدوي | ✅ | `guards/validate.ts` (validateOutcomeInput)، RT-2 |
| MIT-3 صلاحيات + تدقيق + قفل المعتمد | ✅ | `tools/registry.ts`، triggers في `storage/db.ts`، RT-3 |
| MIT-4 تحقق مخرجات النموذج | ✅ | `guards/validate.ts` (validatePrediction/Action/Preparation)، RT-3، EV-3 |
| MIT-5 إخفاء الهوية | ✅ | `tools/tl1_cases.ts`، `guards/pii.ts`، `observability/trace.ts`، RT-6 |
| MIT-6 الأساس والنواقص في كل عرض | ✅ | `hitl/decisions.ts` (packageC5)، RT-5 |
| MIT-7 سقوف + مفتاح إيقاف | ✅ | `guards/caps.ts`، `guards/killswitch.ts`، RT-4 |
| MIT-8 تثبيت + إعادة تقييم | ✅ | `evals/runner.ts` (baseline)، `agents/agt1.ts` (evalStatus) — مراقبة دورية → RISK في S6 |
| MIT-9 لا اعتماد على سرية التعليمات | ✅ | `prompts/AGT-1.md` بلا أسرار؛ الصلاحيات في الكود لا في التعليمات |

## حالة المهام (48)
✅ = منفّذ بدليل. مهام 👤 منفّذة وتنتظر مراجعتك: خانة «راجعها» فارغة عمداً.

| المهمة | الحالة | الدليل | راجعها |
|---|---|---|---|
| base-T1 | ✅ | `config/config.ts`، `config/settings.json` | — |
| base-T2 | ✅ | `storage/db.ts` | — |
| base-T3 | ✅ | `observability/trace.ts` | — |
| base-T4 👤 | ✅ | `storage/db.ts` (audit + triggers)، `tests/guards.test.ts` | |
| base-T5 👤 | ✅ | `guards/killswitch.ts`، `tests/ops.test.ts` | |
| base-T6 👤 | ✅ | `config/config.ts` (modelApiKey/secretValues)، `observability/trace.ts` | |
| base-T7 | ✅ | `prompts/AGT-1.md`، `agents/prompts.ts` | — |
| base-T8 | ✅ | `evals/runner.ts` | — |
| base-T9 | ✅ | `observability/errors.ts` | — |
| base-T10 👤 | ✅ | `evals/runner.ts` (eval_baseline)، `agents/agt1.ts` (evalStatus) | |
| base-T11 | ✅ | `storage/backup.ts`، `tests/ops.test.ts` | — |
| tools-T1 | ✅ | `tools/tl1_cases.ts` — المصدر ملف تصدير (DEV-1) | — |
| tools-T2 👤 | ✅ | `tools/tl1_cases.ts`، `agents/agt1.ts` | |
| tools-T3 | ✅ | `tools/tl2_predictions.ts` | — |
| tools-T4 | ✅ | `tools/tl3_outcomes.ts` | — |
| tools-T5 | ✅ | `tools/tl4_drafts.ts` | — |
| tools-T6 👤 | ✅ | `tools/registry.ts`، triggers | |
| tools-T7 👤 | ✅ | `guards/validate.ts` | |
| tools-T8 👤 | ✅ | `guards/validate.ts` | |
| agent-T1 | ✅ | `agents/loop.ts`، `agents/agt1.ts` | — |
| agent-T2 👤 | ✅ | `guards/pii.ts`، `tools/tl1_cases.ts` | |
| agent-T3 | ✅ | `agents/agt1.ts` (runCycle) | — |
| agent-T4 | ✅ | `guards/validate.ts` (missing_fields من البيانات) | — |
| agent-T5 | ✅ | `hitl/decisions.ts` (packageC5)، `agents/agt1.ts` | — |
| agent-T6 | ✅ | `agents/agt1.ts` (compareOutcome) — حساب حتمي (DEV-3، DEV-11) | — |
| agent-T7 | ✅ | `agents/agt1.ts` | — |
| agent-T8 | ✅ | `agents/agt1.ts` (runPrepare)، `tools/tl4_drafts.ts` | — |
| agent-T9 👤 | ✅ | `guards/caps.ts`، `agents/loop.ts` | |
| agent-T10 | ✅ | `evals/checks.ts`، `evals/cases/` | — |
| hitl-T1 👤 | ✅ | `web/server.ts` (predictionPage) | |
| hitl-T2 👤 | ✅ | `hitl/decisions.ts` (decideHitl1) | |
| hitl-T3 | ✅ | `web/server.ts` (/outcomes) | — |
| hitl-T4 👤 | ✅ | `hitl/decisions.ts` (decideHitl2) | |
| hitl-T5 👤 | ✅ | `hitl/decisions.ts` (decideHitl3) | |
| hitl-T6 | ✅ | `hitl/decisions.ts` (C-9، END-1/END-2) | — |
| hitl-T7 👤 | ✅ | جدول `hitl_log`، `web/server.ts` (/hitl-log) | |
| hitl-T8 | ✅ | `web/views.ts` (RTL، أرقام لاتينية واضحة) | — |
| hitl-T9 👤 | ✅ | `web/auth.ts`، `tests/web.test.ts` | |
| hitl-T10 | ✅ | `web/server.ts` (/export/*.csv بـ BOM) | — |
| verify-T1..T6 | ✅ | `redteam/cases/RT-1..RT-6.json`، `evals/checks.ts` — كلها تنجح | — |
| verify-T7 | ✅ | `tests/flows.test.ts`، `tests/web.test.ts` | — |
| verify-T8 | ✅ | `tests/flows.test.ts`، `tests/web.test.ts` | — |
| verify-T9 👤 | 🟡 | خريطة TH ← MIT ← RT أعلاه — المراجعة الأمنية النهائية بيد الإنسان | |

## الانحرافات وقرارات التفسير (DEV-N) — تحتاج قرارك
| DEV | ما في S2/S3 | ما بُني | لماذا |
|---|---|---|---|
| DEV-1 | TL-1 «سجلات المشفى» بلا شكل محدد | ملف تصدير JSON/CSV يضعه نظام المشفى في `data/inbox`، وأسماء الحقول من الإعدادات | الربط الفعلي غير معروف. الحالة بلا تاريخ ولادة متوقع لا تدخل الدورة، ويُنبَّه عليها |
| DEV-2 | لا ربط بين الطفل المتوقع والمقياس الفعلي | `infant_ref = "<case_ref>#<n>"`: المولود رقم n للحالة يقابل #n | بدونه لا تمكن المقارنة EV-6 |
| DEV-3 | C-6 يطبّق نسب 80%/85% على توقع واحد | التوقع الواحد إما مطابق أو خلاف؛ النسب مؤشرات على فترة في صفحة `/metrics` | DEC-3 عتبات نجاح النظام لا حكم على حالة واحدة |
| DEV-4 | — | `count_value` = عدد الأطفال في `per_infant`؛ `risk_class` = أعلى فئة بينهم؛ `missing_fields` تُحسب من البيانات | اتساق يمنع عرضاً متناقضاً؛ المخالف يُرفض ولا يُصحَّح |
| DEV-5 | خيارات HITL-2 الثلاثة لا تطابق قيم `Decision.decision` | إبقاء = approve (بسبب إلزامي)؛ تعديل توزيع = modify (توقع جديد يعدّله الإنسان + تحضير جديد)؛ إعادة تقييم = reject (دورة جديدة) | بلا حقول مخترعة في Decision |
| DEV-6 | MIT-1 «قالب بيانات صارم» | ملاحظات الأطباء لا تُرسل للنموذج إطلاقاً (`privacy.send_notes_to_model=false`)، وتُعرض للإنسان مع تعليم المشبوه | الطريقة الوحيدة لضمان معيار RT-1 «تطابق تام». الثمن: الملاحظات السريرية لا تدخل التوقع |
| DEV-7 | C-3 يُدخل `apgar_class` يدوياً | الفئة تُشتق من القيمة بنطاقات من الإعدادات (0–3 high، 4–6 medium، 7–10 low) | يمنع إدخالاً متناقضاً |
| DEV-8 | EV-4 «لا حجز بلا مبرر» بلا قاعدة قابلة للفحص | مسودة نقل/تجهيز تحتاج طفلاً واحداً على الأقل بفئة medium/high؛ `payload = {summary, infant_refs, justification}` | تحويل EV-4 إلى فحص آلي |
| DEV-9 | مقياس بلا توقع | فارق بمرجع `UNPLANNED` يُسجَّل وينبَّه عليه ولا يفتح HITL-2 | توقيع Discrepancy يتطلب prediction_ref |
| DEV-10 | — | أعمدة تشغيلية في التخزين (origin، supersedes، run_id، model، prompt_version، batch_deadline) | حقول العقود نفسها لم تتغير |
| DEV-11 | «AGT-1 يقارن» | المقارنة حساب حتمي بلا نموذج | أدق وأرخص؛ النموذج للتوقع والمسودات فقط |
| DEV-12 | — | مزوّد `demo` لتجربة الواجهة بلا مفتاح | تحذير أحمر دائم؛ لا يُستخدم على بيانات حقيقية |
| DEV-13 | — | CI الريبو صار على Node 22 ويشغّل فحوص كل مشروع له package.json | `node:sqlite` وتشغيل TypeScript مباشرة يحتاجان Node 22 |
| DEV-14 | — | التوقع `modified` (معدَّل ومعتمد من الإنسان) يُعامل كمعتمد للمسودات | قرار الإنسان اعتماد مع تعديل |

## أسئلة مفتوحة للإنسان
1. **شكل الوصول لسجلات المشفى** (DEV-1): ملف تصدير يومي، أم قاعدة بيانات، أم واجهة؟ ومن يضعه؟
2. **تصحيح مقياس أُدخل خطأ:** السجل للإضافة فقط، ولا مسار تصحيح الآن. هل التصحيح يكون بقرار HITL-2، أم بمسار «إدخال مصحِّح» مسجل؟
3. **K-2** ما زال [افتراض]، وسياسة الاحتفاظ بالبيانات غير محددة.
4. **المنطقة الزمنية:** الدورة والمواعيد بتوقيت الخادم. هل خادم المشفى على توقيت فلسطين؟
5. **الحسابات:** مستخدم واحد (صاحب الحضانة) حسب BASE-2/BASE-3. هل يحتاج أحد غيره حساباً؟

## نسخة Python (DEV-16)
| DEV | ما في S2/S3 | ما بُني | لماذا |
|---|---|---|---|
| DEV-16 | نسخة واحدة TypeScript | **نسخة Python منفصلة كاملة** في `AGENTE/python/` (حزمة `agente`) بطلب صاحب المشروع 2026-11-20: نفس العقود والحمايات والمخطط والـ triggers والرسائل العربية، والوكيل جراف **LangGraph** (`StateGraph` بعقدتين agent ⇄ tools، عقدة tools مكتوبة يدوياً، بلا checkpointer ولا interrupt، تتبّع LangSmith مقفل قسراً) كتصميم فرع `agente/langgraph`. المكتبة القياسية لكل شيء (`sqlite3`، `http.server`، `hashlib.scrypt`، `getpass`) عدا `langgraph` 1.2.20 و `langchain-core` 1.7.6 و `langchain-openai` 1.7.4 (كل التبعيات مثبتة في `requirements.txt`). | **يحتاج قرارك:** أي النسختين تُعتمد للتشغيل. النسختان تقرآن `prompts/` و `samples/` وحالات التقييم من هذا المجلد (مصدر واحد)، ولكل منهما `data/` خاص، ومنفذ Python 8481. |

- التشغيل والأوامر: `AGENTE/python/README.md` (`python -m agente serve|cycle|eval|backup|restore|set-password|demo-data`).
- الفحوص: `python -m pytest` (الاختبارات الـ 15 المنقولة + 3 للمسار الحي أمام خادم OpenAI مُحاكى: إعادة بعد 500، أدوات، مهلة تقطع الطلب فعلاً) و `python -m agente eval` (14 حالة EV/RT — نفس الأدلة حرفياً كنسخة TypeScript). CI يشغّل pytest على Python 3.11 (أدنى نسخة مدعومة).
- فروق صغيرة معروفة: أوامر التشغيل في الرسائل (`npm run …` ← `python -m agente …`)؛ التواريخ في الإدخال بصيغة ISO 8601 فقط (JavaScript يقبل صيغاً أخرى)؛ أطوال النصوص تُعدّ بالمحارف لا بوحدات UTF-16 (لا فرق للعربية).
