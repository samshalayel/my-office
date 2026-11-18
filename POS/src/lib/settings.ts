/**
 * POS Settings Module
 * Handles configurable: store name, currency, number formats, date formats
 * BASE-8 Implementation
 */

export interface CurrencyConfig {
  code: string;          // e.g., "SAR", "USD"
  symbol: string;        // e.g., "﷼", "$"
  position: 'before' | 'after'; // Currency symbol position
  decimalPlaces: number; // 2 for most currencies
}

export interface NumberFormat {
  decimalSeparator: string;   // "." or ","
  thousandsSeparator: string; // "," or "."
  decimalPlaces: number;
}

export interface DateFormat {
  locale: string;           // "en-US", "ar-SA", etc.
  datePattern: string;      // "DD/MM/YYYY", "YYYY-MM-DD", etc.
  timePattern: string;      // "HH:mm", "HH:mm:ss"
  timezone?: string;        // Optional timezone
}

export interface StoreConfig {
  name: string;
  currency: CurrencyConfig;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
}

/**
 * Default configuration
 * Can be overridden by user settings
 */
export const DEFAULT_STORE_CONFIG: StoreConfig = {
  name: 'متجري',
  currency: {
    code: 'SAR',
    symbol: '﷼',
    position: 'after',
    decimalPlaces: 2,
  },
  numberFormat: {
    decimalSeparator: '.',
    thousandsSeparator: ',',
    decimalPlaces: 2,
  },
  dateFormat: {
    locale: 'ar-SA',
    datePattern: 'DD/MM/YYYY',
    timePattern: 'HH:mm:ss',
  },
};

/**
 * Settings manager - singleton for accessing and updating store configuration
 * Stores configuration in localStorage for persistence
 */
export class SettingsManager {
  private static instance: SettingsManager;
  private config: StoreConfig;
  private readonly storageKey = 'pos_store_config';

  private constructor() {
    this.config = this.loadConfig();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  /**
   * Load configuration from localStorage or use defaults
   */
  private loadConfig(): StoreConfig {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const stored = window.localStorage.getItem(this.storageKey);
        if (stored) {
          return JSON.parse(stored);
        }
      }
    } catch (error) {
      console.warn('Failed to load settings from localStorage:', error);
    }
    return structuredClone(DEFAULT_STORE_CONFIG);
  }

  /**
   * Save configuration to localStorage
   */
  private saveConfig(): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(this.storageKey, JSON.stringify(this.config));
      }
    } catch (error) {
      console.error('Failed to save settings to localStorage:', error);
    }
  }

  /**
   * Get entire store configuration
   */
  getConfig(): Readonly<StoreConfig> {
    return Object.freeze({ ...this.config });
  }

  /**
   * Get store name
   */
  getStoreName(): string {
    return this.config.name;
  }

  /**
   * Set store name
   */
  setStoreName(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new Error('Store name cannot be empty');
    }
    this.config.name = name.trim();
    this.saveConfig();
  }

  /**
   * Get currency configuration
   */
  getCurrency(): Readonly<CurrencyConfig> {
    return Object.freeze({ ...this.config.currency });
  }

  /**
   * Set currency configuration
   */
  setCurrency(currency: Partial<CurrencyConfig>): void {
    const required = ['code', 'symbol', 'position', 'decimalPlaces'];
    const updated = { ...this.config.currency, ...currency };

    required.forEach(field => {
      if (updated[field as keyof CurrencyConfig] === undefined) {
        throw new Error(`Currency ${field} is required`);
      }
    });

    if (updated.decimalPlaces < 0 || updated.decimalPlaces > 10) {
      throw new Error('Decimal places must be between 0 and 10');
    }

    if (updated.position !== 'before' && updated.position !== 'after') {
      throw new Error('Currency position must be "before" or "after"');
    }

    this.config.currency = updated;
    this.saveConfig();
  }

  /**
   * Get number format
   */
  getNumberFormat(): Readonly<NumberFormat> {
    return Object.freeze({ ...this.config.numberFormat });
  }

  /**
   * Set number format
   */
  setNumberFormat(format: Partial<NumberFormat>): void {
    const updated = { ...this.config.numberFormat, ...format };

    if (!updated.decimalSeparator) {
      throw new Error('Decimal separator is required');
    }
    if (!updated.thousandsSeparator) {
      throw new Error('Thousands separator is required');
    }
    if (updated.decimalSeparator === updated.thousandsSeparator) {
      throw new Error('Decimal and thousands separators cannot be the same');
    }
    if (updated.decimalPlaces < 0 || updated.decimalPlaces > 10) {
      throw new Error('Decimal places must be between 0 and 10');
    }

    this.config.numberFormat = updated;
    this.saveConfig();
  }

  /**
   * Get date format
   */
  getDateFormat(): Readonly<DateFormat> {
    return Object.freeze({ ...this.config.dateFormat });
  }

  /**
   * Set date format
   */
  setDateFormat(format: Partial<DateFormat>): void {
    const updated = { ...this.config.dateFormat, ...format };

    if (!updated.locale) {
      throw new Error('Locale is required');
    }
    if (!updated.datePattern) {
      throw new Error('Date pattern is required');
    }
    if (!updated.timePattern) {
      throw new Error('Time pattern is required');
    }

    this.config.dateFormat = updated;
    this.saveConfig();
  }

  /**
   * Format a number according to current settings
   * HR-6: All calculations use native numbers; formatting is UI only
   */
  formatNumber(value: number, customDecimalPlaces?: number): string {
    const decimalPlaces = customDecimalPlaces ?? this.config.numberFormat.decimalPlaces;
    const fixed = value.toFixed(decimalPlaces);
    const [integerPart, decimalPart] = fixed.split('.');

    // Add thousands separator to integer part
    const formatted = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, this.config.numberFormat.thousandsSeparator);

    if (decimalPlaces === 0) {
      return formatted;
    }

    return formatted + this.config.numberFormat.decimalSeparator + decimalPart;
  }

  /**
   * Format currency value
   */
  formatCurrency(value: number): string {
    const formatted = this.formatNumber(value, this.config.currency.decimalPlaces);
    const symbol = this.config.currency.symbol;

    if (this.config.currency.position === 'before') {
      return `${symbol}${formatted}`;
    } else {
      return `${formatted} ${symbol}`;
    }
  }

  /**
   * Format date according to current settings
   */
  formatDate(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;

    if (isNaN(d.getTime())) {
      return '';
    }

    // Simple pattern replacements - can be extended
    let pattern = this.config.dateFormat.datePattern;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();

    pattern = pattern.replace('DD', day).replace('MM', month).replace('YYYY', String(year));

    return pattern;
  }

  /**
   * Format datetime
   */
  formatDateTime(date: Date | string): string {
    const dateStr = this.formatDate(date);
    const d = typeof date === 'string' ? new Date(date) : date;

    if (isNaN(d.getTime())) {
      return '';
    }

    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');

    let pattern = this.config.dateFormat.timePattern;
    pattern = pattern.replace('HH', hours).replace('mm', minutes).replace('ss', seconds);

    return `${dateStr} ${pattern}`;
  }

  /**
   * Reset configuration to defaults
   */
  resetToDefaults(): void {
    this.config = structuredClone(DEFAULT_STORE_CONFIG);
    this.saveConfig();
  }
}

/**
 * Convenience exports
 */
export const settingsManager = SettingsManager.getInstance();

export function getStoreName(): string {
  return settingsManager.getStoreName();
}

export function setStoreName(name: string): void {
  settingsManager.setStoreName(name);
}

export function getCurrencyConfig(): Readonly<CurrencyConfig> {
  return settingsManager.getCurrency();
}

export function getNumberFormat(): Readonly<NumberFormat> {
  return settingsManager.getNumberFormat();
}

export function getDateFormat(): Readonly<DateFormat> {
  return settingsManager.getDateFormat();
}

export function formatNumber(value: number): string {
  return settingsManager.formatNumber(value);
}

export function formatCurrency(value: number): string {
  return settingsManager.formatCurrency(value);
}

export function formatDate(date: Date | string): string {
  return settingsManager.formatDate(date);
}

export function formatDateTime(date: Date | string): string {
  return settingsManager.formatDateTime(date);
}
