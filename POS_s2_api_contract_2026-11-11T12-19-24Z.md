# API Contract: POS
> المرجع الملزم الوحيد للتواقيع. أي تعارض بين ملف آخر وهذا الملف — هذا الملف يفوز.
> مبني على: `POS_gate_2026-11-11T12-20-00Z.md` (s1-gate-7 = approved) + ملحق PRD + `POS_s1_skill v1.1` + S0.

## الأنواع (Types)
```
Side = 'client' | 'supplier'

EntryType = 'debt_client'         // دَين على عميل (يزيد ما لي)
          | 'debt_supplier'       // دَين على صاحب المتجر لمورّد (يزيد ما عليّ)
          | 'payment_from_client' // تسديد من عميل (ينقص ما لي)
          | 'payment_to_supplier' // تسديد لمورّد (ينقص ما عليّ)
          | 'cash_sale'           // بيع نقدي — بلا طرف ولا أثر على الأرصدة (BR-8)
          | 'opening'             // قيد افتتاحي لنقل الدفتر الورقي (F-9, س8-2)

Account {
  id: UUID
  name: string                 // فريد داخل side
  side: Side                   // ثابت بعد الإنشاء
  ledgerTransfer: 'open' | 'completed'   // س8-2: يُقفل عند اكتمال النقل — لا يمنع أي عملية
  createdAt: ISODateTime
}

Entry {
  id: UUID
  type: EntryType              // إلزامي صريح — لا افتراض (BR-8)
  accountId?: UUID             // إلزامي لكل الأنواع إلا cash_sale (BR-1, BR-8)
  amount: number               // > 0  [تفصيل يحتاج تأكيداً بشرياً عند البوابة]
  ts: ISODateTime              // الافتراضي: لحظة التسجيل
  note?: string
  linkedTo?: UUID              // في عملية تصحيح: معرّف العملية الأصل (BR-2)
}

DerivedBalance {
  totalDebt: number            // مجموع الدَّين على الحساب
  totalPaid: number            // مجموع المسدَّد
  balance: number              // المتبقي — يسمح بالقيمة المعاكسة وفق BR-5 (س8-3)
}

NewEntry { type: EntryType, accountId?: UUID, amount: number, ts?: ISODateTime, note?: string }

EntryResult    { ok: boolean, entry?: Entry, errors?: string[] }
AccountResult  { ok: boolean, account?: Account, errors?: string[] }
AccountSummary { account: Account, summary: DerivedBalance, entries: Entry[] }   // entries بالترتيب الزمني مع علامات «مُصحّح»
AccountRow     { accountId: UUID, name: string, side: Side, balance: number, summary: DerivedBalance, ledgerTransfer: 'open' | 'completed' }
DayLogRow      { entryId: UUID, ts: ISODateTime, type: EntryType, label: string, amount: number, accountId?: UUID }
```

## العقود (Contracts)
### C-1: addEntry
- **التوقيع:** `addEntry(entry: NewEntry) → EntryResult`
- **الطبقة:** UI-event (QuickEntryForm) → Logic (EntryValidator) → Data (LedgerStore → LocalDatabase)
- **القاعدة الصارمة المرتبطة:** HR-4, HR-5, HR-3 (كتابة append-only فقط)
- **سلوك الاحتساب:** `debt_*` يزيد، `payment_*` ينقص، `cash_sale` لا يمس أي رصيد (BR-8)، `opening` رصيد ابتدائي لحساب أثناء النقل (F-9).
- **حالات الفشل:** نوع مفقود أو غير معروف → `errors: ['نوع القيد مطلوب']`؛ طرف مفقود لنوع غير `cash_sale` → `errors: ['حساب الطرف مطلوب']`؛ مبلغ ≤ 0 → `errors: ['المبلغ يجب أن يكون أكبر من صفر']` [تفصيل تفضيلي — يُؤكد عند البوابة]؛ تسديد زائد عن الرصيد **ليس فشلاً** — يُقبل ويُعرض كقيمة معاكسة (BR-5, HR-10).
- **مثال استدعاء:** `addEntry({ type: 'cash_sale', amount: 3500 })` → `{ ok: true, entry: { id: '…', type: 'cash_sale', amount: 3500, ts: '2026-11-11T10:30:00', … } }` — ولا يتغير أي رصيد (AC-8).

### C-2: findOrCreateAccount
- **التوقيع:** `findOrCreateAccount(name: string, side: Side) → AccountResult`
- **الطبقة:** UI-event (QuickEntryForm عبر SearchProvider) → Data (LedgerStore)
- **القاعدة الصارمة المرتبطة:** HR-6 (مستخدم واحد؛ لا حسابات دخول) — الحساب طرف في السجل لا مستخدم.
- **حالات الفشل:** اسم فارغ → `errors: ['الاسم مطلوب']`؛ حساب موجود بنفس الاسم داخل نفس side يُعاد بدون إنشاء نسخة.
- **مثال استدعاء:** `findOrCreateAccount('أبو أحمد', 'client')` → `{ ok: true, account: { id: '…', name: 'أبو أحمد', side: 'client', ledgerTransfer: 'open', createdAt: '…' } }`

### C-3: getAccountSummary
- **التوقيع:** `getAccountSummary(accountId: UUID) → AccountSummary`
- **الطبقة:** UI (AccountLedgerView) → Logic (BalanceCalculator) → Data (LedgerStore)
- **القاعدة الصارمة المرتبطة:** HR-2, HR-8 (كل رقم من السجل)؛ BR-3, BR-4 (الثلاثية دائماً)
- **حالات الفشل:** معرّف غير موجود → `errors: ['الحساب غير موجود']`.
- **مثال استدعاء:** `getAccountSummary('A-017')` → `{ account: …, summary: { totalDebt: 12000, totalPaid: 7500, balance: 4500 }, entries: [ … بالترتيب الزمني … ] }` [أرقام المثال توضيحية للصيغة لا افتراض أداء]

### C-4: listAccountSummaries
- **التوقيع:** `listAccountSummaries(side: Side, query?: string) → AccountRow[]`
- **الطبقة:** UI (AccountsDashboard) → Logic (BalanceCalculator + SearchProvider) → Data (LedgerStore)
- **القاعدة الصارمة المرتبطة:** HR-8؛ F-5 (أرصدة لحظية في أي لحظة)؛ F-6 (بحث سريع ضمن ~250 عميلاً و~20 مورّداً)
- **حالات الفشل:** لا يفشل — `query` بلا نتائج تعيد قائمة فارغة والشاشة تعرضها.
- **مثال استدعاء:** `listAccountSummaries('client', 'أبو')` → `[{ accountId: 'A-017', name: 'أبو أحمد', balance: 4500, … }, …]`

### C-5: correctEntry
- **التوقيع:** `correctEntry(originalId: UUID, correctedAmount: number, note?: string) → EntryResult`
- **الطبقة:** UI-event (AccountLedgerView) → Logic (EntryValidator) → Data (LedgerStore)
- **القاعدة الصارمة المرتبطة:** HR-3 (لا تعديل ولا حذف — التصحيح عملية جديدة مرتبطة بالأصل)
- **السلوك:** الأصل يبقى ظاهراً بعلامة «مُصحّح» ويستبعد من الاحتساب، وعملية التصحيح تدخل به بدلاً منه عبر `linkedTo` (ADR-4).
- **حالات الفشل:** أصل غير موجود → `errors: ['العملية الأصلية غير موجودة']`؛ مبلغ ≤ 0 → كما في C-1 [تفصيل تفضيلي].
- **مثال استدعاء:** `correctEntry('E-0203', 1800, 'الصحيح 1800 لا 18000')` → `{ ok: true, entry: { type: 'payment_from_client', linkedTo: 'E-0203', amount: 1800, … } }`

### C-6: markAccountMigrated
- **التوقيع:** `markAccountMigrated(accountId: UUID) → AccountResult`
- **الطبقة:** UI-event (OpeningMigrationPanel) → Data (LedgerStore)
- **القاعدة الصارمة المرتبطة:** HR-9 (نقل تدريجي + إقفال عند الاكتمال — س8-2)
- **السلوك:** يضبط `ledgerTransfer: 'completed'` — علم عرض يوثق اكتمال النقل؛ لا يمنع أي عملية لاحقة على الحساب.
- **حالات الفشل:** حساب غير موجود → `errors: ['الحساب غير موجود']`؛ مُنقل مسبقاً → يعيد النتيجة كما هي بلا تغيير (عملية idempotent).
- **مثال استدعاء:** `markAccountMigrated('A-031')` → `{ ok: true, account: { …, ledgerTransfer: 'completed' } }`

### C-7: getDayLog
- **التوقيع:** `getDayLog(date: ISODate) → DayLogRow[]`
- **الطبقة:** UI (DayLedgerView) → Logic (BalanceCalculator) → Data (LedgerStore)
- **القاعدة الصارمة المرتبطة:** HR-8؛ BR-8 (النقدي هنا فقط وبلا أثر على الأرصدة)؛ AC-8
- **حالات الفشل:** لا يفشل — يوم بلا عمليات يعيد قائمة فارغة.
- **مثال استدعاء:** `getDayLog('2026-11-11')` → `[{ entryId: '…', type: 'cash_sale', label: 'بيع نقدي', amount: 3500, … }, { entryId: '…', type: 'debt_client', label: 'دَين عميل — أبو أحمد', amount: 5000, accountId: 'A-017' }]`

> ملاحظة نطاق: الأوفلاين (F-8) والبحث (F-6) قدَران بنيتان لا عقوداً مستقلة: أوفلاين عبر Service Worker + التخزين المحلي (HR-1)، والبحث عبر C-4/C-2.

## قيود التخزين (Storage Contract)
- **المخزن:** IndexedDB محلي على جهاز صاحب المتجر — لا خادم ولا سحابة (HR-1).
- **المخازن (Object Stores):**
  - `entries` — المفتاح `id`؛ فهارس: `ts` (ترتيب زمني)، `accountId` (استعلام بحساب)، `type` (فلترة النقدي/الأجل).
  - `accounts` — المفتاح `id`؛ فهارس: `side`، فهرس مركب `[side, name]` للبحث (F-6) مع تفرد `name` داخل `side`.
  - `meta` — `schemaVersion` وبيانات تهيئة الصورة الواردة من F-9 فقط.
- **نمط المفاتيح:** `UUID` للسجلات؛ لا مفاتيح مشتقة من نصوص المستخدم.
- **الصيغة:** سجل عمليات append-only (ADR-3) — العمليات لا تُعدَّل ولا تُحذف أبداً (HR-3).
- **عمليات القراءة/الكتابة المسموحة (بالترتيب):**
  1. `appendEntry(entry)` — الكتابة الوحيدة على `entries` (C-1, C-5).
  2. `findOrCreateAccountRecord(name, side)` / `markAccountRecordMigrated(id)` — كتابتا `accounts` الوحيدتان (C-2, C-6).
  3. `getEntriesByAccount(id)` — لـ C-3/C-5.
  4. `getEntriesByDay(date)` — لـ C-7.
  5. `findAccounts(side, query)` — لـ C-2/C-4.
- **ممنوع:** UPDATE/DELETE على `entries`؛ تخزين رصيد كمصدر حقيقة (HR-2)؛ أي مسار كتابة يتجاوز LedgerStore؛ أي مرجع شبكة.

## جدول التتبع (Traceability)
| العقد | المكوّن في S2 JSON | الميزة/التدفق في S1 | القاعدة HR/BR |
|---|---|---|---|
| C-1 addEntry | QuickEntryForm, EntryValidator, LedgerStore, LocalDatabase | F-1, F-2, F-3, F-4, F-9(opening), F-10 — UF-1..UF-4, UF-8 | HR-3, HR-4, HR-5؛ BR-1, BR-2, BR-8 |
| C-2 findOrCreateAccount | SearchProvider, QuickEntryForm, LedgerStore | F-2, F-3, F-6 — UF-1, UF-3 | HR-6؛ BR-1 |
| C-3 getAccountSummary | AccountLedgerView, BalanceCalculator | F-2, F-3, F-7 — UF-5 | HR-2, HR-8؛ BR-3, BR-4, BR-6 |
| C-4 listAccountSummaries | AccountsDashboard, SearchProvider, BalanceCalculator | F-5, F-6 — UF-5 | HR-8؛ BR-3, BR-6 |
| C-5 correctEntry | AccountLedgerView, EntryValidator, LedgerStore | سجل الدليل F-7 — التصحيح الظاهر (BR-2) | HR-3؛ BR-2 |
| C-6 markAccountMigrated | OpeningMigrationPanel, LedgerStore | F-9 — النقل التدريجي (س8-2) | HR-9 |
| C-7 getDayLog | DayLedgerView, BalanceCalculator | F-10 — UF-8, AC-8 | HR-8؛ BR-8 |

> كل عقد أعلاه مربوط بميزة معتمدة داخل MVP (F-1..F-10) — لا يوجد عقد يخدم ميزة خارج MVP أو يخالف NG-1..NG-4.
> البنود المفتوحة الموروثة: س8-3 (BR-5) — البنية تدعم كلا القرارين المحتملين (ADR-6) بلا إعادة معمارية. U-8 يبقى مفتوحاً — لا رقم خسائر في أي مكان.
