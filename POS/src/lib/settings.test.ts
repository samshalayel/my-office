/**
 * Settings Module Tests
 * Tests for BASE-8 configurable settings
 */

import {
  SettingsManager,
  CurrencyConfig,
  NumberFormat,
  DateFormat,
  DEFAULT_STORE_CONFIG,
  formatNumber,
  formatCurrency,
  formatDate,
  formatDateTime,
} from './settings';

describe('SettingsManager', () => {
  let manager: SettingsManager;

  beforeEach(() => {
    // Clear localStorage before each test
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
    // Reset manager instance
    manager = SettingsManager.getInstance();
    manager.resetToDefaults();
  });

  describe('Singleton Pattern', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = SettingsManager.getInstance();
      const instance2 = SettingsManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('Store Name Management', () => {
    it('should return default store name', () => {
      expect(manager.getStoreName()).toBe(DEFAULT_STORE_CONFIG.name);
    });

    it('should set and get store name', () => {
      const newName = 'متجر النور';
      manager.setStoreName(newName);
      expect(manager.getStoreName()).toBe(newName);
    });

    it('should trim whitespace from store name', () => {
      manager.setStoreName('  متجر النور  ');
      expect(manager.getStoreName()).toBe('متجر النور');
    });

    it('should throw error for empty store name', () => {
      expect(() => manager.setStoreName('')).toThrow('Store name cannot be empty');
      expect(() => manager.setStoreName('   ')).toThrow('Store name cannot be empty');
    });

    it('should persist store name to localStorage', () => {
      const newName = 'متجر الجودة';
      manager.setStoreName(newName);

      // Create new manager instance (should load from localStorage)
      const newManager = SettingsManager.getInstance();
      expect(newManager.getStoreName()).toBe(newName);
    });
  });

  describe('Currency Configuration', () => {
    it('should return default currency', () => {
      const currency = manager.getCurrency();
      expect(currency).toEqual(DEFAULT_STORE_CONFIG.currency);
    });

    it('should set partial currency config', () => {
      manager.setCurrency({ symbol: '$', position: 'before' });
      const currency = manager.getCurrency();
      expect(currency.symbol).toBe('$');
      expect(currency.position).toBe('before');
    });

    it('should validate decimal places', () => {
      expect(() => manager.setCurrency({ decimalPlaces: -1 })).toThrow(
        'Decimal places must be between 0 and 10'
      );
      expect(() => manager.setCurrency({ decimalPlaces: 11 })).toThrow(
        'Decimal places must be between 0 and 10'
      );
    });

    it('should validate currency position', () => {
      expect(() => manager.setCurrency({ position: 'middle' as any })).toThrow(
        'Currency position must be "before" or "after"'
      );
    });

    it('should throw error for missing required fields', () => {
      expect(() => manager.setCurrency({ code: undefined } as any)).toThrow('Currency code is required');
    });

    it('should return immutable currency config', () => {
      const currency = manager.getCurrency();
      expect(() => {
        (currency as any).code = 'USD';
      }).toThrow();
    });
  });

  describe('Number Format Configuration', () => {
    it('should return default number format', () => {
      const format = manager.getNumberFormat();
      expect(format).toEqual(DEFAULT_STORE_CONFIG.numberFormat);
    });

    it('should set number format', () => {
      manager.setNumberFormat({
        decimalSeparator: ',',
        thousandsSeparator: '.',
        decimalPlaces: 3,
      });

      const format = manager.getNumberFormat();
      expect(format.decimalSeparator).toBe(',');
      expect(format.thousandsSeparator).toBe('.');
      expect(format.decimalPlaces).toBe(3);
    });

    it('should prevent same separator for decimal and thousands', () => {
      expect(() =>
        manager.setNumberFormat({
          decimalSeparator: '.',
          thousandsSeparator: '.',
        })
      ).toThrow('Decimal and thousands separators cannot be the same');
    });

    it('should validate decimal places range', () => {
      expect(() => manager.setNumberFormat({ decimalPlaces: -1 })).toThrow(
        'Decimal places must be between 0 and 10'
      );
      expect(() => manager.setNumberFormat({ decimalPlaces: 11 })).toThrow(
        'Decimal places must be between 0 and 10'
      );
    });

    it('should require decimal separator', () => {
      expect(() => manager.setNumberFormat({ decimalSeparator: undefined } as any)).toThrow(
        'Decimal separator is required'
      );
    });

    it('should return immutable format config', () => {
      const format = manager.getNumberFormat();
      expect(() => {
        (format as any).decimalPlaces = 5;
      }).toThrow();
    });
  });

  describe('Date Format Configuration', () => {
    it('should return default date format', () => {
      const format = manager.getDateFormat();
      expect(format).toEqual(DEFAULT_STORE_CONFIG.dateFormat);
    });

    it('should set date format', () => {
      manager.setDateFormat({
        locale: 'en-US',
        datePattern: 'MM/DD/YYYY',
        timePattern: 'hh:mm AM',
      });

      const format = manager.getDateFormat();
      expect(format.locale).toBe('en-US');
      expect(format.datePattern).toBe('MM/DD/YYYY');
    });

    it('should require locale', () => {
      expect(() => manager.setDateFormat({ locale: undefined } as any)).toThrow('Locale is required');
    });

    it('should require date pattern', () => {
      expect(() => manager.setDateFormat({ datePattern: undefined } as any)).toThrow(
        'Date pattern is required'
      );
    });

    it('should require time pattern', () => {
      expect(() => manager.setDateFormat({ timePattern: undefined } as any)).toThrow(
        'Time pattern is required'
      );
    });

    it('should return immutable date format config', () => {
      const format = manager.getDateFormat();
      expect(() => {
        (format as any).locale = 'en-GB';
      }).toThrow();
    });
  });

  describe('Number Formatting - HR-6 (Calculations use native numbers)', () => {
    beforeEach(() => {
      manager.setNumberFormat({
        decimalSeparator: '.',
        thousandsSeparator: ',',
        decimalPlaces: 2,
      });
    });

    it('should format basic number', () => {
      expect(manager.formatNumber(1234.56)).toBe('1,234.56');
    });

    it('should format number with no decimals', () => {
      manager.setNumberFormat({ decimalPlaces: 0 });
      expect(manager.formatNumber(1234.567)).toBe('1,234');
    });

    it('should format number with custom decimal places', () => {
      expect(manager.formatNumber(1234.5, 3)).toBe('1,234.500');
    });

    it('should format small numbers without thousands separator', () => {
      expect(manager.formatNumber(123.45)).toBe('123.45');
    });

    it('should handle zero', () => {
      expect(manager.formatNumber(0)).toBe('0.00');
    });

    it('should handle negative numbers', () => {
      expect(manager.formatNumber(-1234.56)).toBe('-1,234.56');
    });

    it('should support European format', () => {
      manager.setNumberFormat({
        decimalSeparator: ',',
        thousandsSeparator: '.',
        decimalPlaces: 2,
      });
      expect(manager.formatNumber(1234.56)).toBe('1.234,56');
    });

    it('should support Arabic format', () => {
      manager.setNumberFormat({
        decimalSeparator: '٫',
        thousandsSeparator: '٬',
        decimalPlaces: 2,
      });
      expect(manager.formatNumber(1234.56)).toBe('1٬234٫56');
    });
  });

  describe('Currency Formatting', () => {
    it('should format currency with symbol after (default)', () => {
      const result = manager.formatCurrency(1000);
      expect(result).toBe('1,000.00 ﷼');
    });

    it('should format currency with symbol before', () => {
      manager.setCurrency({ position: 'before' });
      const result = manager.formatCurrency(1000);
      expect(result).toBe('$1,000.00');
    });

    it('should use currency decimal places', () => {
      manager.setCurrency({ decimalPlaces: 0 });
      const result = manager.formatCurrency(1000);
      expect(result).toMatch(/1,000\s/); // No decimals
    });

    it('should handle negative currency values', () => {
      const result = manager.formatCurrency(-500);
      expect(result).toBe('-500.00 ﷼');
    });
  });

  describe('Date Formatting', () => {
    it('should format date with default pattern', () => {
      const date = new Date('2026-11-11T10:30:00');
      const result = manager.formatDate(date);
      expect(result).toBe('11/11/2026');
    });

    it('should format date from ISO string', () => {
      const result = manager.formatDate('2026-11-11T10:30:00');
      expect(result).toBe('11/11/2026');
    });

    it('should handle different date patterns', () => {
      manager.setDateFormat({ datePattern: 'YYYY-MM-DD' });
      const date = new Date('2026-11-11T10:30:00');
      const result = manager.formatDate(date);
      expect(result).toBe('2026-11-11');
    });

    it('should return empty string for invalid date', () => {
      expect(manager.formatDate('invalid')).toBe('');
      expect(manager.formatDate(new Date('invalid'))).toBe('');
    });

    it('should pad single digit day and month', () => {
      const date = new Date('2026-01-05T10:30:00');
      const result = manager.formatDate(date);
      expect(result).toBe('05/01/2026');
    });
  });

  describe('DateTime Formatting', () => {
    it('should format datetime with both date and time', () => {
      const date = new Date('2026-11-11T10:30:45');
      const result = manager.formatDateTime(date);
      expect(result).toContain('11/11/2026');
      expect(result).toContain('10:30:45');
    });

    it('should format datetime from ISO string', () => {
      const result = manager.formatDateTime('2026-11-11T10:30:45');
      expect(result).toContain('11/11/2026');
      expect(result).toContain('10:30:45');
    });

    it('should handle different time patterns', () => {
      manager.setDateFormat({ timePattern: 'HH:mm' });
      const date = new Date('2026-11-11T10:30:45');
      const result = manager.formatDateTime(date);
      expect(result).toContain('10:30');
      expect(result).not.toContain('45');
    });

    it('should return empty string for invalid datetime', () => {
      expect(manager.formatDateTime('invalid')).toBe('');
    });
  });

  describe('Configuration Immutability', () => {
    it('should return immutable config', () => {
      const config = manager.getConfig();
      expect(() => {
        (config as any).name = 'new name';
      }).toThrow();
    });
  });

  describe('Reset to Defaults', () => {
    it('should reset all configurations to defaults', () => {
      manager.setStoreName('متجر جديد');
      manager.setCurrency({ symbol: '$' });
      manager.setNumberFormat({ decimalPlaces: 3 });

      manager.resetToDefaults();

      expect(manager.getStoreName()).toBe(DEFAULT_STORE_CONFIG.name);
      expect(manager.getCurrency()).toEqual(DEFAULT_STORE_CONFIG.currency);
      expect(manager.getNumberFormat()).toEqual(DEFAULT_STORE_CONFIG.numberFormat);
    });
  });

  describe('Convenience Functions', () => {
    beforeEach(() => {
      manager.resetToDefaults();
    });

    it('should provide formatNumber convenience function', () => {
      const result = formatNumber(1234.56);
      expect(result).toBe('1,234.56');
    });

    it('should provide formatCurrency convenience function', () => {
      const result = formatCurrency(1000);
      expect(result).toContain('1,000');
    });

    it('should provide formatDate convenience function', () => {
      const result = formatDate(new Date('2026-11-11'));
      expect(result).toBe('11/11/2026');
    });

    it('should provide formatDateTime convenience function', () => {
      const result = formatDateTime(new Date('2026-11-11T10:30:45'));
      expect(result).toContain('11/11/2026');
    });
  });
});
