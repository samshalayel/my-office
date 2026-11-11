# API Contract: POS — S3 (Detailed)

> يرث `POS_s2_api_contract_2026-11-11T12-19-24Z.md` حرفياً. عند التعارض: S2 يفوز في التواقيع، S3 يفوز في تفاصيل التنفيذ.
> ملاحظة اكتمال: العقود المفصلة أدناه هي التي نصها وأنواعها متوفران في حزمة S2 المستلمة (C-1 كامل النص؛ C-3 وC-7 بأنواعها المعرفة حرفياً وتوصيفها الحرفي من المصدر). أي عقد إضافي في ملف S2 الأصلي يُراجع حرفياً منه عند البوابة.

## فهرس العقود حسب الشريحة

| الشريحة | العقود الموروثة C-N | عقود داخلية جديدة |
|---|---|---|
| base | قيود الكيانات Account وEntry من s2-domains-2 — التواقيع من مصدر الحقيقة | لا يوجد |
| entry | C-1 addEntry | لا يوجد |
| calc | C-3 (استعلام بحساب) | لا يوجد |
| views | C-3 (استهلاك) + C-7 (استعلام باليوم) | لا يوجد |
| migr | C-1 (نوع opening) | لا يوجد |

لا عقود داخلية جديدة في S3 — أي حاجة لعقد داخلي تُرفع DEV-N وتُرقّم تكملةً لآخر C-N في S2.

## العقود المفصلة

### C-1: addEntry — شريحة entry (ومنها نوع opening في migr)

- **التوقيع (حرفياً من S2):** `addEntry(entry: NewEntry) → EntryResult`
- **الطبقة (حرفياً من S2):** UI-event (QuickEntryForm) → Logic (EntryValidator) → Data (LedgerStore → LocalDatabase)
- **القواعد الصارمة المرتبطة (حرفياً من S2):** HR-4, HR-5, HR-3 (كتابة append-only فقط)
- **سلوك الاحتساب (حرفياً من S2):** debt_* يزيد، payment_* ينقص، cash_sale لا يمس أي رصيد (BR-8)، opening رصيد ابتدائي لحساب أثناء النقل (F-9)
- **خطوات التنفيذ الداخلية:**
  1. استقبال NewEntry من QuickEntryForm
  2. تحقق EntryValidator: النوع ضمن القائمة الست (debt_client / debt_supplier / payment_from_client / payment_to_supplier / cash_sale / opening)؛ accountId مطلوب لكل الأنواع إلا cash_sale (BR-1, BR-8)؛ amount > 0؛ ts = لحظة التسجيل إن غاب
  3. توليد id (UUID) وبناء Entry
  4. كتابة إلحاقية واحدة عبر LedgerStore — لا تحديث ولا حذف (HR-3, BR-2)
  5. إرجاع EntryResult: {ok: true, entry} أو {ok: false, errors}
- **حالات الحافة (سيغطيها S4 ويختبرها S5):**
  - نوع مفقود أو غير معروف → errors: [نوع القيد مطلوب]
  - طرف مفقود لنوع غير cash_sale → errors: [حساب الطرف مطلوب] (BR-1, BR-8)
  - مبلغ ≤ 0 → errors: [المبلغ يجب أن يكون أكبر من صفر]
  - تسديد زائد عن الرصيد → ليس فشلاً: يُقبل ويُعرض كقيمة معاكسة (BR-5, HR-10)
  - ts ماضٍ → مقبول: الافتراضي لحظة التسجيل، ويمكن تمرير تاريخ أصلي عند توثيق عملية من الدفتر الورقي أثناء النقل
  - cash_sale مع accountId → غير محسوم في S2 — الافتراض المقترح: تجاهل الحقل [افتراض] — يُعرض للإنسان عند البوابة إن لزم
- **مثال بيانات فعلي:**
  - المدخل: addEntry({type: 'debt_client', accountId: 'acc-12', amount: 1500, note: 'بضاعة أشهر'})
  - المخرج: {ok: true, entry: {id: 'e-881', type: 'debt_client', accountId: 'acc-12', amount: 1500, ts: '2026-11-11T10:30:00', note: 'بضاعة أشهر'}}

### C-3: الاستعلام «بحساب» — شريحة calc (تستهلكه views)

- **الأنواع (حرفياً من S2):**

```
AccountSummary { account: Account, summary: DerivedBalance, entries: Entry[] }   // entries بالترتيب الزمني مع علامات «مُصحّح»
DerivedBalance { totalDebt: number, totalPaid: number, balance: number }
```

- **التوقيع:** كما في مصدر الحقيقة `POS_s2_api_contract_2026-11-11T12-19-24Z.md` — يرجع AccountSummary ويُنسخ حرفياً منه عند التنفيذ
- **خطوات التنفيذ الداخلية:**
  1. قراءة الحساب من مخزن accounts عبر LedgerStore
  2. قراءة عمليات الحساب بترتيب ts تصاعدي
  3. احتساب الثلاثية عبر BalanceCalculator: debt يزيد totalDebt، payment يزيد totalPaid، balance = totalDebt − totalPaid
  4. إلحاق علامة «مُصحّح» لكل entry له linkedTo — الأصل يبقى ظاهراً (BR-2, ADR-4)
- **حالات الحافة:**
  - حساب غير موجود → رفض برسالة عربية مفهومة (BASE-10) — لا أصفار صامتة
  - حساب بلا عمليات → {totalDebt: 0, totalPaid: 0, balance: 0}
  - تسديد زائد → قيمة معاكسة مقبولة (BR-5, HR-10)
  - عمليات cash_sale لا تدخل حساب أي طرف أصلاً (BR-8)
- **مثال رقمي (يتسق مع C-1):** حساب عليه 5000 (debt_client)، سدد 3000 ثم 2500 → summary: {totalDebt: 5000, totalPaid: 5500, balance: −500} — الحساب صحيح والقيمة المعاكسة ظاهرة
- **مثال بيانات فعلي:**

```
{ account: {id: 'acc-12', name: 'أحمد', side: 'client', ledgerTransfer: 'completed', createdAt: '2026-11-11T09:00:00'},
  summary: {totalDebt: 5000, totalPaid: 5500, balance: -500},
  entries: [{id: 'e-880', type: 'debt_client', amount: 5000}, {id: 'e-881', type: 'payment_from_client', amount: 3000}, {id: 'e-882', type: 'payment_from_client', amount: 2500}] }
```

### C-7: الاستعلام «باليوم» — شريحة views

- **النوع (حرفياً من S2):**

```
DayLogRow { entryId: UUID, ts: ISODateTime, type: EntryType, label: string, amount: number, accountId?: UUID }
```

- **التوقيع:** كما في مصدر الحقيقة — يرجع عمليات اليوم الواحد بالترتيب الزمني (F-10) ويُنسخ حرفياً منه عند التنفيذ
- **خطوات التنفيذ الداخلية:**
  1. تحديد نطاق اليوم بتوقيت الجهاز المحلي: ts ∈ [00:00, 24:00)
  2. مسح مخزن entries عبر فهرس اليوم في LedgerStore
  3. ترتيب زمني تصاعدي
  4. label عربي لكل نوع كما في توثيق الأنواع في S2: debt_client = دَين على عميل، debt_supplier = دَين لمورّد، payment_from_client = تسديد من عميل، payment_to_supplier = تسديد لمورّد، cash_sale = بيع نقدي، opening = قيد افتتاحي
- **حالات الحافة:**
  - يوم بلا عمليات → قائمة فارغة برسالة مفهومة (BASE-10)
  - cash_sale بلا طرف → accountId فارغ في DayLogRow (النوع يسمح)
  - opening يظهر في يوم تسجيله كسطر عادي — لا بنية خاصة
- **مثال بيانات فعلي:**

```
[ {entryId: 'e-881', ts: '2026-11-11T10:30:00', type: 'debt_client', label: 'دَين على عميل', amount: 1500, accountId: 'acc-12'},
  {entryId: 'e-882', ts: '2026-11-11T12:05:00', type: 'cash_sale', label: 'بيع نقدي', amount: 3500} ]
```

## عقود بين الشرائح (Cross-Slice)

- **views → calc**: كل عرض يستهلك مخرجات C-3 (AccountSummary / AccountRow) — المفتاح المشترك: accountId
- **views → base**: سجل اليوم يقرأ عبر LedgerStore (فهرس اليوم من [base-T8]) — المفتاح: ts
- **migr → entry**: القيد الافتتاحي يُكتب عبر C-1 — المفتاح: type = 'opening'
- **الجميع → base**: لا وصول مباشر لـ IndexedDB خارج LedgerStore، ولا أي استدعاء شبكة (HR-1)
- **قاعدة اللا-عدّ المزدوج**: التسديد يُنسب مرة واحدة عبر قراءة السجل فقط في كل استهلاك للاحتساب — لا مجموعات جانبية تُخزَّن (BR-3, BR-6)
