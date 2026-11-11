# BASE-8: إعدادات المتجر

## نظرة عامة

تطبيق الإعدادات القابلة للتغيير لمتجر النقاط (POS)، بدلاً من تثبيتها بالكود. يشمل:
- **اسم المتجر** — قابل للتعديل بدون تعديل الكود
- **العملة** — رمز، رمز العملة، موضع الرمز، عدد الخانات العشرية
- **صيغ الأرقام** — فاصل الكسور العشرية، فاصل الآلاف، عدد الخانات
- **صيغ التاريخ والوقت** — اللغة/المنطقة، نمط التاريخ، نمط الوقت

## البنية

### 1. `settings.ts` - وحدة إدارة الإعدادات

**الفئات والواجهات الرئيسية:**

```typescript
interface StoreConfig {
  name: string;
  currency: CurrencyConfig;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
}

interface CurrencyConfig {
  code: string;                    // "SAR", "USD"
  symbol: string;                  // "﷼", "$"
  position: 'before' | 'after';    // موضع الرمز
  decimalPlaces: number;           // عدد الخانات (0-10)
}

interface NumberFormat {
  decimalSeparator: string;        // "." أو ","
  thousandsSeparator: string;      // "," أو "."
  decimalPlaces: number;           // عدد الخانات (0-10)
}

interface DateFormat {
  locale: string;                  // "ar-SA", "en-US"
  datePattern: string;             // "DD/MM/YYYY"
  timePattern: string;             // "HH:mm:ss"
  timezone?: string;               // اختياري
}
```

**فئة `SettingsManager`:**

- **نمط Singleton** — مثيل واحد في التطبيق
- **الخزن المستمر** — حفظ في `localStorage` للبقاء بعد إعادة تحميل الصفحة
- **التحقق من الصحة** — التحقق من كل إدخال قبل الحفظ
- **عدم القابلية للتغيير** — إرجاع كائنات مجمدة لمنع التعديل غير المقصود

**الدوال الرئيسية:**

```typescript
// الوصول إلى الإعدادات
getConfig(): StoreConfig
getStoreName(): string
getCurrency(): CurrencyConfig
getNumberFormat(): NumberFormat
getDateFormat(): DateFormat

// تعديل الإعدادات
setStoreName(name: string): void
setCurrency(currency: Partial<CurrencyConfig>): void
setNumberFormat(format: Partial<NumberFormat>): void
setDateFormat(format: Partial<DateFormat>): void

// التنسيق (HR-6: الحسابات استخدم أرقام أصلية، التنسيق فقط بـ UI)
formatNumber(value: number): string
formatCurrency(value: number): string
formatDate(date: Date | string): string
formatDateTime(date: Date | string): string

// إعادة تعيين
resetToDefaults(): void
```

### 2. `settings.test.ts` - اختبارات الوحدة

تغطي:
- ✅ نمط Singleton
- ✅ إدارة اسم المتجر
- ✅ تكوين العملة والتحقق من الصحة
- ✅ صيغ الأرقام والتحقق من التضارب
- ✅ صيغ التاريخ والتحقق من المتطلبات
- ✅ التنسيق — أرقام، عملات، تواريخ
- ✅ عدم القابلية للتغيير
- ✅ إعادة التعيين إلى الافتراضيات
- ✅ الدوال الملائمة

**الاختبارات بـ HR:**
- **HR-6** (الحسابات ← أرقام أصلية) — اختبار شامل للتنسيق دون تغيير القيم

### 3. `SettingsForm.tsx` - مكون واجهة المستخدم

نموذج React لتحرير الإعدادات:

**الميزات:**
- ✅ تحرير جميع الإعدادات في واجهة موحدة
- ✅ معاينات فورية (أرقام، عملات، تواريخ)
- ✅ تحقق من الصحة قبل الحفظ
- ✅ رسائل نجاح/خطأ
- ✅ استعادة الإعدادات الافتراضية
- ✅ ملايم للاتجاه RTL (العربية)
- ✅ متجاوب (Responsive)

**الأقسام:**
1. **معلومات المتجر** — اسم المتجر
2. **العملة** — رمز، رمز، موضع، خانات عشرية
3. **صيغة الأرقام** — فواصل، خانات عشرية
4. **صيغة التاريخ والوقت** — لغة/منطقة، نمط التاريخ، نمط الوقت

## الاستخدام

### الوصول إلى الإعدادات

```typescript
import { settingsManager, formatCurrency, formatDate } from './settings';

// الحصول على الاسم
const name = settingsManager.getStoreName();

// تنسيق الأرقام
const formatted = formatCurrency(1000);  // "1,000.00 ﷼"

// تنسيق التاريخ
const date = formatDate(new Date());
```

### تعديل الإعدادات

```typescript
// طريقة 1: مباشرة من الكود
settingsManager.setStoreName('متجر النور');
settingsManager.setCurrency({ symbol: '$', position: 'before' });

// طريقة 2: عبر المكون (الموصى به للمستخدمين)
import SettingsForm from './SettingsForm';

export function SettingsPage() {
  return <SettingsForm onSave={() => window.location.reload()} />;
}
```

### قيم افتراضية

```typescript
{
  name: 'متجري',
  currency: {
    code: 'SAR',
    symbol: '﷼',
    position: 'after',
    decimalPlaces: 2
  },
  numberFormat: {
    decimalSeparator: '.',
    thousandsSeparator: ',',
    decimalPlaces: 2
  },
  dateFormat: {
    locale: 'ar-SA',
    datePattern: 'DD/MM/YYYY',
    timePattern: 'HH:mm:ss'
  }
}
```

## القيود والقواعس

### HR-1: توفر دائماً (Offline First)
- ✅ جميع الإعدادات مخزنة محلياً في `localStorage`
- ✅ بلا استدعاءات شبكة (لا توجد مسارات نسخ احتياطي بـ BASE-8)

### HR-6: الحسابات ← أرقام أصلية
- ✅ جميع الحسابات تستخدم أرقام JavaScript الأصلية
- ✅ التنسيق فقط في العرض (UI)
- ✅ `formatNumber()` و `formatCurrency()` لا تغيران القيمة الأصلية

### عدم القابلية للتغيير
- ✅ `getConfig()`, `getCurrency()`, إلخ ترجع كائنات مجمدة
- ✅ محاولة التعديل ترفع خطأ

### التحقق من الصحة
- ✅ اسم المتجر غير فارغ
- ✅ فاصل الكسور ≠ فاصل الآلاف
- ✅ الخانات العشرية ∈ [0, 10]
- ✅ موضع العملة ∈ {before, after}
- ✅ اللغة/المنطقة مطلوبة

## الملفات المطلوبة للإندماج

1. **`POS/src/lib/settings.ts`** — وحدة الإعدادات
2. **`POS/src/lib/settings.test.ts`** — الاختبارات (Jest/Vitest)
3. **`POS/src/components/SettingsForm.tsx`** — مكون الواجهة
4. **`POS/src/pages/SettingsPage.tsx`** — صفحة الإعدادات (اختياري)

## الاختبار

```bash
# تشغيل الاختبارات
npm test -- settings.test.ts

# التحقق من التغطية
npm test -- settings.test.ts --coverage
```

**التغطية المتوقعة:** 100% (الفئات + الدوال)

## الملاحظات

### الاعتماديات
- بلا مكتبات خارجية للإعدادات نفسها
- React 18+ للمكون (اختياري)

### الصيغ المدعومة

**التاريخ:**
- `DD/MM/YYYY` (11/11/2026)
- `MM/DD/YYYY` (11/11/2026)
- `YYYY-MM-DD` (2026-11-11)
- `DD-MM-YYYY` (11-11-2026)

**الوقت:**
- `HH:mm:ss` (10:30:45)
- `HH:mm` (10:30)

يمكن توسيع الصيغ بإضافة المزيد من الأنماط إلى `SettingsForm.tsx`.

### الترجمة

جميع النصوص في `SettingsForm.tsx` بالعربية. يمكن إضافة `i18n` لاحقاً.

## التطوير المستقبلي

- [ ] دعم `i18n` (ترجمة ديناميكية)
- [ ] تصدير/استيراد الإعدادات (ملف JSON)
- [ ] نسخ احتياطية سحابية (خارج BASE-8)
- [ ] صيغ تاريخ/وقت مخصصة

---

**الحالة:** ✅ منتهي للدمج
**آخر تحديث:** 2026-11-11
**المهمة:** [base-T9] BASE-8
