# API Contract: gaza_alley_networks — إدارة اشتراكات الشبكة
> المرجع الملزم الوحيد للتواقيع. أي تعارض بين ملف آخر وهذا الملف — هذا الملف يفوز.
> كل العقود أدناه مقترحات معمارية حتى اعتماد s2-gate-7 (السلطة: إنسان).

## الأنواع (Types)

```
Status = "active" | "suspended" | "cancelled"            // [افتراض] أسماء الحالات — قرار بشري

Subscriber {
  id: UUID
  name: string                    // إلزامي
  phone?: string                  // إن وُجد: فريد [افتراض]
  area?: string                   // المنطقة/المحل [افتراض]
  monthlyFee: number              // > 0 — ILS [افتراض]
  status: Status                  // مشتق من آخر StatusEvent — لا يُكتب مباشرة
  joinedAt: ISODate
  createdAt: ISODateTime
}

Payment {
  id: UUID
  subscriberId: UUID              // إلزامي — مشترك موجود
  amount: number                  // > 0
  monthKey: "YYYY-MM"             // الشهر الذي تسدده الدفعة (ADR-3)
  paidAt: ISODateTime
  method: "cash" | "transfer"
  ref?: string                    // مرجع/صورة إشعار التحويل
  note?: string
}

StatusEvent {
  id: UUID
  subscriberId: UUID
  from: Status
  to: Status
  at: ISODateTime
  reason?: string                 // مطلوب عملياً عند الإيقاف/الإلغاء [قرار مقترح]
}

Statement {
  subscriber: Subscriber
  payments: Payment[]             // مرتبة تصاعدياً بالتاريخ
  monthsUnpaid: "YYYY-MM"[]       // من شهر الانضمام حتى الشهر الجاري [افتراض] غير المغطاة بدفعة
  arrears: number                 // monthsUnpaid.length × monthlyFee — حساب الملغي يتوقف عند شهر تغييره إلى cancelled
}

Result<T> = { ok: true, data: T } | { ok: false, error: string }
```

## العقود (Contracts)

### C-1: registerSubscriber
- **التوقيع:** `registerSubscriber(input: { name: string, monthlyFee: number, phone?: string, area?: string, joinedAt?: ISODate }) → Result<{ id: UUID }>`
- **الطبقة:** Logic — SubscriptionService (يكتب عبر LocalStore)
- **القاعدة الصارمة المرتبطة:** —
- **حالات الفشل:** name فارغ → «الاسم مطلوب» · monthlyFee ≤ 0 أو غير رقمي → «الاشتراك الشهري لازم يكون رقماً أكبر من صفر» · phone مكرر (إن فعّل التفرد) → «الرقم مسجل لمشترك آخر»
- **مثال استدعاء:** `registerSubscriber({ name: "أبو أحمد", monthlyFee: 25, phone: "0599123456", area: "السوق" })` → `{ ok: true, data: { id: "b1c2d3e4" } }` (IDs في الأمثلة مختصرة توضيحياً)

### C-2: changeStatus
- **التوقيع:** `changeStatus(subscriberId: UUID, to: Status, reason?: string) → Result<StatusEvent>`
- **الطبقة:** Logic — SubscriptionService
- **القاعدة الصارمة المرتبطة:** HR-2 — لا أتمتة؛ الاستدعاء قرار بشري دائماً
- **الانتقالات المسموحة:** active ↔ suspended · أي حالة → cancelled · cancelled → (مفتوح ⚠ قرار بشري)
- **حالات الفشل:** مشترك غير موجود → «المشترك غير موجود» · الحالة الجديدة = الحالية → «الحالة نفسها — ما في تغيير» · انتقال غير مسموح → «انتقال حالة غير مسموح»
- **مثال استدعاء:** `changeStatus("b1c2d3e4", "suspended", "سافر عن الشهر")` → `{ ok: true, data: { id: "f6a7b8c9", from: "active", to: "suspended", at: "2026-11-10T13:30:00Z" } }`

### C-3: recordPayment
- **التوقيع:** `recordPayment(input: { subscriberId: UUID, amount: number, monthKey: "YYYY-MM", paidAt?: ISODateTime, method: "cash" | "transfer", ref?: string, note?: string }) → Result<{ id: UUID }>`
- **الطبقة:** Logic — PaymentService
- **القاعدة الصارمة المرتبطة:** HR-3 — السجل append-only؛ التسجيل الناقص لا يُعدّل لاحقاً بل يُصحح بقيد معاكس
- **حالات الفشل:** amount ≤ 0 → «المبلغ لازم يكون أكبر من صفر» · مشترك غير موجود → «المشترك غير موجود» · المشترك cancelled → «مشترك ملغي — أعد تفعيله قبل تسجيل دفعة» [قرار مقترح ⚠]
- **مثال استدعاء:** `recordPayment({ subscriberId: "b1c2d3e4", amount: 50, monthKey: "2026-11", method: "transfer", ref: "إشعار رقم 4471", paidAt: "2026-11-10T13:35:00Z" })` → `{ ok: true, data: { id: "d4e5f6a7" } }`

### C-4: getStatement
- **التوقيع:** `getStatement(subscriberId: UUID, fromMonth?: "YYYY-MM") → Result<Statement>`
- **الطبقة:** Logic — StatementBuilder (قراءة فقط عبر LocalStore)
- **القاعدة الصارمة المرتبطة:** HR-1 — كل رقم مشتق من السجلات فقط · HR-2 — لا قرار هنا، عرض فقط
- **حالات الفشل:** مشترك غير موجود → «المشترك غير موجود»
- **مثال استدعاء:** `getStatement("b1c2d3e4")` → `{ ok: true, data: { subscriber: { name: "أبو أحمد", monthlyFee: 25, status: "active" }, payments: [/* 2026-09، 2026-10 */], monthsUnpaid: ["2026-11"], arrears: 25 } }`

### C-5: exportMonthCsv
- **التوقيع:** `exportMonthCsv(monthKey: "YYYY-MM") → Result<{ fileName: string, csv: string }>`
- **الطبقة:** Logic — CsvExporter (قراءة فقط) — واجهة المستخدم تبدأ التنزيل من PaymentsScreen
- **القاعدة الصارمة المرتبطة:** — (الترميز والأعمدة: ADR-4)
- **صيغة الملف:** UTF-8 مع BOM · فاصلة `,` · صف لكل مشترك له حضور بالشهر (دفعة أو متأخرات) [افتراض] · الأعمدة الثابتة: `subscriber_name, phone, month_key, payments_count, total_paid, months_unpaid, arrears, status`
- **حالات الفشل:** لا دفعات في الشهر المطلوب → «ما في دفعات مسجلة للشهر المحدد» — بلا ملف فاضي
- **مثال استدعاء:** `exportMonthCsv("2026-11")` → `{ ok: true, data: { fileName: "gan-payments-2026-11.csv", csv: "subscriber_name,phone,…" } }`

## قيود التخزين (Storage Contract)
- **المحرك:** localStorage في متصفح جهاز المشغل الوحيد — لا سيرفر (ADR-1).
- **الصيغة:** JSON.
- **نمط المفاتيح:** `gan.subscribers` · `gan.payments` · `gan.statusEvents` · `gan.meta` (داخله `schemaVersion`).
- **التفرد:** id فريد لكل سجل (UUID v4) · subscribers.phone فريد إن وُجد [افتراض].
- **العمليات المسموحة بالترتيب:** قراءة كاملة عند إقلاع التطبيق → كتابة append عند C-1/C-2/C-3 → قراءة لحظية عند C-4/C-5 → تنزيل/رفع ملف JSON يدوي كنسخة احتياطية (إجراء مكمل خارج العقود).
- **ممنوع:** حذف أو تعديل أي عنصر في payments/statusEvents (HR-3) · أي مسار كتابة خارج العقود الخمسة · إضافة مفتاح تخزين جديد دون تسجيله في هذا العقد.

## جدول التتبع (Traceability)
| العقد | المكوّن في S2 JSON (s2-components-3) | الميزة/التدفق في S1 (سجل الموافقة 2026-11-10) | القاعدة HR |
|---|---|---|---|
| C-1 | SubscriptionService | F-1 تسجيل مشترك جديد | — |
| C-2 | SubscriptionService | F-4 تغيير حالة الاشتراك | HR-2 |
| C-3 | PaymentService | F-2 تسجيل دفعة لحظتها | HR-3 |
| C-4 | StatementBuilder | F-3 كشف حساب أمام المشترك | HR-1 |
| C-5 | CsvExporter | F-5 تصدير CSV نهاية الشهر | — |

> ملاحظة مفتوحة: حزمة S1 المعاد توليدها (json/prd/skill على هذه القائمة) مستحقة على مولّد S1 — عند وصولها يُضاف عمود UF-N إلى هذا الجدول، وأي تعارض يُحسم عند s2-gate-7.
