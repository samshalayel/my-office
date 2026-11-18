# دليل الدمج — BASE-8 الإعدادات

## نظرة عامة سريعة

تم بناء نظام إعدادات قابل للتكوين بالكامل لمتجر النقاط (POS)، مع إمكانية تغيير اسم المتجر والعملة وصيغ الأرقام والتواريخ دون تعديل الكود.

## الملفات المُسلمة

| الملف | الموضع | الحجم | الوصف |
|------|--------|-------|-------|
| `settings.ts` | `POS/src/lib/` | 9 KB | وحدة إدارة الإعدادات الأساسية |
| `settings.test.ts` | `POS/src/lib/` | 12 KB | اختبارات الوحدة (40+ حالة) |
| `SettingsForm.tsx` | `POS/src/components/` | 17 KB | مكون واجهة تحرير الإعدادات |
| `BASE-8-SETTINGS-README.md` | `POS/` | 8 KB | التوثيق الكامل |

## كيفية الاستخدام الفوري

### 1. في الكود (بدون React)

```typescript
import { settingsManager, formatCurrency, formatDate } from './lib/settings';

// الحصول على الإعدادات
const storeName = settingsManager.getStoreName();
const currency = settingsManager.getCurrency();

// تنسيق البيانات
const price = formatCurrency(1500);  // "1,500.00 ﷼"
const date = formatDate(new Date()); // "11/11/2026"
```

### 2. في الواجهة (مع React)

```typescript
import SettingsForm from './components/SettingsForm';

export function SettingsPage() {
  const handleSave = () => {
    console.log('Settings saved!');
    // إعادة تحميل الصفحة أو تحديث البيانات المعروضة
  };

  return (
    <SettingsForm 
      onSave={handleSave}
      onCancel={() => window.history.back()}
    />
  );
}
```

## التكامل مع الشرائح الأخرى

### Base Slice (أساس البيانات)
- ✅ لا اعتماد مباشر — الإعدادات مستقلة

### Entry Slice (مسار الإدخال)
- استخدم `formatCurrency()` و `formatNumber()` عند عرض المبالغ
- استخدم `formatDateTime()` لعرض توقيت العملية

### Calc Slice (محرك الاحتساب)
- لا تستخدم الإعدادات في الحسابات نفسها
- استخدمها فقط عند عرض النتائج

### Views Slice (شاشات العرض)
- استخدم دوال التنسيق لكل البيانات المعروضة
- استخدم `formatDate()` و `formatDateTime()` للتواريخ
- استخدم `formatCurrency()` للمبالغ المالية

## القيم الافتراضية

```json
{
  "name": "متجري",
  "currency": {
    "code": "SAR",
    "symbol": "﷼",
    "position": "after",
    "decimalPlaces": 2
  },
  "numberFormat": {
    "decimalSeparator": ".",
    "thousandsSeparator": ",",
    "decimalPlaces": 2
  },
  "dateFormat": {
    "locale": "ar-SA",
    "datePattern": "DD/MM/YYYY",
    "timePattern": "HH:mm:ss"
  }
}
```

## التحقق من الإعدادات

```bash
# تشغيل الاختبارات
npm test -- settings.test.ts

# تشغيل اختبار معين
npm test -- settings.test.ts -t "formatCurrency"

# التحقق من التغطية
npm test -- settings.test.ts --coverage
```

## نقاط مهمة

### HR-1: التوفر الدائم (Offline)
- ✅ جميع الإعدادات محفوظة في `localStorage`
- ✅ لا توجد استدعاءات شبكة
- ✅ تعمل حتى بدون اتصال إنترنت

### HR-6: الحسابات الأصلية
- ✅ جميع الحسابات تستخدم `number` من JavaScript
- ✅ التنسيق يتم فقط عند العرض
- ✅ مثال: `1.5 * 1000 = 1500` (دائماً دقيق)

### عدم القابلية للتغيير
- ✅ `getConfig()` ترجع كائن مجمد
- ✅ لا يمكن تعديل الكائنات المُرجعة
- ✅ التعديلات عبر `setStoreName()` و `setCurrency()` وما إلى ذلك فقط

## أمثلة واقعية

### مثال 1: عرض الرصيد

```typescript
import { settingsManager } from './lib/settings';

export function AccountBalance({ balance }: { balance: number }) {
  const currency = settingsManager.getCurrency();
  const formatted = settingsManager.formatCurrency(balance);
  
  return (
    <div className="balance">
      <label>الرصيد الحالي:</label>
      <span className={balance < 0 ? 'negative' : 'positive'}>
        {formatted}
      </span>
    </div>
  );
}
```

### مثال 2: جدول العمليات

```typescript
import { formatDateTime, formatCurrency } from './lib/settings';

export function TransactionList({ entries }) {
  return (
    <table>
      <thead>
        <tr>
          <th>الوقت</th>
          <th>المبلغ</th>
          <th>النوع</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(entry => (
          <tr key={entry.id}>
            <td>{formatDateTime(entry.ts)}</td>
            <td>{formatCurrency(entry.amount)}</td>
            <td>{entry.type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### مثال 3: تغيير الإعدادات

```typescript
// تغيير العملة إلى الدولار
settingsManager.setCurrency({
  code: 'USD',
  symbol: '$',
  position: 'before',
  decimalPlaces: 2
});

// تغيير اسم المتجر
settingsManager.setStoreName('متجر النور');

// تغيير صيغة التاريخ
settingsManager.setDateFormat({
  datePattern: 'YYYY-MM-DD',
  timePattern: 'HH:mm'
});
```

## الأمان

- ✅ بدون استدعاءات شبكية
- ✅ بدون إرسال بيانات خارج الجهاز
- ✅ الإعدادات محفوظة محلياً فقط
- ✅ لا توجد مفاتيح تشفير أو بيانات حساسة

## خطوات التكامل النهائية

1. ✅ نسخ الملفات إلى الفروع الصحيحة (تم بالفعل)
2. ⏳ مراجعة الكود من قِبل الفريق
3. ⏳ دمج إلى فرع الإنتاج
4. ⏳ تحديث صفحة الإعدادات في التطبيق

## الدعم والمساعدة

- انظر `BASE-8-SETTINGS-README.md` للتوثيق المفصل
- الاختبارات توضح جميع حالات الاستخدام
- المكون مزود بمعاينات فورية

---

**الحالة:** ✅ جاهز للدمج
**التاريخ:** 2026-11-11
**المهمة:** [base-T9] BASE-8
