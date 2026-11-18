# [base-T4] Account: قائمة ببحث وفلترة وترتيب

## نظرة عامة
تم تطبيق المهمة الأساسية [base-T4] لإنشاء قائمة الحسابات مع إمكانيات البحث والفلترة والترتيب. البناء يستخدم فهرس `side` للأداء العالي ويدعم ~270 حساب (SC-3).

## الملفات المعدلة والمنشأة

### 1. `POS/js/types.ts` — أنواع الترتيب
أضيفت أنواع جديدة لدعم وظيفة الترتيب:

```typescript
export type SortField = 'name' | 'balance' | 'totalDebt';
export type SortOrder = 'asc' | 'desc';

export interface SortOptions {
  field?: SortField;
  order?: SortOrder;
}

export interface AccountsListResult {
  accounts: AccountRow[];
  totalCount: number;
  query?: string;
  side?: Side;
}
```

### 2. `POS/js/ledger-store.ts` — تحسينات المتجر
تم تحسين `LedgerStore` بـ:

- **`listAccountSummaries(side, query?, sortOptions?)`**: تم تحديثها لدعم خيارات الترتيب
  - معامل جديد: `sortOptions` للتحكم بالترتيب (اسم، رصيد، ديون)
  - تحافظ على التوافقية مع الكود الموجود

- **`getAccountsList(side, query?, sortOptions?)`**: دالة جديدة موحدة
  - واجهة موحدة تجمع البحث والفلترة والترتيب
  - ترجع `AccountsListResult` مع معلومات إجمالية

- **`sortAccounts(rows, sortOptions?)`**: دالة مساعدة داخلية
  - تطبيق الترتيب على قائمة الحسابات
  - يدعم: الاسم (مع دعم العربية)، الرصيد، الديون الكلية

### 3. `POS/js/accounts-dashboard.ts` — مكون لوحة المعلومات (جديد)
مكون جديد يوفر واجهة كاملة للعمل مع قائمة الحسابات:

```typescript
export class AccountsDashboard {
  // تعيين الفلترة الحالية
  setSide(side: Side): void;
  setSearchQuery(query: string): void;
  setSortBy(field: SortField, order?: SortOrder): void;

  // الحصول على البيانات
  async getAccountsList(): Promise<AccountsListResult>;
  async getAccountDetails(accountId: string);

  // إدارة الحالة
  getFilterState(): FilterState;
  resetFilters(): void;

  // خيارات UI
  getAvailableSortFields(): Array<{id, label}>;
  getAvailableSides(): Array<{id, label}>;
}
```

**الميزات:**
- إدارة متكاملة للفلترة والبحث والترتيب
- دعم تحديثات الفلترة المتعددة
- مساعدات UI لتنسيق البيانات

### 4. `POS/js/accounts-dashboard.test.ts` — اختبارات شاملة (جديد)
مجموعة اختبارات تغطي:

- ✅ فلترة حسب الاتجاه (عملاء/مورّدين)
- ✅ البحث عن الحسابات بالاسم
- ✅ الترتيب بالاسم (تصاعدي/تنازلي)
- ✅ الترتيب بالرصيد
- ✅ الترتيب بالديون الكلية
- ✅ دمج الفلترة والبحث والترتيب معاً
- ✅ إدارة حالة الفلترة
- ✅ مساعدات العرض
- ✅ الأداء مع ~270 حساب

## المتطلبات الملباة

| المتطلب | الحالة | التفاصيل |
|--------|--------|---------|
| البحث بالاسم | ✅ | يدعم البحث غير الحساس لحالة الأحرف مع دعم العربية |
| الفلترة بالاتجاه | ✅ | يدعم فلترة (عملاء / مورّدين) ضمن الفهرس side |
| الترتيب | ✅ | يدعم الاسم والرصيد والديون (تصاعدي/تنازلي) |
| فهرس side | ✅ | يستخدم الفهرس الموجود في `side_name` للأداء |
| دعم ~270 حساب | ✅ | مختبر وموثق في حالات الاختبار |
| الالتزام HR-1 | ✅ | لا توجد استدعاءات شبكة، كل الوصول عبر LedgerStore |

## الاستخدام

### مثال أساسي

```typescript
const dashboard = new AccountsDashboard(ledgerStore);

// فلترة الحسابات
dashboard.setSide('client');

// بحث عن حسابات
dashboard.setSearchQuery('محمود');

// ترتيب بالاسم تصاعدي
dashboard.setSortBy('name', 'asc');

// الحصول على النتائج
const result = await dashboard.getAccountsList();
console.log(result.accounts); // قائمة مرتبة ومفلترة
```

### ترتيب بالرصيد

```typescript
dashboard.setSortBy('balance', 'desc');
const highBalanceAccounts = await dashboard.getAccountsList();
```

### دمج الفلترة والبحث والترتيب

```typescript
dashboard.setSide('supplier');
dashboard.setSearchQuery('علي');
dashboard.setSortBy('totalDebt', 'desc');
const result = await dashboard.getAccountsList();
// النتيجة: المورّدين الذين أسماؤهم تحتوي على 'علي'، مرتبة بالديون تنازلياً
```

## التوافقية

- **التوافقية للخلف:** تم الحفاظ على التوافقية الكاملة مع `listAccountSummaries`
- **الاعتمادات:** تعتمد على [base-T1] (LocalDatabase و LedgerStore)
- **العقود:** لا تتطلب عقود جديدة، تستخدم العقود الموجودة (C-3)

## الاختبار

يمكن تشغيل الاختبارات باستخدام:
```bash
npm test -- accounts-dashboard.test.ts
```

**تغطية الاختبارات:**
- 20+ حالة اختبار
- يغطي جميع أنماط الفلترة والبحث والترتيب
- اختبارات الأداء مع 270+ حساب

## الأداء

- **التعقيد الزمني:** O(n) للفلترة و O(n log n) للترتيب (معياري)
- **الفهرسة:** يستخدم فهرس `side` في IndexedDB للبحث السريع
- **الحد الأقصى:** مختبر بنجاح مع 270+ حساب

## حالات الحافة المعالجة

- ✅ بحث فارغ (يرجع كل الحسابات)
- ✅ بحث بلا نتائج (يرجع قائمة فارغة)
- ✅ ترتيب بالاسم مع دعم العربية
- ✅ رصيد سالب (عملاء عليهم رصيد دائن)
- ✅ رصيد صفر
- ✅ إعادة تعيين الفلاتر

## المراجع

- **الملفات:** E-Account, SC-3
- **الاعتماديات:** [base-T1]
- **العقود:** C-3 (من S2)
- **القواعس:** HR-1 (بلا شبكة)

## الملاحظات

- الترتيب الافتراضي: اسم تصاعدي
- البحث غير حساس لحالة الأحرف
- يدعم العربية بالكامل (localeCompare)
- لا توجد استدعاءات شبكة في مسار الفلترة
