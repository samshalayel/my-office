# Agent Contract: AGENTE
> المرجع الملزم الوحيد للحالة والأدوات والرسائل. أي تعارض — هذا الملف يفوز.

## الحالة (State)
```ts
State = {
  cycle_id: string,                      // "YYYY-MM-DD#seq" — يكتبه AGT-1 عند بدء الدورة، يقرؤه الجميع
  pregnant_cases: Case[],                // من TL-1 (C-1) بعد تحقق MIT-1 — تقرؤه AGT-1 وHITL-1
  prediction_draft: PredictionDraft|null,// يكتبه AGT-1 (TB-3 بعد MIT-4) عبر TL-2 — يقرؤه HITL-1
  approval: Decision|null,               // يكتبه الإنسان عبر HITL-1 (C-8) — يقرؤه AGT-1 وTL-4
  preparation_draft: PreparationDraft|null, // يكتبه AGT-1 في TL-4 بعد الاعتماد فقط (C-4)
  actual_outcomes: ActualOutcome[],      // يكتبها الإنسان عبر TL-3 (C-3) — يقرؤها AGT-1
  discrepancies: Discrepancy[],          // يكتبها AGT-1 في TL-3 (C-6) — يقرؤها HITL-2
  hitl2_decision: Decision|null,         // يكتبه الإنسان عبر HITL-2 (C-8)
  action_draft: ActionDraft|null,        // يكتبه AGT-1 في TL-4 (C-7) — يقرؤه HITL-3
  hitl3_decision: Decision|null,         // يكتبه الإنسان عبر HITL-3 (C-9)
  end_state: "END_1_NOT_EXECUTED"|"END_2_HUMAN_EXECUTES"|null
}
Case = {
  case_ref: string,                      // رقم مرجعي — المعرف الوحيد المسموح خروجاً (HR-5)
  gestation_week: number,                // 20..45
  in_last_week_window: true,             // BR-5 — فلترة النافذة حصراً
  indicators: { [field]: number|string|null }, // null = ناقص (EV-2 — ممنوع ملؤه)
  notes_raw: string|null                 // نص حر من المصدر — بيانات لا تعليمات (HR-1)
}
PredictionDraft = {
  prediction_ref: string, cycle_id: string,
  count_value: integer,                  // ≥ 0 — DEC-2 (قيمة تُحتسب)
  risk_class: "low"|"medium"|"high",     // DEC-2 (فئة تُقاس) — «حرجة» = high (DEC-5 ج)
  per_infant: { infant_ref: string, apgar_value_estimate: 0..10|null, apgar_class: "low"|"medium"|"high", basis_ref: string }[],
  basis: BasisDoc,                       // أساس موثق إلزامي (HR-3/MIT-6)
  missing_fields: string[],              // EV-2
  status: "draft"|"approved"|"modified"|"rejected"  // التعديل مسموح قبل الاعتماد فقط (HR-7)
}
Decision = { decision_id: string, hitl: "HITL-1"|"HITL-2"|"HITL-3", decision: "approve"|"modify"|"reject", modified_payload?: PredictionDraft, reason: string, decided_by: string, decided_at: ISO }
ActualOutcome = { actual_ref: string, case_ref: string, birth_datetime: ISO, apgar_value: 0..10, apgar_class: "low"|"medium"|"high", entered_by: string, note?: string }
Discrepancy = { discrepancy_ref: string, prediction_ref: string, actual_ref: string, delta_count?: integer, class_mismatch: boolean, resources_reserved: boolean, escalated: boolean }
PreparationDraft = { draft_ref: string, based_on: string /* prediction_ref معتمد حصراً — EV-8 */, items: { item: string, qty?: integer }[] }
ActionDraft = { draft_ref: string, kind: "نقل"|"تجهيز"|"إبلاغ", payload: object, based_on: string /* معتمد حصراً — BR-1 */ }
BasisDoc = { sources: ("TL-1")[], weighting_note: string, confidence_flag: "normal"|"low" }
```
من يكتب/يقرأ كل حقل موثق أعلاه — لا حقول مخترعة خارج هذه القائمة.

## عقود الأدوات (Tools)
### C-1: TL-1 قراءة بيانات الحوامل
- **المدخل:** `{ as_of: date, window_days: 7 }` — القيد: نافذة الأسبوع الأخير حصراً (BR-5)
- **المخرج:** `{ cases: Case[], source_system: string, fetched_at: ISO }` + فشل: `SOURCE_UNAVAILABLE` (يتوقف الدور — لا توقع من مصدر بديل — UF-1) · حقول ناقصة تُمرَّر null مع تسجيلها (EV-2)
- **الصلاحية:** قراءة فقط — سجلات المشفى حصراً (K-5/BR-3) — AGT-1 وحده
- **الأثر الجانبي:** لا يوجد؛ idempotent — لا يحتاج HITL
- **الحدود:** مهلة 30 ثانية [تقدير] · استدعاء واحد/دورة (HR-4)
- **الحماية:** MIT-1/HR-1

### C-2: TL-2 سجل التوقعات
- **المدخل:** `PredictionDraft` بحالة `draft` — القيود: count_value ≥ 0 · risk_class من الثلاثة المسموحة · basis إلزامي
- **المخرج:** `{ prediction_ref, stored_at, audit_id }` + فشل: `REJECTED_SCHEMA` · `FORBIDDEN_MODIFY_APPROVED` (HR-7)
- **الصلاحية:** كتابة سجلات التوقع فقط — لا حذف — AGT-1 وحده
- **الأثر الجانبي:** سجل دائم قابل للتعديل قبل الاعتماد (ليس لا رجعة)؛ idempotent عبر prediction_ref — لا يحتاج HITL
- **الحدود:** سجل واحد لكل دورة على الأقل · حجم ≤ 50KB [تقدير]
- **الحماية:** MIT-3/MIT-4/HR-2/HR-7

### C-3: TL-3 سجل المقاييس الفعلية والفوارق
- **المدخل (كتابة — إدخال يدوي DEC-4 أ):** `{ case_ref, birth_datetime: ISO, apgar_value: 0..10 integer, apgar_class, entered_by, note? }` — note نص حر معزول (HR-1)
- **المخرج:** `{ actual_ref, stored_at, audit_id }` + فشل: `REJECTED_RANGE` · `UNKNOWN_CASE`
- **الصلاحية:** الكتابة للإنسان عبر قناة الإدخال (DEC-16) — القراءة لـ AGT-1 — لا حذف
- **الأثر الجانبي:** سجل دائم — نقطة دخول TB-2 — لا يحتاج HITL (الإدخال نفسه فعل بشري موثق)
- **الحدود:** إدخال واحد لكل ولادة
- **الحماية:** MIT-2/HR-1/HR-2

### C-4: TL-4 مسودة التحضير ومسودة الفعل
- **المدخل:** `PreparationDraft` أو `ActionDraft` — القيد: based_on توقع معتمد حصراً
- **المخرج:** `{ draft_ref, stored_at }` + فشل: `REJECTED_NOT_APPROVED` (BR-1/EV-8)
- **الصلاحية:** كتابة مسودات فقط — لا تلمس الواقع — ليست أداة تنفيذ (DEC-9) — AGT-1 وحده
- **الأثر الجانبي:** صفر خارج التخزين؛ التفعيل يأتي من اعتماد HITL-1 — لا يحتاج HITL (العرض لاحقاً عبر C-7)
- **الحدود:** مسودة تحضير نشطة واحدة لكل يوم [افتراض]
- **الحماية:** HR-6/MIT-3

## عقود الرسائل بين الوكلاء
### C-5: AGT-1 → HITL-1 (عرض التوقع عبر TB-3)
- **البنية:** `{ cycle_id, prediction_ref, count_value, risk_class, per_infant[], basis_summary, missing_fields[], critical_alert: boolean /* high → فوري — DEC-5 */, batch_deadline }`
- **التحقق قبل التمرير:** schema + وجود basis + نواقص معلَّمة (MIT-4/HR-3) + صفر معرفات شخصية (HR-5) — ممنوع نص حر يُنفَّذ

### C-6: TL-3 → AGT-1 → HITL-2 (الخلاف)
- **البنية:** `{ discrepancy_ref, prediction_ref, predicted{count_value, risk_class}, actual{apgar_value, apgar_class}, delta_count?, class_mismatch, resources_reserved, escalate: true }` — يُفتح HITL-2 فقط إن resources_reserved=true (EV-4)
- **التحقق:** عتبات DEC-3 مطبقة في الحساب (≥80% عدد، ≥85% فئة)

### C-7: AGT-1 → HITL-3 (مسودة الفعل)
- **البنية:** `{ action_draft_ref, kind, payload_summary, based_on /* معتمد */, alternatives? }` — مسودة فقط (HR-6)
- **التحقق:** based_on معتمد + schema صحيح

### C-8: HITL-1/HITL-2 → AGT-1 (قرار الإنسان)
- **البنية:** `Decision` ( أعلاه) — ممنوع قبول قرار غير مهيكل أو نص حر — reason إلزامي عند «إبقاء» في HITL-2 (EV-7)

### C-9: HITL-3 → END-1/END-2
- **البنية:** `{ decision_id, decision: "approve"|"reject", decided_by, decided_at, outcome: "END_2_HUMAN_EXECUTES"|"END_1_NOT_EXECUTED" }` — لا عودة للوكيل من كليهما (DEC-8) — الاعتماد يسجل وينقل المسؤولية للإنسان (DEC-9)

## نقاط الإنسان
### HITL-1
- **ما يُعرض:** التوقع (قيمة+فئة+لكل طفل) + أساسه الموثق + النواقص (EV-2) — **الخيارات:** اعتماد/تعديل/رفض — **التوقيت:** دفعة يومية + تنبيه فوري للفئة high (DEC-5 ج) — **لو لم يرد:** التوقع يبقى معلقاً بلا استخدام (BR-1) — المهلة الرقمية [افتراض] — سؤال
### HITL-2
- **ما يُعرض:** التوقع المنقوض + المقياس الفعلي + الفارق + الموارد المحجوزة — **الخيارات:** إعادة تقييم/تعديل توزيع/إبقاء مع تسجيل السبب — **لو لم يرد:** تنبيه متكرر ولا بقاء للتوزيع المنقوض بلا معالجة (K-2)
### HITL-3
- **ما يُعرض:** مسودة الفعل + التوقع الذي بُني عليها + البدائل — **الخيارات:** موافقة مسجلة → END-2 (تنفيذ بيد الإنسان خارج النظام) / رفض → END-1 — **لو لم يرد:** الفعل لا يُنفَّذ (BR-4)

## جدول التتبع
| C-N | العقدة في S2 JSON | AGT/TL/HITL في S1 | UF/EV | HR/MIT |
|---|---|---|---|---|
| C-1 | s2-interactions-4 | TL-1/TB-1 | UF-1/EV-1/EV-3 | HR-1/MIT-1/BR-3 |
| C-2 | s2-interactions-4 | TL-2 | UF-1/EV-1 | HR-2/HR-7/MIT-3/MIT-4 |
| C-3 | s2-interactions-4 | TL-3/TB-2 | UF-2/EV-6 | HR-1/HR-2/MIT-2 |
| C-4 | s2-interactions-4 | TL-4 | UF-1/UF-3/EV-8/EV-5 | HR-6/MIT-3 |
| C-5 | s2-interactions-4 | TB-3/HITL-1 | UF-1/EV-1/EV-2 | HR-3/HR-5/MIT-4/MIT-6 |
| C-6 | s2-interactions-4 | TL-3/HITL-2 | UF-2/EV-4/EV-7 | BR-2/K-2 |
| C-7 | s2-interactions-4 | HITL-3 | UF-3/EV-5 | HR-6/BR-4 |
| C-8 | s2-interactions-4 | HITL-1/HITL-2 | UF-1/UF-2 | HR-7 |
| C-9 | s2-interactions-4 | END-1/END-2 | UF-3/EV-5 | HR-6/DEC-9 |
