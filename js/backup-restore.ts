import { LocalDatabase } from './local-database';
import { Account, Entry, MetaData } from './types';

/**
 * Complete ledger backup and restore functionality
 * Layer 1: Local JSON export/import (offline-first, device storage)
 * Layer 2: Cloud encrypted backup planned separately (base-T15)
 */
export interface LedgerBackup {
  version: string;
  exportedAt: string;
  metadata: MetaData;
  accounts: Account[];
  entries: Entry[];
}

export class BackupRestoreService {
  constructor(private db: LocalDatabase) {}

  /**
   * Export complete ledger as JSON
   * Exports all accounts, entries, and metadata in a portable format
   */
  async exportLedger(): Promise<LedgerBackup> {
    const metadata = await this.db.getMetaData();
    const accounts = await this.db.getAllAccounts();
    const entries = await this.db.getAllEntries();

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      metadata: metadata || { schemaVersion: '1.0', initializedAt: new Date().toISOString() },
      accounts,
      entries
    };
  }

  /**
   * Export ledger as JSON string (for file download)
   */
  async exportLedgerAsJson(): Promise<string> {
    const backup = await this.exportLedger();
    return JSON.stringify(backup, null, 2);
  }

  /**
   * Restore ledger from backup
   * Only accepts restoration on an empty database (prevents accidental overwrites)
   * @throws Error if database is not empty
   */
  async restoreLedger(backup: LedgerBackup): Promise<void> {
    // Validation: database must be empty
    const existingAccounts = await this.db.getAllAccounts();
    const existingEntries = await this.db.getAllEntries();

    if (existingAccounts.length > 0 || existingEntries.length > 0) {
      throw new Error(
        'Cannot restore: database is not empty. Clear all data first before restoring from backup.'
      );
    }

    // Restore metadata
    if (backup.metadata) {
      await this.db.setMetaData(backup.metadata);
    }

    // Restore accounts
    for (const account of backup.accounts) {
      await this.db.createAccount(account);
    }

    // Restore entries
    for (const entry of backup.entries) {
      await this.db.appendEntry(entry);
    }
  }

  /**
   * Restore ledger from JSON string
   */
  async restoreLedgerFromJson(jsonString: string): Promise<void> {
    try {
      const backup = JSON.parse(jsonString) as LedgerBackup;
      await this.restoreLedger(backup);
    } catch (error) {
      throw new Error(`Failed to parse backup JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if database is empty (suitable for restoration)
   */
  async isDatabaseEmpty(): Promise<boolean> {
    const accounts = await this.db.getAllAccounts();
    const entries = await this.db.getAllEntries();
    return accounts.length === 0 && entries.length === 0;
  }
}
