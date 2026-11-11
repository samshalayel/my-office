import { Side } from './types';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export class AccountValidator {
  validateName(name: string): ValidationResult {
    const errors: string[] = [];

    if (!name || name.trim().length === 0) {
      errors.push('الاسم مطلوب');
    }

    if (name && name.trim().length > 0 && name.trim().length < 2) {
      errors.push('الاسم يجب أن يكون حرفين على الأقل');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  validateSide(side: unknown): ValidationResult {
    const errors: string[] = [];
    const validSides: Side[] = ['client', 'supplier'];

    if (!side || !validSides.includes(side as Side)) {
      errors.push('الاتجاه غير صحيح');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  validateNewAccount(
    name: string,
    side: unknown,
    existingNames: string[] = []
  ): ValidationResult {
    const errors: string[] = [];

    // Validate name
    const nameValidation = this.validateName(name);
    errors.push(...nameValidation.errors);

    // Validate side
    const sideValidation = this.validateSide(side);
    errors.push(...sideValidation.errors);

    // Check for duplicate name within side
    const normalizedName = name.trim().toLowerCase();
    if (existingNames.some((n) => n.toLowerCase() === normalizedName)) {
      errors.push('هذا الاسم موجود بالفعل');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}
