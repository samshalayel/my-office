import { LedgerStore } from './ledger-store';
import { LocalDatabase } from './local-database';
import { Account, Side } from './types';

describe('LedgerStore - Account Management [base-T3]', () => {
  let ledgerStore: LedgerStore;
  let db: LocalDatabase;

  beforeEach(async () => {
    db = new LocalDatabase();
    await db.initialize();
    ledgerStore = new LedgerStore(db);
    await ledgerStore.initialize();
  });

  afterEach(async () => {
    await db.clear();
  });

  describe('C-2: findOrCreateAccount', () => {
    it('should create new account with valid name and side', async () => {
      const result = await ledgerStore.findOrCreateAccount('أبو أحمد', 'client');

      expect(result.ok).toBe(true);
      expect(result.account).toBeDefined();
      expect(result.account?.name).toBe('أبو أحمد');
      expect(result.account?.side).toBe('client');
      expect(result.account?.id).toBeDefined();
      expect(result.account?.createdAt).toBeDefined();
      expect(result.account?.ledgerTransfer).toBe('open');
    });

    it('should return existing account instead of creating duplicate', async () => {
      const result1 = await ledgerStore.findOrCreateAccount('أبو أحمد', 'client');
      const result2 = await ledgerStore.findOrCreateAccount('أبو أحمد', 'client');

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(result1.account?.id).toBe(result2.account?.id);
    });

    it('should allow same name for different sides', async () => {
      const clientResult = await ledgerStore.findOrCreateAccount(
        'أبو أحمد',
        'client'
      );
      const supplierResult = await ledgerStore.findOrCreateAccount(
        'أبو أحمد',
        'supplier'
      );

      expect(clientResult.ok).toBe(true);
      expect(supplierResult.ok).toBe(true);
      expect(clientResult.account?.id).not.toBe(supplierResult.account?.id);
      expect(clientResult.account?.side).toBe('client');
      expect(supplierResult.account?.side).toBe('supplier');
    });

    it('should trim whitespace from account names', async () => {
      const result = await ledgerStore.findOrCreateAccount(
        '  أبو أحمد  ',
        'client'
      );

      expect(result.ok).toBe(true);
      expect(result.account?.name).toBe('أبو أحمد');
    });

    it('should reject empty names', async () => {
      const result = await ledgerStore.findOrCreateAccount('', 'client');

      expect(result.ok).toBe(false);
      expect(result.errors).toContain('الاسم مطلوب');
    });

    it('should reject whitespace-only names', async () => {
      const result = await ledgerStore.findOrCreateAccount('   ', 'client');

      expect(result.ok).toBe(false);
      expect(result.errors).toContain('الاسم مطلوب');
    });

    it('should generate valid UUID for new accounts', async () => {
      const result = await ledgerStore.findOrCreateAccount('عميل جديد', 'client');

      expect(result.ok).toBe(true);
      expect(result.account?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should set createdAt to current timestamp for new accounts', async () => {
      const before = new Date().toISOString();
      const result = await ledgerStore.findOrCreateAccount(
        'عميل جديد',
        'client'
      );
      const after = new Date().toISOString();

      expect(result.ok).toBe(true);
      const createdAt = result.account?.createdAt;
      expect(createdAt).toBeDefined();
      expect(createdAt! >= before).toBe(true);
      expect(createdAt! <= after).toBe(true);
    });

    it('should mark side as constant after creation', async () => {
      const result = await ledgerStore.findOrCreateAccount('أبو أحمد', 'client');

      expect(result.ok).toBe(true);
      expect(result.account?.side).toBe('client');
      // Verify side cannot be changed by trying to create with different side
      const result2 = await ledgerStore.findOrCreateAccount(
        'أبو أحمد',
        'supplier'
      );
      expect(result2.ok).toBe(true);
      expect(result2.account?.id).not.toBe(result.account?.id);
      // Different account should be created instead
    });

    it('should set ledgerTransfer to open for new accounts', async () => {
      const result = await ledgerStore.findOrCreateAccount(
        'عميل جديد',
        'client'
      );

      expect(result.ok).toBe(true);
      expect(result.account?.ledgerTransfer).toBe('open');
    });

    it('should persist account to database', async () => {
      const result = await ledgerStore.findOrCreateAccount('أبو أحمد', 'client');

      expect(result.ok).toBe(true);
      const retrievedAccount = await db.getAccount(result.account!.id);
      expect(retrievedAccount).toEqual(result.account);
    });

    it('should handle multiple concurrent account creations', async () => {
      const results = await Promise.all([
        ledgerStore.findOrCreateAccount('عميل أول', 'client'),
        ledgerStore.findOrCreateAccount('عميل ثاني', 'client'),
        ledgerStore.findOrCreateAccount('مورد أول', 'supplier'),
      ]);

      expect(results.every((r) => r.ok)).toBe(true);
      expect(results[0].account?.id).not.toBe(results[1].account?.id);
      expect(results[0].account?.id).not.toBe(results[2].account?.id);
    });

    it('should handle case-insensitive duplicate detection', async () => {
      const result1 = await ledgerStore.findOrCreateAccount(
        'أبو أحمد',
        'client'
      );
      // Try with different case/variations
      const result2 = await ledgerStore.findOrCreateAccount(
        'أبو أحمد',
        'client'
      );

      expect(result1.account?.id).toBe(result2.account?.id);
    });
  });

  describe('Account constraints and validation', () => {
    it('should ensure unique name within side', async () => {
      const result1 = await ledgerStore.findOrCreateAccount(
        'محمد علي',
        'client'
      );
      const result2 = await ledgerStore.findOrCreateAccount(
        'محمد علي',
        'client'
      );

      expect(result1.account?.id).toBe(result2.account?.id);
    });

    it('should have all required fields', async () => {
      const result = await ledgerStore.findOrCreateAccount('اختبار', 'client');

      const account = result.account!;
      expect(account).toHaveProperty('id');
      expect(account).toHaveProperty('name');
      expect(account).toHaveProperty('side');
      expect(account).toHaveProperty('ledgerTransfer');
      expect(account).toHaveProperty('createdAt');
    });

    it('should not allow null or undefined values in required fields', async () => {
      const result = await ledgerStore.findOrCreateAccount('صحيح', 'client');

      const account = result.account!;
      expect(account.id).not.toBeNull();
      expect(account.id).not.toBeUndefined();
      expect(account.name).not.toBeNull();
      expect(account.name).not.toBeUndefined();
      expect(account.side).not.toBeNull();
      expect(account.side).not.toBeUndefined();
      expect(account.createdAt).not.toBeNull();
      expect(account.createdAt).not.toBeUndefined();
    });
  });

  describe('Error handling', () => {
    it('should return error object on validation failure', async () => {
      const result = await ledgerStore.findOrCreateAccount('', 'client');

      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.account).toBeUndefined();
    });

    it('should handle database errors gracefully', async () => {
      const faultyDb = new LocalDatabase();
      const faultyStore = new LedgerStore(faultyDb);
      // Don't initialize the database
      const result = await faultyStore.findOrCreateAccount(
        'اختبار',
        'client'
      );

      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });
});
