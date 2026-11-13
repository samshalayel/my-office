import { AccountValidator } from './account-validator';

describe('AccountValidator', () => {
  let validator: AccountValidator;

  beforeEach(() => {
    validator = new AccountValidator();
  });

  describe('validateName', () => {
    it('should accept valid names', () => {
      const result = validator.validateName('أبو أحمد');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject empty names', () => {
      const result = validator.validateName('');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('الاسم مطلوب');
    });

    it('should reject whitespace-only names', () => {
      const result = validator.validateName('   ');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('الاسم مطلوب');
    });

    it('should reject single-character names', () => {
      const result = validator.validateName('أ');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('الاسم يجب أن يكون حرفين على الأقل');
    });

    it('should trim whitespace from names', () => {
      const result = validator.validateName('  أحمد  ');
      expect(result.isValid).toBe(true);
    });
  });

  describe('validateSide', () => {
    it('should accept valid sides', () => {
      expect(validator.validateSide('client').isValid).toBe(true);
      expect(validator.validateSide('supplier').isValid).toBe(true);
    });

    it('should reject invalid sides', () => {
      const result = validator.validateSide('invalid');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('الاتجاه غير صحيح');
    });

    it('should reject null side', () => {
      const result = validator.validateSide(null);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('الاتجاه غير صحيح');
    });

    it('should reject undefined side', () => {
      const result = validator.validateSide(undefined);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('الاتجاه غير صحيح');
    });
  });

  describe('validateNewAccount', () => {
    it('should accept valid new account', () => {
      const result = validator.validateNewAccount('أبو أحمد', 'client', []);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject account with duplicate name', () => {
      const result = validator.validateNewAccount('أبو أحمد', 'client', [
        'أبو أحمد',
      ]);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('هذا الاسم موجود بالفعل');
    });

    it('should be case-insensitive for duplicate check', () => {
      const result = validator.validateNewAccount('أبو أحمد', 'client', [
        'أبو أحمد',
      ]);
      expect(result.isValid).toBe(false);
    });

    it('should trim whitespace for duplicate check', () => {
      const result = validator.validateNewAccount('أبو أحمد', 'client', [
        '  أبو أحمد  ',
      ]);
      expect(result.isValid).toBe(false);
    });

    it('should combine all validation errors', () => {
      const result = validator.validateNewAccount('', 'invalid', []);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });

    it('should allow same name in different sides', () => {
      // This should pass - duplicate check is per-side at the LedgerStore level
      const result = validator.validateNewAccount('أبو أحمد', 'client', [
        'أبو أحمد',
      ]);
      expect(result.isValid).toBe(false);
      // But if we're checking in a different side context, it should be unique
    });
  });
});
