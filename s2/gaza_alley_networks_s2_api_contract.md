# API Contract: شبكات الحواري — غزة (gaza_alley_networks)
> المرجع الملزم الوحيد للتواقيع. أي تعارض بين ملف آخر وهذا الملف — هذا الملف يفوز.
> النطاق المقفول: F-1→F-5 (قرار الإنسان 2026-11-10) — لا عقد يخدم F-6 أو أي شيء خارج MVP.

## الأنواع (Types)

```ts
type Month = string; // "YYYY-MM"
type Party = string; // اسم الطرف كما في نسخة النسب
type ConfirmationNote = string; // نص توثيق تأكيد الأطراف (يُوثق خارج النظام — BR-5)

interface RevenueEntry {
  id: string;
  source: string;       // مصدر الإيراد — إلزامي (HR-1)
  amount: number;       // بعملة القسمة
  date: string;         // ISO
}

interface ExpenseEntry {
  id: string;
  reason: string;       // سبب المصروف — إلزامي (HR-1)
  amount: number;
  date: string;
  paid: boolean;
}

interface Statement {
  id: string;
  month: Month;
  revenueEntries: RevenueEntry[];
  expenseEntries: ExpenseEntry[];
  shareRuleVersion: number;             // نسخة النسب المستخدمة في الحسبة
  status: "open" | "finalized";
}

interface ShareRule {
  version: number;
  partyShares: { party: Party; percentage: number }[]; // مجموع النسب = 100 [افتراض — يؤكده الإنسان عند البوابة]
  confirmedByAll: boolean;              // true فقط بعد تأكيد كل الأطراف (HR-3)
  confirmedAt: string;                  // ISO — يُثبت عند التأكيد
}

interface Entitlement {
  id: string;
  beneficiary: string;                  // مثال: مرارم — فني الصيانة
  amount: number;
  reason: string;
  status: "pending" | "paid";
  paidAt: string | null;
}

interface LossProtocol {
  version: number;
  terms: string;                        // شروط توزيع المديونية وقت الخسارة
  confirmedByAll: boolean;              // HR-5
}

interface ArchivedStatement {
  statement: Statement;                 // نسخة مجمدة — read-only (HR-6)
  shareRuleVersion: number;
  closedAt: string;                     // ISO
  confirmationNote: ConfirmationNote;
}

interface Result {
  ok: boolean;
  message: string;
}
```

## العقود (Contracts)

### C-1: recordStatement — إدخال/تحديث كشف الشهر المفتوح
- **التوقيع:** `recordStatement(month: Month, revenueEntries: RevenueEntry[], expenseEntries: ExpenseEntry[]) → { ok: boolean, statementId: string, errors: string[] }`
- **الطبقة:** Data (عبر StatementEditor)
- **القاعدة الصارمة المرتبطة:** HR-7 (كتابة للكاتب الموثق فقط) · HR-1 (كل بند بمصدره)
- **حالات الفشل:** شهر مؤرشفة (read-only) → `ok: false` مع «الشهر مقفول — التصحيح بمستند جديد مرئي» · صلاحية ناقصة → رفض كتابة.
- **مثال استدعاء:** `recordStatement("2026-11", [{ id: "r1", source: "اشتراكات التوصيل", amount: 1200, date: "2026-11-05" }], [{ id: "x1", reason: "كابل بديل", amount: 90, date: "2026-11-07", paid: true }])` → `{ ok: true, statementId: "st-2026-11", errors: [] }`

### C-2: getSharedStatement — قراءة الكشف المشترك
- **التوقيع:** `getSharedStatement(month: Month) → Statement | null`
- **الطبقة:** Logic (تستهلكه StatementBoard وShareCalculator)
- **القاعدة الصارمة المرتبطة:** HR-1 (كل رقم بأصله ظاهر)
- **حالات الفشل:** لا كشف للشهر → `null` (الشاشة تعرض «لا يوجد كشف» — لا أرقام مختلقة).
- **مثال استدعاء:** `getSharedStatement("2026-11")` → كشف الشهر ببنوده وأصولها — تستهلكه كل الأطراف بنفس الشكل.

### C-3: saveShareRules — تدوين النسب وتأكيد الأطراف
- **التوقيع:** `saveShareRules(partyShares: { party: Party, percentage: number }[], confirmationNote: ConfirmationNote) → { ok: boolean, version: number }`
- **الطبقة:** Data (عبر ShareRulePanel)
- **القاعدة الصارمة المرتبطة:** HR-3 (تأكيد كل الأطراف — لا تعديل صامت) · HR-8 (النظام لا يقترح نسباً)
- **حالات الفشل:** تأكيد ناقص لأي طرف → `ok: false` مع اسم الطرف الناقص · نسخة قائمة مؤكدة → تُنشأ نسخة v أعلى، لا يُعدل القديمة.
- **مثال استدعاء:** `saveShareRules([{ party: "مدير الشبكة", percentage: 40 }, { party: "المالك", percentage: 40 }, { party: "الموزع", percentage: 20 }], "اتفاق شفوي موثق — مؤكد من الأطراف في اجتماع 2026-11-10")` → `{ ok: true, version: 1 }` [الأرقام مثال توضيحي — النسب الفعلية عُرف الأطراف]

### C-4: getActiveShareRules — قراءة النسخة المؤكدة
- **التوقيع:** `getActiveShareRules() → ShareRule | null`
- **الطبقة:** Logic (تستهلكه ShareCalculator وStatementBoard)
- **القاعدة الصارمة المرتبطة:** HR-2 (بلا نسخة مؤكدة — لا حسبة)
- **حالات الفشل:** لا نسخة مؤكدة → `null` — ShareCalculator يعلّق الحسبة برسالة واضحة، بلا حسبة افتراضية.
- **مثال استدعاء:** `getActiveShareRules()` → النسخة v{N} المقفولة — المرجع الوحيد للحسبة.

### C-5: recordEntitlement — تسجيل استحقاق قبل الصرف
- **التوقيع:** `recordEntitlement(beneficiary: string, amount: number, reason: string) → { ok: boolean, entitlementId: string }`
- **الطبقة:** Data (عبر EntitlementLedger)
- **القاعدة الصارمة المرتبطة:** HR-4 (يظهر على المصدر المشترك قبل صرفه)
- **حالات الفشل:** مبلغ أو سبب ناقص → رفض تسجيل · صلاحية ناقصة → رفض.
- **مثال استدعاء:** `recordEntitlement("مرارم", 150, "أجرة صيانة رفع نقطة المودم")` → `{ ok: true, entitlementId: "ent-001" }` [القيمة مثال توضيحي]

### C-6: markEntitlementPaid — قيد الصرف
- **التوقيع:** `markEntitlementPaid(entitlementId: string, paidAt: string) → { ok: boolean, message: string }`
- **الطبقة:** Data (عبر EntitlementLedger)
- **القاعدة الصارمة المرتبطة:** HR-4 (لا صرف إلا بعد الظهور على المصدر المشترك)
- **حالات الفشل:** استحقاق غير موجود → فشل · استحقاق `paid` مسبقاً → فشل مع منع التكرار.
- **مثال استدعاء:** `markEntitlementPaid("ent-001", "2026-11-12")` → `{ ok: true, message: "الاستحقاق مقيد" }`

### C-7: saveLossProtocol — تدوين بروتوكول الخسارة وتأكيده
- **التوقيع:** `saveLossProtocol(terms: string, confirmationNote: ConfirmationNote) → { ok: boolean, version: number }`
- **الطبقة:** Data (عبر LossProtocolPanel)
- **القاعدة الصارمة المرتبطة:** HR-5 (تأكيد كل الأطراف قبل أي خسارة)
- **حالات الفشل:** تأكيد ناقص → رفض · نسخة قائمة → نسخة جديدة v أعلى.
- **مثال استدعاء:** `saveLossProtocol("لو طلع الحساب خسران: توزيع الخسارة بنفس أنصاب القسمة", "مؤكد من الأطراف 2026-11-10")` → `{ ok: true, version: 1 }`

### C-8: viewLossPosition — عرض موقف المديونية وقت الخسارة
- **التوقيع:** `viewLossPosition(month: Month) → { deficit: number, allocation: { party: Party, share: number }[], protocolVersion: number }`
- **الطبقة:** Logic (عبر LossProtocolPanel — عرض فقط)
- **القاعدة الصارمة المرتبطة:** HR-5 · HR-8 (العرض لا يقرر)
- **حالات الفشل:** لا بروتوكول مؤكد → رسالة صريحة «لا يوجد بروتوكول — لا تنزيل» (بلا وضع افتراضي مخفي).
- **مثال استدعاء:** `viewLossPosition("2026-11")` → موقف الخسارة موزعاً وفق شروط النسخة v{N} الحصراً.

### C-9: archiveStatement — إغلاق الشهر وأرشفته
- **التوقيع:** `archiveStatement(month: Month, confirmationNote: ConfirmationNote) → { ok: boolean, archiveKey: string }`
- **الطبقة:** Data (عبر StatementEditor — الكاتب الموثق)
- **القاعدة الصارمة المرتبطة:** HR-6 (النسخة المجمدة read-only) · BR-5 (التأكيد الجماعي موثق خارج النظام — نصه يُسجل هنا)
- **حالات الفشل:** شهر مؤرشفة سابقاً → فشل (لا أرشفة مكررة) · شهر بلا كشف → فشل.
- **مثال استدعاء:** `archiveStatement("2026-11", "تأكيد الأطراف موثق خارج النظام — الكل قبلوا الكشف")` → `{ ok: true, archiveKey: "archive/2026/11" }`

### C-10: getArchivedStatement — قراءة الأرشيف
- **التوقيع:** `getArchivedStatement(year: string, month: string) → ArchivedStatement | null`
- **الطبقة:** Data (تستهلكه ArchiveView — قراءة بحتة)
- **القاعدة الصارمة المرتبطة:** HR-6 (بنفس أرقامها — لا تعديل)
- **حالات الفشل:** لا أرشيف للشهر → `null`.
- **مثال استدعاء:** `getArchivedStatement("2026", "11")` → النسخة المجمدة — يقطع الجدال على أرقام الشهر.

## قيود التخزين (Storage Contract)

- **المخزن:** مركزي وحيد (ADR-1) — قراءة للجميع، كتابة عبر عقود الكاتب الموثق فقط (HR-7).
- **نمط المفاتيح:**
  - `statement/{year}/{month}` — كشف الشهر المفتوح/النهائي (JSON واحد ببنوده).
  - `share_rules/v{N}` — نسخ النسب؛ v يتزايد، النسخة المؤكدة immutable (HR-3).
  - `entitlements/{id}` — سجل الاستحقاقات وحالتها.
  - `loss_protocol/v{N}` — نسخ البروتوكول؛ النسخة المؤكدة immutable (HR-5).
  - `archive/{year}/{month}` — النسخ المجمدة — read-only نهائياً (HR-6).
- **الصيغة:** JSON — الأنواع أعلاه هي المخطط الملزم.
- **قيود التفرد:** كشف واحد لكل شهر؛ استحقاق واحد بـ id واحد؛ رقم نسخة لا يتكرر.
- **العمليات المسموحة بالترتيب:** إنشاء نسخة نسب (C-3) → تأكيدها → إنشاء كشف (C-1) → قراءته (C-2) → تسجيل استحقاق (C-5) → قيد صرفه (C-6) → إغلاق وأرشفة (C-9) → قراءة الأرشيف (C-10). بروتوكول الخسارة (C-7) يُنشأ ويتأكد قبل أول خسارة، وقراءته (C-8) عند وقوعها.
- **قيد الحذف:** لا حذف لأي كيان — التصحيح بمستند/نسخة جديدة مرئية (HR-6).

## جدول التتبع (Traceability)

| العقد | المكوّن في S2 JSON | الميزة/التدفق في S1 | القاعدة HR |
|---|---|---|---|
| C-1 | StatementEditor | F-1 · UF-2 | HR-7, HR-1 |
| C-2 | StatementBoard | F-1 · UF-2, UF-3 | HR-1 |
| C-3 | ShareRulePanel | F-2 · UF-1 | HR-3, HR-8 |
| C-4 | ShareCalculator | F-2 · UF-2 | HR-2 |
| C-5 | EntitlementLedger | F-3 · UF-4 | HR-4 |
| C-6 | EntitlementLedger | F-3 · UF-4 | HR-4 |
| C-7 | LossProtocolPanel | F-4 · UF-5 | HR-5 |
| C-8 | LossProtocolPanel | F-4 · UF-5 | HR-5, HR-8 |
| C-9 | StatementEditor | F-5 · UF-3 | HR-6 |
| C-10 | ArchiveView | F-5 · UF-6 | HR-6 |

> ملاحظة النطاق: لا يوجد عقد لـ F-6 (قفل القسمة) — خارج MVP بقرار الإنسان 2026-11-10. التأكيد الجماعي يوثق خارج النظام (BR-5) ويُسجل نصه عبر C-9.
