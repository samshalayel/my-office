# API Contract: AGENTE — S3 (Detailed) — الجزء 1: الأدوات والتخزين (C-1..C-4)
> يرث AGENTE_s2_api_contract.md حرفياً. عند التعارض: S2 يفوز في التواقيع، S3 يفوز في تفاصيل التنفيذ.
> الأجزاء: (1) هذا الملف · (2) AGENTE_s3_api_contract_messages.md (C-5..C-9 رسائل القرار) · (3) AGENTE_s3_api_contract_internal.md (C-10..C-15 الجديدة + Cross-Slice). سبب التقسيم: حد حجم أداة الحفظ.

## فهرس العقود حسب الشريحة
| الشريحة | العقود الموروثة C-N | عقود داخلية جديدة |
|---|---|---|
| base | C-2, C-3, C-4 (طبقة التخزين) | C-10..C-14 (الجزء 3) |
| tools | C-1, C-2, C-3, C-4 (تنفيذ الأدوات) | — |
| agent | C-2, C-4, C-5, C-6, C-7 | C-15 (الجزء 3) |
| hitl | C-3, C-5, C-6, C-7, C-8, C-9 | — |
| verify | C-13 (تشغيل EV/RT) | — |

## الأنواع (مصدر الحقيقة — منسوخة من S2)
State وCase وPredictionDraft وDecision وActualOutcome وDiscrepancy وPreparationDraft وActionDraft وBasisDoc — **كما في AGENTE_s2_api_contract.md §الحالة حرفياً — لا حقول مخترعة.** ملخص الحقول (من JSON المعتمد):
- State: cycle_id · pregnant_cases[] · prediction_draft · approval · preparation_draft · actual_outcomes[] · discrepancies[] · hitl2_decision · action_draft · hitl3_decision · end_state
- Case: case_ref (المرجع الرقمي الوحيد المسموح خروجاً — HR-5) · gestation_week 20..45 · in_last_week_window (BR-5) · indicators (null = ناقص — EV-2) · notes_raw (نص حر معزول — HR-1)
- PredictionDraft: prediction_ref · cycle_id · count_value ≥ 0 · risk_class low|medium|high («حرجة» = high — DEC-5 ج) · per_infant[] · basis (BasisDoc إلزامي — HR-3) · missing_fields[] · status draft|approved|modified|rejected (التعديل قبل الاعتماد فقط — HR-7)

## C-1: TL-1 قراءة بيانات الحوامل (تنفيذ في tools)
- **التوقيع (S2 حرفياً):** مدخل { as_of: date, window_days: 7 } — نافذة الأسبوع الأخير حصراً (BR-5) · مخرج { cases: Case[], source_system, fetched_at } · فشل: SOURCE_UNAVAILABLE
- **خطوات التنفيذ:** اتصال بسجلات المشفى → فلترة النافذة → تحويل كل حامل إلى Case (null للناقص مع تسجيله — EV-2) → فصل notes_raw نصاً معزولاً (MIT-1/HR-1) → إرجاع المغلف. استدعاء واحد/دورة (HR-4) ومهلة من C-11
- **حالات الحافة:** المصدر غير متاح → SOURCE_UNAVAILABLE ويوقف الدور بلا توقع بديل (UF-1/EV-3) · حامل خارج النافذة → لا يُرجع · notes_raw يحمل تعليمات → يبقى نصاً معزولاً (RT-1)
- **مثال:** { as_of: "2026-11-20", window_days: 7 } → { cases: [ { case_ref: "H-1042", gestation_week: 33, in_last_week_window: true, indicators: { bp: 148, weight_gain: 9.5, previous_preterm: 1 }, notes_raw: "ملاحظة الطبيب…" } ], source_system: "hosp-records", fetched_at: "2026-11-20T06:00:00Z" }

## C-2: TL-2 سجل التوقعات (تنفيذ في tools — تخزين في base)
- **التوقيع (S2 حرفياً):** مدخل PredictionDraft بحالة draft — count_value ≥ 0 · risk_class من الثلاثة · basis إلزامي · مخرج { prediction_ref, stored_at, audit_id } · فشل: REJECTED_SCHEMA · FORBIDDEN_MODIFY_APPROVED (HR-7)
- **خطوات التنفيذ:** تحقق مخطط (MIT-4) → فحص قفل المعتمد (HR-7) → كتابة في SQLite + سطر audit (C-12) في معاملة واحدة → إرجاع المعرّفات
- **حالات الحافة:** basis مفقود → رفض (HR-3) · تعديل سجل معتمد → FORBIDDEN_MODIFY_APPROVED (RT-3) · قيمة خارج المدى → REJECTED_SCHEMA (رفض لا تصحيح — HR-2) · لا حذف أصلاً في العقد
- **مثال:** { prediction_ref: "P-2026-11-20-01", stored_at: "2026-11-20T06:01:10Z", audit_id: "A-000131" }

## C-3: TL-3 سجل المقاييس الفعلية والفوارق (تنفيذ في tools — إدخال عبر hitl — تخزين في base)
- **التوقيع (S2 حرفياً):** مدخل كتابة { case_ref, birth_datetime: ISO, apgar_value: 0..10 integer, apgar_class, entered_by, note? } — note نص حر معزول (HR-1) · مخرج { actual_ref, stored_at, audit_id } · فشل: REJECTED_RANGE · UNKNOWN_CASE
- **خطوات التنفيذ:** تحقق بنيوي (MIT-2) → رفض خارج المدى لا تصحيح (HR-2) → كتابة + audit → قراءة الفوارق لاحقاً عبر C-6
- **حالات الحافة:** apgar=17 → REJECTED_RANGE (RT-2) · case_ref غير معروف → UNKNOWN_CASE · إدخال ثانٍ لنفس الولادة → مرفوض (إدخال واحد لكل ولادة) · note تحمل تعليمات → معزولة (RT-2)
- **مثال:** { case_ref: "H-1042", birth_datetime: "2026-11-21T03:40:00Z", apgar_value: 6, apgar_class: "medium", entered_by: "صاحب الحضانة" } → { actual_ref: "A-2026-11-21-01", stored_at: "…", audit_id: "A-000147" }

## C-4: TL-4 مسودة التحضير ومسودة الفعل (تنفيذ في tools — تفعيل عبر hitl — تخزين في base)
- **التوقيع (S2 حرفياً):** مدخل PreparationDraft أو ActionDraft — القيد based_on توقع معتمد حصراً · مخرج { draft_ref, stored_at } · فشل: REJECTED_NOT_APPROVED (BR-1/EV-8)
- **خطوات التنفيذ:** التحقق أن based_on توقع بحالة approved → كتابة المسودة + audit. لا تفعيل لأي شيء في الواقع — لا أداة تنفيذ (DEC-9/HR-6)
- **حالات الحافة:** based_on غير معتمد → REJECTED_NOT_APPROVED (EV-8/RT-3) · مسودة تحضير نشطة واحدة لكل يوم [افتراض من S2] · أي «تنفيذ» → مستحيل بنيوياً (لا توجد أداة تنفيذ — DEC-9)
- **مثال:** { draft_ref: "D-001", based_on: "P-2026-11-20-01", items: [ { item: "حاضنات جاهزة", qty: 2 } ] }
