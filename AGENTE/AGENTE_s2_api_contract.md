# Agent Contract: AGENTE
> المرجع الملزم الوحيد للحالة والأدوات والرسائل. أي تعارض — هذا الملف يفوز.
> يرث جراف S1 v1.5 (AGENTE_s1_2026-11-19T21-50-31Z.json) وقرارات DEC-1..DEC-10 في AGENTE_decisions.md.

## الحالة (State)
```ts
// الحالة المشتركة — تُبنى من السجلات في كل دورة (لا ذاكرة محادثة عبر الجلسات)
interface CycleState {
  cycle_date: string;                    // ISO — يكتبه منسق الدورة، يقرؤه الجميع
  cases: CaseInput[];                    // يقرؤها AGT-1 من TL-1 (C-1)
  forecasts: ForecastRecord[];           // يكتبها AGT-1 في TL-2 (C-2)
  measures: MeasureRecord[];             // يكتبها الإدخال اليدوي عبر TL-3 (C-3)
  escalations: EscalationRecord[];       // يفتحها TL-3/AGT-1، يحسمها الإنسان في HITL-2
  drafts: DraftRecord[];                 // يكتبها AGT-1 في TL-4 (C-4)
  human_decisions: HumanDecision[];      // يكتبها الإنسان فقط عبر نقاط HITL (HR-8)
  loop_budget: { max_tool_calls: number; max_tokens: number; timeout_min: number }; // HR-9 — أرقامها بقرار DEC-16
}

interface CaseInput {                    // مُخفاة الهوية (MIT-2/HR-10)
  case_id_alias: string;                 // معرف مستعار — الربط الحقيقي يبقى داخل المشفى ولا يخرج
  pregnancy_week: number;                // 20..45 — تحقق HR-11
  due_within_7d: boolean;                // فلتر BR-5 (الأسبوع الأخير فقط)
  indicators: Record<string, number>;    // مؤشرات مسماة من سجلات المشفى (K-1)
  present_fields: string[];
  missing_fields: string[];              // EV-2 — لا تُملأ بقيم مخترعة (HR-3)
  free_text_notes?: string;              // TB-1 — بيانات لا تعليمات (HR-6)
}

interface BasisDoc {
  indicators_used: string[];
  weighting_rule: string;                // ما اقترحه النموذج من قاعدة موازنة (DEC-17 ج)
  computation_ref: string;               // مرجع الحسبة في الكود — إثبات HR-5
  data_gaps: string[];                   // النقص الموثق (EV-2/HR-3)
}

interface CaseForecast {
  case_id_alias: string;
  apgar_value_estimate: number;          // 0..10 — من الحسبة (HR-5/HR-11)
  risk_category: "منخفض" | "متوسط" | "عالٍ"; // «عالٍ» = «حرجة» وفق DEC-2 ج/DEC-5 ج
  basis: BasisDoc;
  missing_fields: string[];
}

interface ForecastRecord {               // TL-2 — قابل للتعديل قبل الاعتماد
  forecast_id: string;                   // فريد لكل دورة
  cycle_date: string;
  scope: "last_pregnancy_week";          // BR-5
  count_value: number;                   // >=0 — من الحسبة (HR-5)
  count_basis: BasisDoc;
  case_forecasts: CaseForecast[];        // توقع لكل طفل متوقع (DEC-2 ج)
}

interface MeasureRecord {                // TL-3
  measure_id: string;
  birth_alias: string;
  actual_count?: number;                 // >=0 (HR-11)
  actual_apgar: number;                  // 0..10 — يُرفض غير ذلك (HR-11)
  recorded_at: string;                   // ISO
  entered_by: string;                    // إلزامي — TB-2 (من أدخل)
  linked_forecast_id?: string;
  variance?: { count_diff?: number; category_match: "نعم" | "لا" | "غير قابل للمقارنة" };
}

interface EscalationRecord {             // يُفتح عند EV-4/EV-7
  escalation_id: string;
  forecast_id: string; measure_id: string;
  reserved_resources: string;            // الموارد المحجوزة بناء على التوقع المنقوض
  variance_summary: string;
  status: "open" | "resolved";
  resolution?: HumanDecision;            // قرار HITL-2
}

interface DraftRecord {                  // TL-4 — مسودة فقط (DEC-9)
  draft_id: string;
  kind: "prep_plan" | "irreversible_action";
  basis_forecast_id: string;             // يجب أن يكون معتمداً (HR-2)
  prep_items: string[];
  action?: { type: "نقل" | "تجهيز" | "إبلاغ"; target: string; rationale: string };
  status: "draft" | "activated" | "awaiting_HITL3" | "to_END2" | "to_END1";
}

interface HumanDecision {                // سجل تدقيق — append فقط، لا يُحذف
  decision_id: string;
  hitl: "HITL-1" | "HITL-2" | "HITL-3";
  ref_id: string;                        // forecast_id أو escalation_id أو draft_id
  option: string;                        // الخيار المختار حرفياً
  note?: string;
  decided_by: string; decided_at: string;
}
```

| الحقل | يكتبه | يقرؤه |
|---|---|---|
| cases | TL-1 (قراءة من المشفى) | AGT-1 |
| forecasts | AGT-1 | AGT-1، HITL-1 (عبر العرض)، HITL-2 |
| measures | الإدخال اليدوي (TB-2 عبر TL-3) + AGT-1 (variance) | AGT-1، HITL-2 |
| escalations | TL-3/AGT-1 (فتح) — الإنسان (resolution عبر HITL-2) | AGT-1، HITL-2 |
| drafts | AGT-1 | HITL-1 (التفعيل)، HITL-3 (العرض) |
| human_decisions | الإنسان فقط (HITL-1/2/3) | النظام كله (سجل تدقيق) |
| loop_budget | قرار DEC-16 (قيم ثابتة في الإعداد) | منسق الدورة |

## عقود الأدوات (Tools)

### C-1: TL-1 قراءة بيانات الحوامل
- **المدخل (schema):** `{ cycle_date: string; scope: "last_pregnancy_week" }` — scope ثابت (BR-5)؛ cycle_date بصيغة ISO.
- **المخرج:** `{ cases: CaseInput[]; source_ref: string }` — كل سجل مخالف نطاقه يُستبعد ويُسجل. **حالات الفشل:** `SOURCE_UNAVAILABLE` (توقف الدورة — لا مصدر بديل، BR-3)، `VALIDATION_FAILED` (سجلات مخالفة HR-11 تُسجل وتُستبعد مع أسبابها).
- **الصلاحية:** قراءة فقط — سجلات الحوامل داخل المشفى حصراً (K-5) — صلاحية خدمة قراءة مقيّدة بلا كتابة.
- **الأثر الجانبي:** لا شيء؛ idempotent؛ لا يحتاج HITL.
- **حدود:** مهلة [تقدير: 30 ثانية]؛ دفعة واحدة لكل دورة؛ حجم الدفعة = حوامل الأسبوع الأخير.
- **الحماية المرتبطة:** HR-1 + MIT-1 + MIT-9 + MIT-2 (يُخفى الهوية هنا قبل التسليم لـ AGT-1).

### C-2: TL-2 سجل التوقعات
- **المدخل (schema):** `{ forecast: ForecastRecord }` — قيود: `count_value >= 0`؛ كل `case_forecasts[i].basis.computation_ref` غير فارغ (HR-5)؛ كل `missing_fields` يُمرر كما هو (HR-3).
- **المخرج:** `{ forecast_id: string; stored_at: string; status: "pending_approval" }`. **حالات الفشل:** `BASIS_MISSING` (سجل بلا إثبات حسبة يُرفض — HR-5)، `DUPLICATE_CYCLE` (سجل لنفس الدورة موجود).
- **الصلاحية:** كتابة سجلات قابلة للتعديل — لجلسة AGT-1 لهذه الدورة فقط؛ التعديل بعد الاعتماد يتطلب أثراً مسجلاً في human_decisions.
- **الأثر الجانبي:** سجل قابل للتعديل — ليس لا رجعة فيه؛ لا يحتاج HITL قبل الكتابة (✅ وحده — حدود الاستقلالية S1).
- **حدود:** سجل واحد لكل دورة لكل نطاق؛ idempotent بـ forecast_id.
- **الحماية المرتبطة:** HR-5؛ العرض اللاحق عبر TB-3 يخضع لـ MIT-6.

### C-3: TL-3 سجل المقاييس الفعلية والفوارق
- **المدخل (schema):** `{ measure: { birth_alias: string; actual_count?: number; actual_apgar: number; recorded_at: string; entered_by: string }, linked_forecast_id?: string }` — قيود: `actual_apgar` صحيح 0..10 (HR-11)؛ `actual_count >= 0`؛ `recorded_at` منطقي (ليس مستقبلياً)؛ `entered_by` إلزامي (TB-2).
- **المخرج:** `{ measure_id: string; variance?: { count_diff?: number; category_match: string }; escalation_id?: string }`. **حالات الفشل:** `OUT_OF_RANGE` (HR-11)، `MISSING_ENTERED_BY`، `UNKNOWN_FORECAST` (linked_forecast_id غير موجود → يُسجل كفارق غير مبرمج وفق حالة حافة UF-2).
- **الصلاحية:** قراءة/كتابة سجل المقاييس والفوارق — إدخال بشري يدوي (DEC-4 أ) لكتابة المقياس، وAGT-1 لكتابة الفوارق والتصعيد.
- **الأثر الجانبي:** سجل قابل للتعديل؛ فتح escalation عند خلاف يخص توقعاً له موارد محجوزة (EV-4/EV-7) — التصعيد تنبيه وتسجيل لا فعل واقع.
- **حدود:** إدخال لكل ولادة؛ تحقق فوري قبل الحفظ.
- **الحماية المرتبطة:** HR-7 + HR-11 + MIT-9.

### C-4: TL-4 مسودة خطة التحضير ومسودة الفعل
- **المدخل (schema):** `{ draft: DraftRecord }` — قيود: `kind=prep_plan` يتطلب `basis_forecast_id` بحالة approved (HR-2)؛ `kind=irreversible_action` يتطلب كذلك `action.rationale` غير فارغ؛ **لا يوجد حقل تنفيذ في المخطط أصلاً** (DEC-9).
- **المخرج:** `{ draft_id: string; status: DraftRecord.status }`. **حالات الفشل:** `FORECAST_NOT_APPROVED` (HR-2)، `INVALID_KIND`.
- **الصلاحية:** كتابة مسودة فقط — لا اتصال بأي نظام واقعي (لا حجز، لا إرسال، لا نقل) — قائمة الأدوات مقفلة (HR-4).
- **الأثر الجانبي:** مسودة قابلة للتعديل — صفر أثر واقعي؛ اعتماد HITL-1 يفعّل مسودة التحضير فقط.
- **حدود:** مسودة واحدة نشطة لكل توقع معتمد.
- **الحماية المرتبطة:** HR-2 + HR-4 + DEC-9.

## عقود الرسائل بين الوكلاء

### C-5: AGT-1 → HITL-1 (عبر TB-3) — عرض التوقع
- **البنية (structured output):** `{ batch: [{ forecast_id, count_value, categories_summary, basis_summary, missing_fields[] }], urgent: [{ forecast_id, case_id_alias, risk_category: "عالٍ", reason }] }` — ممنوع نص حر يُنفَّذ؛ الأرقام كلها ذات computation_ref (HR-5).
- **التحقق قبل التمرير:** مطابقة schema؛ تعقيم كل نص للعرض (MIT-6)؛ التنبيه الفوري للفئة «عالٍ» فقط (DEC-5 ج).
- **الخيارات:** اعتماد / تعديل / رفض. **إن لم يرد:** التوقع يبقى معلقاً بلا استخدام (BR-1) — لا مهلة تُفعّل شيئاً تلقائياً.

### C-6: TL-3 → HITL-2 — تصعيد الخلاف
- **البنية:** `{ escalation: { escalation_id, forecast_id, variance_summary, reserved_resources, actual_vs_expected } }`.
- **التحقق:** الـ escalation مرتبط بسجل توقع وسجل قياس موجودين فعلاً؛ الفارق محسوب في TL-3 لا معاد توليده (HR-5).
- **الخيارات:** إعادة تقييم / تعديل توزيع / إبقاء مع تسجيل سبب. **إن لم يرد:** تنبيه متكرر [افتراض: يومياً حتى المعالجة] ولا بقاء للتوزيع المنقوض بلا معالجة (K-2/HR-7) — تبريد التنبيه يمنع الدوران (MIT-5).

### C-7: AGT-1 → HITL-3 — مسودة فعل لا رجعة فيه
- **البنية:** `{ action_draft: { draft_id, type: "نقل"|"تجهيز"|"إبلاغ", target, rationale, basis_forecast_id }, alternatives? }`.
- **التحقق:** توقع الأساس معتمد (HR-2)؛ المسودة بلا أي أمر تنفيذ — النظام لا يملك وسيلة تنفيذ أصلاً (DEC-9/HR-4).
- **الخيارات:** موافقة مسجلة → END-2 (التنفيذ بيد الإنسان خارج النظام) / رفض → END-1 (لا تنفيذ). **إن لم يرد:** الفعل لا يُنفَّذ (BR-4) — يبقى مسودة.

## نقاط الإنسان
### HITL-1
- **ما يُعرض:** التوقع المقترح (عدد + حالة لكل طفل متوقع) + أساسه الموثق + أي حقول ناقصة (EV-2). **الخيارات:** اعتماد / تعديل / رفض. **التوقيت:** دفعة يومية + تنبيه فوري للفئة «عالٍ» (DEC-5 ج). **المهلة وما يحدث بعدها:** بلا مهلة إجبارية — التوقع يبقى معلقاً بلا استخدام (BR-1).
### HITL-2
- **ما يُعرض:** التوقع المنقوض، المقياس الفعلي، الفارق، الموارد المحجوزة. **الخيارات:** إعادة تقييم / تعديل توزيع / إبقاء مع تسجيل السبب. **المهلة:** تنبيه متكرر حتى المعالجة — لا بقاء للتوزيع المنقوض بلا معالجة (K-2).
### HITL-3
- **ما يُعرض:** الفعل المقترح (مسودة) + التوقع الذي بُني عليه + بدائل إن وجدت. **الخيارات:** موافقة مسجلة → END-2 / رفض → END-1. **المهلة:** الفعل لا يُنفَّذ — لا تنفيذ آلي بديل (BR-4/DEC-9).

## جدول التتبع
| C-N | العقدة في S2 JSON | AGT/TL/HITL في S1 | UF/EV | HR/MIT |
|---|---|---|---|---|
| C-1 | s2-interactions-4 (سطر 1) | TL-1 + TB-1 | UF-1 / EV-1, EV-3 | HR-1, HR-11, MIT-1, MIT-2, MIT-9 |
| C-2 | s2-interactions-4 (سطر 2) | TL-2 | UF-1 / EV-1 | HR-5, HR-3, MIT-6 |
| C-3 | s2-interactions-4 (سطر 3) | TL-3 + TB-2 | UF-2 / EV-6, EV-4, EV-7 | HR-7, HR-11, MIT-9 |
| C-4 | s2-interactions-4 (سطر 4) | TL-4 | UF-1, UF-3 / EV-8, EV-5 | HR-2, HR-4, DEC-9 |
| C-5 | s2-interactions-4 (سطر 5) | HITL-1 + TB-3 | UF-1 | HR-8, MIT-6, DEC-5 |
| C-6 | s2-interactions-4 (سطر 6) | HITL-2 | UF-2 / EV-7 | HR-7, HR-8, MIT-5, K-2 |
| C-7 | s2-interactions-4 (سطر 7) | HITL-3 + END-1/END-2 | UF-3 / EV-5 | HR-4, HR-8, BR-4, DEC-9 |
