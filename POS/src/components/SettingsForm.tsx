/**
 * Settings Form Component
 * UI for managing store settings: name, currency, number/date formats
 * BASE-8 Implementation
 */

import React, { useState, useCallback } from 'react';
import {
  settingsManager,
  StoreConfig,
  CurrencyConfig,
  NumberFormat,
  DateFormat,
  DEFAULT_STORE_CONFIG,
} from './settings';

interface SettingsFormProps {
  onSave?: () => void;
  onCancel?: () => void;
}

export const SettingsForm: React.FC<SettingsFormProps> = ({ onSave, onCancel }) => {
  const initialConfig = settingsManager.getConfig();

  const [storeName, setStoreName] = useState(initialConfig.name);
  const [currency, setCurrency] = useState<CurrencyConfig>(initialConfig.currency);
  const [numberFormat, setNumberFormat] = useState<NumberFormat>(initialConfig.numberFormat);
  const [dateFormat, setDateFormat] = useState<DateFormat>(initialConfig.dateFormat);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [successMessage, setSuccessMessage] = useState('');

  const validateForm = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};

    if (!storeName || storeName.trim().length === 0) {
      newErrors.storeName = 'اسم المتجر مطلوب';
    }

    if (currency.decimalPlaces < 0 || currency.decimalPlaces > 10) {
      newErrors.currencyDecimalPlaces = 'عدد الخانات العشرية يجب أن يكون بين 0 و 10';
    }

    if (numberFormat.decimalSeparator === numberFormat.thousandsSeparator) {
      newErrors.numberFormat = 'فاصل الآلاف وفاصل الكسور العشرية يجب أن يكونا مختلفين';
    }

    if (numberFormat.decimalPlaces < 0 || numberFormat.decimalPlaces > 10) {
      newErrors.numberFormatDecimals = 'عدد الخانات العشرية يجب أن يكون بين 0 و 10';
    }

    if (!dateFormat.locale) {
      newErrors.dateLocale = 'اللغة/المنطقة مطلوبة';
    }

    if (!dateFormat.datePattern) {
      newErrors.datePattern = 'صيغة التاريخ مطلوبة';
    }

    if (!dateFormat.timePattern) {
      newErrors.timePattern = 'صيغة الوقت مطلوبة';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [storeName, currency, numberFormat, dateFormat]);

  const handleSave = useCallback(() => {
    if (!validateForm()) {
      return;
    }

    try {
      settingsManager.setStoreName(storeName);
      settingsManager.setCurrency(currency);
      settingsManager.setNumberFormat(numberFormat);
      settingsManager.setDateFormat(dateFormat);

      setSuccessMessage('تم حفظ الإعدادات بنجاح');
      setTimeout(() => {
        setSuccessMessage('');
        onSave?.();
      }, 1500);
    } catch (error) {
      setErrors({
        general: error instanceof Error ? error.message : 'حدث خطأ في حفظ الإعدادات',
      });
    }
  }, [storeName, currency, numberFormat, dateFormat, validateForm, onSave]);

  const handleReset = useCallback(() => {
    if (window.confirm('هل تريد استعادة الإعدادات الافتراضية؟')) {
      settingsManager.resetToDefaults();
      const defaultConfig = settingsManager.getConfig();
      setStoreName(defaultConfig.name);
      setCurrency(defaultConfig.currency);
      setNumberFormat(defaultConfig.numberFormat);
      setDateFormat(defaultConfig.dateFormat);
      setErrors({});
      setSuccessMessage('تم استعادة الإعدادات الافتراضية');
      setTimeout(() => setSuccessMessage(''), 1500);
    }
  }, []);

  const previewNumber = 1234.56;
  const previewDate = new Date('2026-11-11T10:30:45');

  return (
    <div className="settings-form" dir="rtl">
      <h1>إعدادات المتجر</h1>

      {errors.general && <div className="error-message">{errors.general}</div>}
      {successMessage && <div className="success-message">{successMessage}</div>}

      <form onSubmit={e => {
        e.preventDefault();
        handleSave();
      }}>
        {/* Store Name Section */}
        <fieldset className="form-section">
          <legend>معلومات المتجر</legend>

          <div className="form-group">
            <label htmlFor="storeName">اسم المتجر</label>
            <input
              id="storeName"
              type="text"
              value={storeName}
              onChange={e => setStoreName(e.target.value)}
              className={errors.storeName ? 'input-error' : ''}
              aria-invalid={!!errors.storeName}
              aria-describedby={errors.storeName ? 'storeName-error' : undefined}
            />
            {errors.storeName && (
              <div id="storeName-error" className="error-text">
                {errors.storeName}
              </div>
            )}
          </div>
        </fieldset>

        {/* Currency Section */}
        <fieldset className="form-section">
          <legend>العملة</legend>

          <div className="form-group">
            <label htmlFor="currencyCode">رمز العملة</label>
            <input
              id="currencyCode"
              type="text"
              value={currency.code}
              onChange={e => setCurrency({ ...currency, code: e.target.value })}
              maxLength={3}
              placeholder="SAR"
            />
          </div>

          <div className="form-group">
            <label htmlFor="currencySymbol">رمز العملة (الرمز)</label>
            <input
              id="currencySymbol"
              type="text"
              value={currency.symbol}
              onChange={e => setCurrency({ ...currency, symbol: e.target.value })}
              maxLength={5}
              placeholder="﷼"
            />
          </div>

          <div className="form-group">
            <label htmlFor="currencyPosition">موضع الرمز</label>
            <select
              id="currencyPosition"
              value={currency.position}
              onChange={e =>
                setCurrency({
                  ...currency,
                  position: e.target.value as 'before' | 'after',
                })
              }
            >
              <option value="after">بعد المبلغ</option>
              <option value="before">قبل المبلغ</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="currencyDecimals">عدد الخانات العشرية</label>
            <input
              id="currencyDecimals"
              type="number"
              min="0"
              max="10"
              value={currency.decimalPlaces}
              onChange={e =>
                setCurrency({
                  ...currency,
                  decimalPlaces: Math.max(0, Math.min(10, parseInt(e.target.value) || 0)),
                })
              }
              className={errors.currencyDecimalPlaces ? 'input-error' : ''}
            />
            {errors.currencyDecimalPlaces && (
              <div className="error-text">{errors.currencyDecimalPlaces}</div>
            )}
          </div>

          <div className="preview">
            معاينة: <strong>{settingsManager.formatCurrency(previewNumber)}</strong>
          </div>
        </fieldset>

        {/* Number Format Section */}
        <fieldset className="form-section">
          <legend>صيغة الأرقام</legend>

          <div className="form-group">
            <label htmlFor="decimalSeparator">فاصل الكسور العشرية</label>
            <input
              id="decimalSeparator"
              type="text"
              value={numberFormat.decimalSeparator}
              onChange={e =>
                setNumberFormat({
                  ...numberFormat,
                  decimalSeparator: e.target.value,
                })
              }
              maxLength={2}
              placeholder="."
            />
          </div>

          <div className="form-group">
            <label htmlFor="thousandsSeparator">فاصل الآلاف</label>
            <input
              id="thousandsSeparator"
              type="text"
              value={numberFormat.thousandsSeparator}
              onChange={e =>
                setNumberFormat({
                  ...numberFormat,
                  thousandsSeparator: e.target.value,
                })
              }
              maxLength={2}
              placeholder=","
            />
          </div>

          <div className="form-group">
            <label htmlFor="numberDecimals">عدد الخانات العشرية</label>
            <input
              id="numberDecimals"
              type="number"
              min="0"
              max="10"
              value={numberFormat.decimalPlaces}
              onChange={e =>
                setNumberFormat({
                  ...numberFormat,
                  decimalPlaces: Math.max(0, Math.min(10, parseInt(e.target.value) || 0)),
                })
              }
              className={errors.numberFormatDecimals ? 'input-error' : ''}
            />
            {errors.numberFormatDecimals && (
              <div className="error-text">{errors.numberFormatDecimals}</div>
            )}
          </div>

          {errors.numberFormat && (
            <div className="error-text">{errors.numberFormat}</div>
          )}

          <div className="preview">
            معاينة: <strong>{settingsManager.formatNumber(previewNumber)}</strong>
          </div>
        </fieldset>

        {/* Date Format Section */}
        <fieldset className="form-section">
          <legend>صيغة التاريخ والوقت</legend>

          <div className="form-group">
            <label htmlFor="dateLocale">اللغة/المنطقة</label>
            <select
              id="dateLocale"
              value={dateFormat.locale}
              onChange={e =>
                setDateFormat({
                  ...dateFormat,
                  locale: e.target.value,
                })
              }
              className={errors.dateLocale ? 'input-error' : ''}
            >
              <option value="ar-SA">العربية - المملكة العربية السعودية</option>
              <option value="ar-AE">العربية - الإمارات العربية المتحدة</option>
              <option value="ar-EG">العربية - مصر</option>
              <option value="en-US">English - United States</option>
              <option value="en-GB">English - United Kingdom</option>
              <option value="fr-FR">Français - France</option>
            </select>
            {errors.dateLocale && (
              <div className="error-text">{errors.dateLocale}</div>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="datePattern">صيغة التاريخ</label>
            <select
              id="datePattern"
              value={dateFormat.datePattern}
              onChange={e =>
                setDateFormat({
                  ...dateFormat,
                  datePattern: e.target.value,
                })
              }
              className={errors.datePattern ? 'input-error' : ''}
            >
              <option value="DD/MM/YYYY">DD/MM/YYYY (11/11/2026)</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY (11/11/2026)</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD (2026-11-11)</option>
              <option value="DD-MM-YYYY">DD-MM-YYYY (11-11-2026)</option>
            </select>
            {errors.datePattern && (
              <div className="error-text">{errors.datePattern}</div>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="timePattern">صيغة الوقت</label>
            <select
              id="timePattern"
              value={dateFormat.timePattern}
              onChange={e =>
                setDateFormat({
                  ...dateFormat,
                  timePattern: e.target.value,
                })
              }
              className={errors.timePattern ? 'input-error' : ''}
            >
              <option value="HH:mm:ss">HH:mm:ss (10:30:45)</option>
              <option value="HH:mm">HH:mm (10:30)</option>
              <option value="HH:mm:ss a">HH:mm:ss AM/PM</option>
            </select>
            {errors.timePattern && (
              <div className="error-text">{errors.timePattern}</div>
            )}
          </div>

          <div className="preview">
            معاينة التاريخ: <strong>{settingsManager.formatDate(previewDate)}</strong>
            <br />
            معاينة التاريخ والوقت:{' '}
            <strong>{settingsManager.formatDateTime(previewDate)}</strong>
          </div>
        </fieldset>

        {/* Action Buttons */}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            حفظ الإعدادات
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
          >
            إلغاء
          </button>
          <button
            type="button"
            className="btn btn-tertiary"
            onClick={handleReset}
          >
            استعادة الإعدادات الافتراضية
          </button>
        </div>
      </form>

      <style>{`
        .settings-form {
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        .settings-form h1 {
          margin-bottom: 24px;
          color: #333;
          text-align: right;
        }

        .error-message {
          background-color: #fee;
          border: 1px solid #f99;
          border-radius: 4px;
          color: #c00;
          padding: 12px;
          margin-bottom: 16px;
          text-align: right;
        }

        .success-message {
          background-color: #efe;
          border: 1px solid #9f9;
          border-radius: 4px;
          color: #0a0;
          padding: 12px;
          margin-bottom: 16px;
          text-align: right;
        }

        .form-section {
          border: 1px solid #ddd;
          border-radius: 4px;
          padding: 16px;
          margin-bottom: 20px;
          background-color: #f9f9f9;
        }

        .form-section legend {
          padding: 0 8px;
          color: #333;
          font-weight: 600;
          text-align: right;
        }

        .form-group {
          margin-bottom: 16px;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
        }

        .form-group:last-child {
          margin-bottom: 0;
        }

        .form-group label {
          margin-bottom: 8px;
          font-weight: 500;
          color: #555;
          text-align: right;
        }

        .form-group input,
        .form-group select {
          padding: 8px 12px;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 14px;
          width: 100%;
          max-width: 400px;
          direction: rtl;
        }

        .form-group input:focus,
        .form-group select:focus {
          outline: none;
          border-color: #0066cc;
          box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1);
        }

        .form-group input.input-error {
          border-color: #cc3333;
          background-color: #ffeaea;
        }

        .error-text {
          color: #c00;
          font-size: 12px;
          margin-top: 4px;
          text-align: right;
        }

        .preview {
          background-color: #fff;
          border: 1px solid #e0e0e0;
          border-radius: 4px;
          padding: 12px;
          margin-top: 12px;
          text-align: right;
          font-size: 14px;
          color: #666;
        }

        .preview strong {
          color: #0066cc;
          font-weight: 600;
        }

        .form-actions {
          display: flex;
          gap: 12px;
          justify-content: flex-end;
          margin-top: 24px;
          flex-wrap: wrap;
        }

        .btn {
          padding: 10px 24px;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          white-space: nowrap;
        }

        .btn-primary {
          background-color: #0066cc;
          color: white;
        }

        .btn-primary:hover {
          background-color: #0052a3;
        }

        .btn-secondary {
          background-color: #f0f0f0;
          color: #333;
          border: 1px solid #ccc;
        }

        .btn-secondary:hover {
          background-color: #e0e0e0;
        }

        .btn-tertiary {
          background-color: #fff;
          color: #666;
          border: 1px solid #ccc;
        }

        .btn-tertiary:hover {
          background-color: #f9f9f9;
          border-color: #999;
        }

        @media (max-width: 600px) {
          .settings-form {
            padding: 12px;
          }

          .form-group input,
          .form-group select {
            max-width: 100%;
          }

          .form-actions {
            flex-direction: column-reverse;
          }

          .btn {
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
};

export default SettingsForm;
