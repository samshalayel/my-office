import {
  Account,
  Entry,
  NewEntry,
  EntryResult,
  AccountResult,
  AccountSummary,
  AccountRow,
  DayLogRow,
  DerivedBalance,
  EntryType,
  Side,
} from './types';
import { LocalDatabase } from './local-database';

export class LedgerStore {
  private db: LocalDatabase;

  constructor(database: LocalDatabase) {
    this.db = database;
  }

  async initialize(): Promise<void> {
    await this.db.initialize();
    const meta = await this.db.getMetaData();
    if (!meta) {
      await this.db.setMetaData({
        schemaVersion: 1,
        lastInitialized: new Date().toISOString(),
      });
    }
  }

  // C-1: addEntry
  async addEntry(entry: NewEntry): Promise<EntryResult> {
    const validationErrors = this.validateEntry(entry);
    if (validationErrors.length > 0) {
      return { ok: false, errors: validationErrors };
    }

    const id = this.generateUUID();
    const ts = entry.ts || new Date().toISOString();

    const newEntry: Entry = {
      id,
      type: entry.type,
      accountId: entry.accountId,
      amount: entry.amount,
      ts,
      note: entry.note,
      linkedTo: entry.linkedTo,
    };

    try {
      await this.db.appendEntry(newEntry);
      return { ok: true, entry: newEntry };
    } catch (error) {
      return { ok: false, errors: [`Failed to add entry: ${error}`] };
    }
  }

  // C-2: findOrCreateAccount
  async findOrCreateAccount(name: string, side: Side): Promise<AccountResult> {
    if (!name || name.trim().length === 0) {
      return { ok: false, errors: ['الاسم مطلوب'] };
    }

    try {
      const existing = await this.db.findOrCreateAccount(name.trim(), side);
      if (existing) {
        return { ok: true, account: existing };
      }

      const id = this.generateUUID();
      const newAccount: Account = {
        id,
        name: name.trim(),
        side,
        ledgerTransfer: 'open',
        createdAt: new Date().toISOString(),
      };

      await this.db.createAccount(newAccount);
      return { ok: true, account: newAccount };
    } catch (error) {
      return { ok: false, errors: [`Failed to create account: ${error}`] };
    }
  }

  // C-3: getAccountSummary
  async getAccountSummary(accountId: string): Promise<AccountSummary | null> {
    try {
      const account = await this.db.getAccount(accountId);
      if (!account) {
        return null;
      }

      const entries = await this.db.getEntriesByAccount(accountId);
      const summary = this.calculateBalance(entries, account.side);

      return {
        account,
        summary,
        entries,
      };
    } catch (error) {
      console.error(`Failed to get account summary: ${error}`);
      return null;
    }
  }

  // C-4: listAccountSummaries
  async listAccountSummaries(side: Side, query?: string): Promise<AccountRow[]> {
    try {
      const accounts = await this.db.findAccounts(side, query);
      const rows: AccountRow[] = [];

      for (const account of accounts) {
        const entries = await this.db.getEntriesByAccount(account.id);
        const summary = this.calculateBalance(entries, account.side);

        rows.push({
          accountId: account.id,
          name: account.name,
          side: account.side,
          balance: summary.balance,
          summary,
          ledgerTransfer: account.ledgerTransfer,
        });
      }

      return rows;
    } catch (error) {
      console.error(`Failed to list account summaries: ${error}`);
      return [];
    }
  }

  // C-5: correctEntry
  async correctEntry(
    originalId: string,
    correctedAmount: number,
    note?: string
  ): Promise<EntryResult> {
    const errors: string[] = [];

    if (correctedAmount <= 0) {
      errors.push('المبلغ يجب أن يكون أكبر من صفر');
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    try {
      // Verify original entry exists
      const allEntries = await this.db.getAllEntries();
      const original = allEntries.find((e) => e.id === originalId);
      if (!original) {
        return { ok: false, errors: ['العملية الأصلية غير موجودة'] };
      }

      const id = this.generateUUID();
      const correctionEntry: Entry = {
        id,
        type: original.type,
        accountId: original.accountId,
        amount: correctedAmount,
        ts: new Date().toISOString(),
        note: note || `تصحيح: ${original.note || ''}`,
        linkedTo: originalId,
      };

      await this.db.appendEntry(correctionEntry);
      return { ok: true, entry: correctionEntry };
    } catch (error) {
      return { ok: false, errors: [`Failed to correct entry: ${error}`] };
    }
  }

  // C-6: markAccountMigrated
  async markAccountMigrated(accountId: string): Promise<AccountResult> {
    try {
      const account = await this.db.getAccount(accountId);
      if (!account) {
        return { ok: false, errors: ['الحساب غير موجود'] };
      }

      const updated = { ...account, ledgerTransfer: 'completed' as const };
      await this.db.updateAccount(updated);
      return { ok: true, account: updated };
    } catch (error) {
      return { ok: false, errors: [`Failed to mark account migrated: ${error}`] };
    }
  }

  // C-7: getDayLog
  async getDayLog(date: string): Promise<DayLogRow[]> {
    try {
      const entries = await this.db.getEntriesByDay(date);
      const accountMap = new Map<string, Account>();

      for (const entry of entries) {
        if (entry.accountId && !accountMap.has(entry.accountId)) {
          const account = await this.db.getAccount(entry.accountId);
          if (account) {
            accountMap.set(entry.accountId, account);
          }
        }
      }

      return entries
        .filter((e) => !e.linkedTo) // Exclude corrected entries
        .map((entry) => {
          let label = this.getEntryTypeLabel(entry.type);
          if (entry.accountId) {
            const account = accountMap.get(entry.accountId);
            if (account) {
              label += ` — ${account.name}`;
            }
          }

          return {
            entryId: entry.id,
            ts: entry.ts,
            type: entry.type,
            label,
            amount: entry.amount,
            accountId: entry.accountId,
          };
        });
    } catch (error) {
      console.error(`Failed to get day log: ${error}`);
      return [];
    }
  }

  // Helper: Calculate balance from entries
  private calculateBalance(entries: Entry[], side: Side): DerivedBalance {
    let totalDebt = 0;
    let totalPaid = 0;

    for (const entry of entries) {
      // Skip corrected entries (those with linkedTo reference newer entries)
      if (entry.linkedTo) {
        continue;
      }

      switch (entry.type) {
        case 'debt_client':
          if (side === 'client') totalDebt += entry.amount;
          break;
        case 'debt_supplier':
          if (side === 'supplier') totalDebt += entry.amount;
          break;
        case 'payment_from_client':
          if (side === 'client') totalPaid += entry.amount;
          break;
        case 'payment_to_supplier':
          if (side === 'supplier') totalPaid += entry.amount;
          break;
        case 'opening':
          totalDebt += entry.amount;
          break;
      }
    }

    return {
      totalDebt,
      totalPaid,
      balance: totalDebt - totalPaid,
    };
  }

  // Validation helper
  private validateEntry(entry: NewEntry): string[] {
    const errors: string[] = [];

    // Validate type
    const validTypes: EntryType[] = [
      'debt_client',
      'debt_supplier',
      'payment_from_client',
      'payment_to_supplier',
      'cash_sale',
      'opening',
    ];
    if (!validTypes.includes(entry.type)) {
      errors.push('نوع القيد مطلوب');
    }

    // Validate accountId requirement
    if (
      entry.type !== 'cash_sale' &&
      (!entry.accountId || entry.accountId.trim().length === 0)
    ) {
      errors.push('حساب الطرف مطلوب');
    }

    // Validate amount
    if (!entry.amount || entry.amount <= 0) {
      errors.push('المبلغ يجب أن يكون أكبر من صفر');
    }

    return errors;
  }

  private getEntryTypeLabel(type: EntryType): string {
    const labels: Record<EntryType, string> = {
      debt_client: 'دَين عميل',
      debt_supplier: 'شراء بأجل',
      payment_from_client: 'تسديد من عميل',
      payment_to_supplier: 'تسديد لمورد',
      cash_sale: 'بيع نقدي',
      opening: 'قيد افتتاحي',
    };
    return labels[type];
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async clear(): Promise<void> {
    await this.db.clear();
  }
}
