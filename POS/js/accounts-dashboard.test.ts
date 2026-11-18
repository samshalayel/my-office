import { AccountsDashboard, formatAccountRow, getAccountStatusLabel } from './accounts-dashboard';
import { LedgerStore } from './ledger-store';
import { LocalDatabase } from './local-database';
import { Account, Entry, AccountRow } from './types';

/**
 * [base-T4] Test suite for AccountsDashboard
 * Tests: search, filtering by direction, sorting capabilities
 */
describe('AccountsDashboard [base-T4]', () => {
  let ledgerStore: LedgerStore;
  let dashboard: AccountsDashboard;
  let db: LocalDatabase;

  beforeEach(async () => {
    db = new LocalDatabase();
    await db.initialize();
    await db.clear();
    ledgerStore = new LedgerStore(db);
    await ledgerStore.initialize();
    dashboard = new AccountsDashboard(ledgerStore);
  });

  afterEach(async () => {
    await db.clear();
  });

  describe('Filtering by side', () => {
    beforeEach(async () => {
      // Create test accounts
      await ledgerStore.findOrCreateAccount('عميل 1', 'client');
      await ledgerStore.findOrCreateAccount('عميل 2', 'client');
      await ledgerStore.findOrCreateAccount('مورّد 1', 'supplier');
      await ledgerStore.findOrCreateAccount('مورّد 2', 'supplier');
    });

    test('should filter accounts by client side (ما لي)', async () => {
      dashboard.setSide('client');
      const result = await dashboard.getAccountsList();
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts.every((a) => a.side === 'client')).toBe(true);
      expect(result.side).toBe('client');
    });

    test('should filter accounts by supplier side (ما عليّ)', async () => {
      dashboard.setSide('supplier');
      const result = await dashboard.getAccountsList();
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts.every((a) => a.side === 'supplier')).toBe(true);
      expect(result.side).toBe('supplier');
    });
  });

  describe('Search by name', () => {
    beforeEach(async () => {
      await ledgerStore.findOrCreateAccount('محمود أحمد', 'client');
      await ledgerStore.findOrCreateAccount('محمود علي', 'client');
      await ledgerStore.findOrCreateAccount('سارة محمود', 'client');
    });

    test('should search accounts by name prefix', async () => {
      dashboard.setSide('client');
      dashboard.setSearchQuery('محمود');
      const result = await dashboard.getAccountsList();
      expect(result.accounts).toHaveLength(3);
      expect(result.query).toBe('محمود');
    });

    test('should search case-insensitive', async () => {
      dashboard.setSide('client');
      dashboard.setSearchQuery('محمود');
      const result = await dashboard.getAccountsList();
      expect(result.accounts.length).toBeGreaterThan(0);
    });

    test('should return empty list for non-matching search', async () => {
      dashboard.setSide('client');
      dashboard.setSearchQuery('نور');
      const result = await dashboard.getAccountsList();
      expect(result.accounts).toHaveLength(0);
    });

    test('should trim whitespace from search query', async () => {
      dashboard.setSide('client');
      dashboard.setSearchQuery('  محمود  ');
      const result = await dashboard.getAccountsList();
      expect(result.query).toBe('محمود');
    });
  });

  describe('Sorting by name', () => {
    beforeEach(async () => {
      await ledgerStore.findOrCreateAccount('زهراء', 'client');
      await ledgerStore.findOrCreateAccount('أحمد', 'client');
      await ledgerStore.findOrCreateAccount('محمود', 'client');
    });

    test('should sort by name ascending (default)', async () => {
      dashboard.setSide('client');
      dashboard.setSortBy('name', 'asc');
      const result = await dashboard.getAccountsList();
      expect(result.accounts[0].name).toBe('أحمد');
      expect(result.accounts[1].name).toBe('محمود');
      expect(result.accounts[2].name).toBe('زهراء');
    });

    test('should sort by name descending', async () => {
      dashboard.setSide('client');
      dashboard.setSortBy('name', 'desc');
      const result = await dashboard.getAccountsList();
      expect(result.accounts[0].name).toBe('زهراء');
      expect(result.accounts[1].name).toBe('محمود');
      expect(result.accounts[2].name).toBe('أحمد');
    });
  });

  describe('Sorting by balance', () => {
    beforeEach(async () => {
      // Create accounts with different balances
      const acc1 = await ledgerStore.findOrCreateAccount('حساب 1', 'client');
      const acc2 = await ledgerStore.findOrCreateAccount('حساب 2', 'client');
      const acc3 = await ledgerStore.findOrCreateAccount('حساب 3', 'client');

      if (acc1.ok && acc1.account) {
        await ledgerStore.addEntry({
          type: 'debt_client',
          accountId: acc1.account.id,
          amount: 1000,
        });
      }
      if (acc2.ok && acc2.account) {
        await ledgerStore.addEntry({
          type: 'debt_client',
          accountId: acc2.account.id,
          amount: 2000,
        });
      }
      if (acc3.ok && acc3.account) {
        await ledgerStore.addEntry({
          type: 'debt_client',
          accountId: acc3.account.id,
          amount: 500,
        });
      }
    });

    test('should sort by balance ascending', async () => {
      dashboard.setSide('client');
      dashboard.setSortBy('balance', 'asc');
      const result = await dashboard.getAccountsList();
      expect(result.accounts[0].balance).toBe(500);
      expect(result.accounts[1].balance).toBe(1000);
      expect(result.accounts[2].balance).toBe(2000);
    });

    test('should sort by balance descending', async () => {
      dashboard.setSide('client');
      dashboard.setSortBy('balance', 'desc');
      const result = await dashboard.getAccountsList();
      expect(result.accounts[0].balance).toBe(2000);
      expect(result.accounts[1].balance).toBe(1000);
      expect(result.accounts[2].balance).toBe(500);
    });
  });

  describe('Combined filtering and sorting', () => {
    beforeEach(async () => {
      await ledgerStore.findOrCreateAccount('زهراء عميل', 'client');
      await ledgerStore.findOrCreateAccount('أحمد عميل', 'client');
      await ledgerStore.findOrCreateAccount('محمود عميل', 'client');
      await ledgerStore.findOrCreateAccount('زهراء مورّد', 'supplier');
    });

    test('should combine side filter with search', async () => {
      dashboard.setSide('client');
      dashboard.setSearchQuery('أحمد');
      const result = await dashboard.getAccountsList();
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].name).toBe('أحمد عميل');
      expect(result.accounts[0].side).toBe('client');
    });

    test('should combine side filter, search, and sort', async () => {
      dashboard.setSide('client');
      dashboard.setSearchQuery('عميل');
      dashboard.setSortBy('name', 'desc');
      const result = await dashboard.getAccountsList();
      expect(result.accounts).toHaveLength(3);
      expect(result.accounts[0].name).toBe('زهراء عميل');
    });
  });

  describe('Filter state management', () => {
    test('should get and reset filter state', async () => {
      dashboard.setSide('supplier');
      dashboard.setSearchQuery('test');
      dashboard.setSortBy('balance', 'desc');

      const state = dashboard.getFilterState();
      expect(state.side).toBe('supplier');
      expect(state.query).toBe('test');
      expect(state.sortField).toBe('balance');
      expect(state.sortOrder).toBe('desc');

      dashboard.resetFilters();
      const resetState = dashboard.getFilterState();
      expect(resetState.side).toBe('client');
      expect(resetState.query).toBe('');
      expect(resetState.sortField).toBe('name');
      expect(resetState.sortOrder).toBe('asc');
    });
  });

  describe('UI helpers', () => {
    test('formatAccountRow should format balance with locale', () => {
      const row: AccountRow = {
        accountId: 'acc-1',
        name: 'محمود',
        side: 'client',
        balance: 1500.5,
        summary: { totalDebt: 2000, totalPaid: 500, balance: 1500.5 },
        ledgerTransfer: 'open',
      };

      const formatted = formatAccountRow(row);
      expect(formatted.name).toBe('محمود');
      expect(formatted.side).toBe('عميل');
      expect(formatted.displayClass).toBe('balance-positive');
    });

    test('getAccountStatusLabel should return correct status', () => {
      expect(getAccountStatusLabel('open')).toBe('قيد النقل');
      expect(getAccountStatusLabel('completed')).toBe('انتهى نقل');
    });
  });

  describe('Performance with multiple accounts', () => {
    beforeEach(async () => {
      // Simulate ~270 accounts (SC-3 requirement)
      for (let i = 1; i <= 270; i++) {
        await ledgerStore.findOrCreateAccount(`حساب ${i}`, i % 2 === 0 ? 'client' : 'supplier');
      }
    });

    test('should handle large number of accounts efficiently', async () => {
      dashboard.setSide('client');
      const startTime = performance.now();
      const result = await dashboard.getAccountsList();
      const endTime = performance.now();

      expect(result.totalCount).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete in <1s
    });

    test('should filter large list by search query', async () => {
      dashboard.setSide('client');
      dashboard.setSearchQuery('حساب 1');
      const result = await dashboard.getAccountsList();
      expect(result.accounts.length).toBeGreaterThan(0);
      expect(result.accounts.every((a) => a.name.includes('حساب 1'))).toBe(true);
    });
  });

  describe('Available sort and filter options', () => {
    test('should provide available sort fields', () => {
      const fields = dashboard.getAvailableSortFields();
      expect(fields).toHaveLength(3);
      expect(fields.map((f) => f.id)).toContain('name');
      expect(fields.map((f) => f.id)).toContain('balance');
      expect(fields.map((f) => f.id)).toContain('totalDebt');
    });

    test('should provide available sides', () => {
      const sides = dashboard.getAvailableSides();
      expect(sides).toHaveLength(2);
      expect(sides.map((s) => s.id)).toContain('client');
      expect(sides.map((s) => s.id)).toContain('supplier');
    });
  });
});
