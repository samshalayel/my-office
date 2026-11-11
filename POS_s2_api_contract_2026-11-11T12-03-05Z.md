# API Contract: POS
> المرجع الملزم الوحيد للتواقيع. أي تعارض بين ملف آخر وهذا الملف — هذا الملف يفوز.
> المصادر المورّثة: `POS_s1_skill_2026-11-11T11-45-07Z.md` (v1.1) + ملحق `POS_s1_prd_amendment_2026-11-11T12-20-00Z.md` + `POS_s0_skill_2026-11-11T11-25-45Z.md`.

## الأنواع (Types)

```ts
Account {
  id: UUID
  name: string                          // فريد إلزامياً — يُفهرس
  type: 'customer' | 'supplier'         // customer = «ما لي»، supplier = «ما عليّ»
  transferStatus: 'pending' | 'transferred'  // حالة النقل التدريجي (س8-2)
  createdAt: ISODate
}

Entry {
  id: UUID
  kind: 'debt' | 'payment' | 'correction' | 'opening' | 'cash'
  accountId: UUID | null                // null فقط إذا kind = 'cash' (BR-8)
  amount: number                        // > 0 دائماً
  date: ISODate                         // الافتراضي: يوم التسجيل
  refEntryId: UUID | null               // يشير للحركة الأصلية عند kind = 'correction'
  note: string | null
  createdAt: ISODate                    // لحظة الإدخال الفعلية — لا تُعدَّل (BR-2)
}

AccountBalance {                        // محسوب — لا يُخزَّن أبداً (HR-2)
  totalDebt: number
  totalPaid: number
  remaining: number                     // قد يكون سالباً = رصيد معاكس (BR-5)
}
```

## العقود (Contracts)

### C-1: submitEntry
- **التوقيع:** `submitEntry(input: { kind: 'debt' | 'payment' | 'cash', accountId: UUID | null, amount: number, date?: ISODate }) → { accepted: boolean, entryId: UUID | null, balanceAfter: AccountBalance | null, error: string | null }`
- **الطبقة:** Logic (LedgerService) ← UI (EntryScreen)
- **القاعدة الصارمة المرتبطة:** HR-1, HR-3, HR-7
- **حالات الفشل:** مبلغ ≤ 0؛ طرف مفقود لحركة debt/payment؛ accountId لطرف غير موجود؛ kind مفقود — تُعاد `accepted: false` مع `error` واضح والحركة لا تُكتب. للنقدي: `balanceAfter: null` (لا يمس أرصدة).
- **مثال استدعاء:** `submitEntry({ kind: 'debt', accountId: 'a-77', amount: 1500, date: '2026-11-11' })` → `{ accepted: true, entryId: 'e-1042', balanceAfter: { totalDebt: 1500, totalPaid: 0, remaining: 1500 }, error: null }` · `submitEntry({ kind: 'cash', accountId: null, amount: 80 })` → `{ accepted: true, entryId: 'e-1043', balanceAfter: null, error: null }`

### C-2: createAccount
- **التوقيع:** `createAccount(input: { name: string, type: 'customer' | 'supplier' }) → { success: boolean, account: Account | null, error: string | null }`
- **الطبقة:** Logic (LedgerService) → Data (LedgerStore)
- **القاعدة الصارمة المرتبطة:** HR-5 (بلا دخول ولا صلاحيات), BR-1
- **حالات الفشل:** اسم مكرر (الفهرس الفريد)؛ name فارغ — لا يُنشأ حساب.
- **مثال استدعاء:** `createAccount({ name: 'أبو أحمد', type: 'customer' })` → `{ success: true, account: { id: 'a-77', name: 'أبو أحمد', type: 'customer', transferStatus: 'pending', createdAt: '2026-11-11T10:00:00.000Z' }, error: null }`

### C-3: submitCorrection
- **التوقيع:** `submitCorrection(input: { refEntryId: UUID, newAmount: number, note?: string }) → { accepted: boolean, correctionId: UUID | null, error: string | null }`
- **الطبقة:** Logic (LedgerService) ← UI (AccountLedgerView)
- **القاعدة الصارمة المرتبطة:** HR-3 (BR-2 — التصحيح عملية مرئية، الأصل لا يُلمس)
- **حالات الفشل:** refEntryId غير موجود؛ newAmount ≤ 0 — لا تُكتب حركة.
- **مثال استدعاء:** `submitCorrection({ refEntryId: 'e-1042', newAmount: 1200 })` → حركة correction جديدة تظهر في السجل تشير إلى e-1042.

### C-4: getAccountBalance
- **التوقيع:** `getAccountBalance(accountId: UUID) → AccountBalance | null`
- **الطبقة:** Logic (BalanceEngine)
- **القاعدة الصارمة المرتبطة:** HR-2 (كل رقم من السجل), BR-5 (السالب يُعاد كما هو = رصيد معاكس)
- **حالات الفشل:** طرف غير موجود → `null`.
- **مثال استدعاء:** حساب عليه قيود 3000 وتسديدات 1200 → `{ totalDebt: 3000, totalPaid: 1200, remaining: 1800 }`.

### C-5: getLedger
- **التوقيع:** `getLedger(accountId: UUID) → Entry[]`
- **الطبقة:** Logic (BalanceEngine) ← UI (AccountLedgerView)
- **القاعدة الصارمة المرتبطة:** HR-2, HR-3
- **حالات الفشل:** طرف غير موجود → `[]`.
- **مثال استدعاء:** سجل الدليل: قيود وتسديدات وتصحيحات الحساب مرتبة تصاعدياً بالتاريخ ثم createdAt.

### C-6: getDailyLog
- **التوقيع:** `getDailyLog(date: ISODate) → Entry[]`
- **الطبقة:** Logic (BalanceEngine) ← UI (DailyLogView)
- **القاعدة الصارمة المرتبطة:** HR-7 (تشمل النقدي بلا طرف)
- **حالات الفشل:** تاريخ بلا حركات → `[]`.
- **مثال استدعاء:** `getDailyLog('2026-11-11')` → كل حركات اليوم: ديون، تسديدات، نقدية، تصحيحات.

### C-7: searchAccounts
- **التوقيع:** `searchAccounts(query: string, type?: 'customer' | 'supplier') → Account[]`
- **الطبقة:** Logic → UI (AccountsDashboard, EntryScreen)
- **القاعدة الصارمة المرتبطة:** — (تخدم F-6: وصول سريع ضمن ~270 حساباً بلا تصفح يدوي)
- **حالات الفشل:** لا نتائج → `[]` (والواجهة توجّه لإنشاء الطرف عبر C-2).
- **مثال استدعاء:** `searchAccounts('أبو')` → قائمة الحسابات المطابقة من العميلين والمورّدين معاً.

### C-8: submitOpeningBalance
- **التوقيع:** `submitOpeningBalance(input: { accountId: UUID, amount: number, date?: ISODate }) → { accepted: boolean, entryId: UUID | null, error: string | null }`
- **الطبقة:** Logic (LedgerService) ← UI (OpeningTransferScreen)
- **القاعدة الصارمة المرتبطة:** HR-1 (للطرف), HR-8 غير معنية هنا؛ الحساب المقفل (transferred) يرفض القيد الافتتاحي (س8-2)
- **حالات الفشل:** الحساب transferStatus='transferred'؛ مبلغ ≤ 0؛ طرف غير موجود.
- **مثال استدعاء:** نقل رصيد دفتر 450 لعميل → حركة kind='opening' تدخل الثلاثية كدَين افتتاحي.

### C-9: completeTransfer
- **التوقيع:** `completeTransfer(accountId: UUID) → { success: boolean, error: string | null }`
- **الطبقة:** Logic (LedgerService) → Data (LedgerStore)
- **القاعدة الصارمة المرتبطة:** — (تنفّذ قرار س8-2: الحساب يُقفل عند اكتمال نقله)
- **حالات الفشل:** طرف غير موجود؛ الحساب مقفل أصلاً.
- **مثال استدعاء:** بعد نقل آخر رصيد لعميل → `transferStatus` يصير 'transferred' فلا يقبل C-8 بعدها.

## قيود التخزين (Storage Contract)
- **المحرك:** IndexedDB داخل متصفح موبايل المالك — بلا خادم، بلا مزامنة، بلا حسابات دخول (HR-4, HR-5, HR-6).
- **قاعدة البيانات:** `posLedger` (v1).
- **store `accounts`:** keyPath `id`؛ فهرس `name` **فريد**؛ فهرس `type`.
- **store `entries`:** keyPath `id`؛ فهرس `byAccount` على `[accountId, date]`؛ فهرس `byDate` على `date`؛ فهرس `byRef` على `refEntryId`.
- **نمط المفاتيح:** UUID لكل سجل؛ سجل الحساب يُقرأ تصاعدياً بالتاريخ ثم createdAt؛ حركة اليوم عبر فهرس `byDate`.
- **التفرد:** `name` فريد لكل حساب.
- **العمليات المسموحة:** add على المخزنين؛ get/getAll واستعلامات الفهارس للقراءة. التعديل الوحيد المسموح على أي بيانات: `transferStatus` في accounts (عبر C-9). **ممنوع نهائياً:** أي update/delete على entries (HR-3).
- **بوابات الكتابة والقراءة:** كل كتابة تمر عبر LedgerService حصراً؛ كل رقم يُشتق عبر BalanceEngine حصراً (HR-2). ممنوع لأي UI كتابة أو قراءة مباشرة من المخزن.

## جدول التتبع (Traceability)

| العقد | المكوّن في S2 JSON | الميزة/التدفق في S1 | القاعدة HR |
|---|---|---|---|
| C-1 | LedgerService (+ EntryScreen) | F-1, F-2, F-3, F-4, F-10 / UF-1..UF-4, UF-8 | HR-1, HR-3, HR-7 |
| C-2 | LedgerService | F-2, F-3, F-9 (إنشاء الحسابات أثناء النقل التدريجي) | HR-5 |
| C-3 | LedgerService (+ AccountLedgerView) | تصحيح ظاهر — BR-2 (تدفق التصحيح من سجل الحساب) | HR-3 |
| C-4 | BalanceEngine | F-4, F-5 / UF-2, UF-4, UF-5 | HR-2 |
| C-5 | BalanceEngine | F-4, F-7 / UF-5 | HR-2 |
| C-6 | BalanceEngine | F-10 / UF-8 | HR-7 |
| C-7 | AccountsDashboard (+ EntryScreen) | F-6 / UF-1, UF-3 | — |
| C-8 | LedgerService (+ OpeningTransferScreen) | F-9 / النقل التدريجي س8-2 | HR-1 |
| C-9 | LedgerService | F-9 / س8-2 (إقفال الحساب عند اكتمال نقله) | — |
