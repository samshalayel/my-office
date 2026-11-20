# API Contract: AGENTE — S3 (Detailed) — الجزء 2: رسائل القرار الإنساني (C-5..C-9)
> يرث AGENTE_s2_api_contract.md حرفياً — S2 يفوز في التواقيع، S3 في تفاصيل التنفيذ.

## C-5: AGT-1 → HITL-1 عرض التوقع (توليد في agent — عرض في hitl)
- **التوقيع (S2 حرفياً):** { cycle_id, prediction_ref, count_value, risk_class, per_infant[], basis_summary, missing_fields[], critical_alert: boolean /* high → فوري — DEC-5 */, batch_deadline }
- **التحقق قبل التمرير (S2 حرفياً):** schema + وجود basis + نواقص معلَّمة (MIT-4/HR-3) + صفر معرفات شخصية (HR-5) — ممنوع نص حر يُنفَّذ
- **خطوات التنفيذ:** تجميع الحزمة بعد تحقق agent-T5 → إدراج critical_alert إذا risk_class=high (DEC-5 ج) → عرض في واجهة القرار (hitl-T1) بأساس ونواقص ظاهرين (MIT-6)
- **حالات الحافة:** basis مفقود → لا عرض إطلاقاً (HR-3 — RT-5) · معرف شخصي مكتشف → يمنع العرض ويصعّد (RT-6) · دفعة يومية + تنبيه فوري للفئة high · لم يرد القرار → التوقع يبقى معلقاً بلا استخدام (BR-1)
- **مثال:** { cycle_id: "2026-11-20#1", prediction_ref: "P-2026-11-20-01", count_value: 3, risk_class: "high", per_infant: [ { infant_ref: "I-01", apgar_value_estimate: 5, apgar_class: "high", basis_ref: "B-01" } ], basis_summary: "مؤشران أساسيان + ولادة خديج سابقة", missing_fields: ["weight_gain"], critical_alert: true, batch_deadline: "2026-11-20T09:00:00Z" }

## C-6: TL-3 → AGT-1 → HITL-2 الخلاف (agent + hitl)
- **التوقيع (S2 حرفياً):** { discrepancy_ref, prediction_ref, predicted{count_value, risk_class}, actual{apgar_value, apgar_class}, delta_count?, class_mismatch, resources_reserved, escalate: true } — يُفتح HITL-2 فقط إن resources_reserved=true (EV-4) — عتبات DEC-3 (≥80% عدد، ≥85% فئة)
- **حساب الفوارق بلا عدّ مزدوج:** كل Discrepancy تولد مرة واحدة لكل زوج (prediction_ref, actual_ref)؛ إدخال مقياس جديد لا يعيد حساب فارق قديم؛ أي تصحيح لاحق يمر بقرار HITL-2 مسجل (HR-7) وليس بإعادة حساب رجعية
- **مثال رقمي:** توقع count_value=3 (فئة medium) — فعلياً 4 مواليد → delta_count = 4 − 3 = +1 → مطابقة العدد 3/4 = 75% < 80% → خلاف عدد · الفئة: متطابقتان من 4 = 50% < 85% → class_mismatch=true · إن كان للتوقع موارد محجوزة → escalate=true → HITL-2
- **حالات الحافة:** مقياس بلا توقع مطابق → discrepancy مع resources_reserved=false ولا يفتح HITL-2 (BR-2/EV-4) · لم يرد الإنسان → تنبيه متكرر ولا بقاء للتوزيع المنقوض (K-2)

## C-7: AGT-1 → HITL-3 مسودة الفعل (agent + hitl)
- **التوقيع (S2 حرفياً):** { action_draft_ref, kind, payload_summary, based_on /* معتمد */, alternatives? } — مسودة فقط (HR-6) — تحقق: based_on معتمد + schema صحيح
- **حالات الحافة:** based_on غير معتمد → لا توليد مسودة فعل (BR-1) · kind خارج «نقل/تجهيز/إبلاغ» → رفض · لم يرد الإنسان → الفعل لا يُنفَّذ (BR-4)
- **مثال:** { action_draft_ref: "AD-001", kind: "تجهيز", payload_summary: "تجهيز حاضنتين لحالة high", based_on: "P-2026-11-20-01", alternatives: ["إبلاغ وحدة العناية مبكراً"] }

## C-8: HITL-1/HITL-2 → AGT-1 قرار الإنسان (hitl)
- **التوقيع (S2 حرفياً):** Decision = { decision_id, hitl: "HITL-1"|"HITL-2"|"HITL-3", decision: "approve"|"modify"|"reject", modified_payload?: PredictionDraft, reason, decided_by, decided_at } — ممنوع قبول قرار غير مهيكل أو نص حر — reason إلزامي عند «إبقاء» في HITL-2 (EV-7)
- **خطوات التنفيذ:** الواجهة تعرض أزرار/نماذج فقط (لا نص حر) → استقبال Decision مهيكلة → تسجيل في audit (C-12) وسجل النقاط الإنسانية (BASE-A6) → تمرير للوكيل
- **حالات الحافة:** نص حر كقرار → رفض البنية · قرار بلا هوية موافق → مرفوض · «تعديل» بلا modified_payload → مرفوض
- **مثال:** { decision_id: "DEC-2026-11-20-07", hitl: "HITL-1", decision: "approve", reason: "الأساس كافٍ والفئة عالية", decided_by: "صاحب الحضانة", decided_at: "2026-11-20T08:12:00Z" }

## C-9: HITL-3 → END-1/END-2 نهاية الدورة (hitl)
- **التوقيع (S2 حرفياً):** { decision_id, decision: "approve"|"reject", decided_by, decided_at, outcome: "END_2_HUMAN_EXECUTES"|"END_1_NOT_EXECUTED" } — لا عودة للوكيل من كليهما (DEC-8) — الاعتماد يُسجل وينقل التنفيذ للإنسان خارج النظام (DEC-9)
- **حالات الحافة:** لم يرد → لا END ولا فعل (BR-4) — يبقى معلقاً بتنبيه · الاعتماد لا ينفّذ شيئاً آلياً (HR-6)
- **مثال:** { decision_id: "DEC-2026-11-21-02", decision: "approve", decided_by: "صاحب الحضانة", decided_at: "2026-11-21T04:05:00Z", outcome: "END_2_HUMAN_EXECUTES" }
