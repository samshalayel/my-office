import { NewEntry, EntryType, Side } from './types';

interface ValidationError {
  field: string;
  message: string;
}

export class InputValidator {
  static validateEntry(entry: NewEntry): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!entry) {
      errors.push({ field: 'entry', message: 'القيد مطلوب' });
      return errors;
    }

    // Validate type
    const validTypes: EntryType[] = [
      'debt_client',
      'debt_supplier',
      'payment_from_client',
      'payment_to_supplier',
      'cash_sale',
      'opening',
    ];

    if (!entry.type || !validTypes.includes(entry.type)) {
      errors.push({ field: 'type', message: 'نوع القيد غير صحيح' });
    }

    // Validate accountId requirement
    if (
      entry.type &&
      entry.type !== 'cash_sale' &&
      (!entry.accountId || entry.accountId.trim().length === 0)
    ) {
      errors.push({ field: 'accountId', message: 'حساب الطرف مطلوب' });
    }

    // Validate amount
    if (!entry.amount || typeof entry.amount !== 'number') {
      errors.push({ field: 'amount', message: 'المبلغ يجب أن يكون رقماً' });
    } else if (entry.amount <= 0) {
      errors.push({ field: 'amount', message: 'المبلغ يجب أن يكون أكبر من صفر' });
    } else if (!Number.isFinite(entry.amount)) {
      errors.push({ field: 'amount', message: 'المبلغ غير صحيح' });
    }

    // Validate timestamp if provided
    if (entry.ts) {
      const ts = new Date(entry.ts);
      if (isNaN(ts.getTime())) {
        errors.push({ field: 'ts', message: 'التاريخ غير صحيح' });
      } else if (ts > new Date()) {
        errors.push({ field: 'ts', message: 'التاريخ لا يمكن أن يكون في المستقبل' });
      }
    }

    // Validate optional note
    if (entry.note) {
      if (typeof entry.note !== 'string') {
        errors.push({ field: 'note', message: 'الملاحظة يجب أن تكون نصاً' });
      } else if (entry.note.length > 1000) {
        errors.push({ field: 'note', message: 'الملاحظة طويلة جداً (أقصى 1000 حرف)' });
      }
    }

    // Validate linkedTo if provided
    if (entry.linkedTo) {
      if (typeof entry.linkedTo !== 'string' || entry.linkedTo.trim().length === 0) {
        errors.push({ field: 'linkedTo', message: 'معرف القيد المرتبط غير صحيح' });
      }
    }

    return errors;
  }

  static validateAccountName(name: string): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!name || typeof name !== 'string') {
      errors.push({ field: 'name', message: 'الاسم مطلوب' });
      return errors;
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      errors.push({ field: 'name', message: 'الاسم لا يمكن أن يكون فارغاً' });
    } else if (trimmedName.length < 2) {
      errors.push({ field: 'name', message: 'الاسم يجب أن يكون 2 حرف على الأقل' });
    } else if (trimmedName.length > 200) {
      errors.push({ field: 'name', message: 'الاسم طويل جداً (أقصى 200 حرف)' });
    }

    return errors;
  }

  static validateSide(side: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const validSides: Side[] = ['client', 'supplier'];

    if (!side || !validSides.includes(side as Side)) {
      errors.push({ field: 'side', message: 'نوع الطرف غير صحيح' });
    }

    return errors;
  }

  static validateCorrectionAmount(amount: number): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!amount || typeof amount !== 'number') {
      errors.push({ field: 'amount', message: 'المبلغ يجب أن يكون رقماً' });
    } else if (amount <= 0) {
      errors.push({ field: 'amount', message: 'المبلغ يجب أن يكون أكبر من صفر' });
    } else if (!Number.isFinite(amount)) {
      errors.push({ field: 'amount', message: 'المبلغ غير صحيح' });
    }

    return errors;
  }

  static validateDate(dateString: string): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!dateString || typeof dateString !== 'string') {
      errors.push({ field: 'date', message: 'التاريخ مطلوب' });
      return errors;
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateString)) {
      errors.push({ field: 'date', message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD' });
      return errors;
    }

    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      errors.push({ field: 'date', message: 'التاريخ غير صحيح' });
    } else if (date > new Date()) {
      errors.push({ field: 'date', message: 'التاريخ لا يمكن أن يكون في المستقبل' });
    }

    return errors;
  }

  static validateSearchQuery(query: string | undefined): ValidationError[] {
    const errors: ValidationError[] = [];

    if (query === undefined || query === null) {
      return errors;
    }

    if (typeof query !== 'string') {
      errors.push({ field: 'query', message: 'الاستعلام يجب أن يكون نصاً' });
    } else if (query.length > 500) {
      errors.push({ field: 'query', message: 'الاستعلام طويل جداً' });
    }

    return errors;
  }

  static sanitizeString(input: string): string {
    if (typeof input !== 'string') {
      return '';
    }
    return input.trim();
  }

  static sanitizeAmount(input: number): number {
    const num = Number(input);
    if (!Number.isFinite(num)) {
      return 0;
    }
    return Math.round(num * 100) / 100; // Round to 2 decimal places
  }
}
