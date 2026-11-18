import {
  AccountRow,
  Side,
  SortField,
  SortOrder,
  AccountsListResult,
} from './types';
import { LedgerStore } from './ledger-store';

/**
 * [base-T4] AccountsDashboard: Accounts list with search, filtering, and sorting
 * Provides a complete interface for viewing and managing accounts with:
 * - Name search
 * - Filtering by direction (client/supplier)
 * - Sorting by name, balance, or totalDebt
 * - Built on side index for performance with ~270 accounts (SC-3)
 */
export class AccountsDashboard {
  private ledgerStore: LedgerStore;
  private currentSide: Side = 'client';
  private searchQuery: string = '';
  private sortField: SortField = 'name';
  private sortOrder: SortOrder = 'asc';

  constructor(ledgerStore: LedgerStore) {
    this.ledgerStore = ledgerStore;
  }

  /**
   * Get filtered and sorted accounts list
   * Used by UI components to render the accounts list
   */
  async getAccountsList(): Promise<AccountsListResult> {
    return this.ledgerStore.getAccountsList(
      this.currentSide,
      this.searchQuery || undefined,
      {
        field: this.sortField,
        order: this.sortOrder,
      }
    );
  }

  /**
   * Update current side filter (client/supplier)
   * Corresponds to UI toggle: "ما لي" (client) / "ما عليّ" (supplier)
   */
  setSide(side: Side): void {
    this.currentSide = side;
  }

  /**
   * Update search query
   * Filters accounts by name match (case-insensitive, Arabic-aware)
   */
  setSearchQuery(query: string): void {
    this.searchQuery = query.trim();
  }

  /**
   * Update sort settings
   * Supports sorting by: name (default), balance, or totalDebt
   * Order: asc (ascending, default) or desc (descending)
   */
  setSortBy(field: SortField, order?: SortOrder): void {
    this.sortField = field;
    this.sortOrder = order || 'asc';
  }

  /**
   * Get current filter settings
   * Used for UI state management
   */
  getFilterState() {
    return {
      side: this.currentSide,
      query: this.searchQuery,
      sortField: this.sortField,
      sortOrder: this.sortOrder,
    };
  }

  /**
   * Reset all filters to defaults
   */
  resetFilters(): void {
    this.currentSide = 'client';
    this.searchQuery = '';
    this.sortField = 'name';
    this.sortOrder = 'asc';
  }

  /**
   * Get available sort options
   * Used for populating sort UI controls
   */
  getAvailableSortFields(): Array<{ id: SortField; label: string }> {
    return [
      { id: 'name', label: 'الاسم' },
      { id: 'balance', label: 'الرصيد' },
      { id: 'totalDebt', label: 'الديون' },
    ];
  }

  /**
   * Get available side filters
   * Used for populating filter UI controls
   */
  getAvailableSides(): Array<{ id: Side; label: string }> {
    return [
      { id: 'client', label: 'ما لي (عملاء)' },
      { id: 'supplier', label: 'ما عليّ (مورّدين)' },
    ];
  }

  /**
   * Get detailed account for view/edit operations
   * Returns full AccountSummary with entries history
   */
  async getAccountDetails(accountId: string) {
    return this.ledgerStore.getAccountSummary(accountId);
  }

  /**
   * Create new account
   * Validates name uniqueness within side
   */
  async createAccount(name: string, side: Side) {
    return this.ledgerStore.findOrCreateAccount(name, side);
  }

  /**
   * Mark account as fully migrated from paper ledger
   */
  async completeAccountMigration(accountId: string) {
    return this.ledgerStore.markAccountMigrated(accountId);
  }
}

/**
 * UI Helper: Format account display row for rendering
 */
export function formatAccountRow(row: AccountRow, locale: string = 'ar-SA'): {
  accountId: string;
  name: string;
  side: string;
  balance: string;
  displayClass: string;
  details: string;
} {
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const sideLabel = row.side === 'client' ? 'عميل' : 'مورّد';
  const balanceColor = row.balance > 0 ? 'positive' : row.balance < 0 ? 'negative' : 'neutral';
  const balanceDisplay = formatter.format(Math.abs(row.balance));

  return {
    accountId: row.accountId,
    name: row.name,
    side: sideLabel,
    balance: balanceDisplay,
    displayClass: `balance-${balanceColor}`,
    details: `${row.summary.totalDebt} دين، ${row.summary.totalPaid} تسديد`,
  };
}

/**
 * UI Helper: Get readable status for account migration
 */
export function getAccountStatusLabel(status: 'open' | 'completed'): string {
  return status === 'completed' ? 'انتهى نقل' : 'قيد النقل';
}
