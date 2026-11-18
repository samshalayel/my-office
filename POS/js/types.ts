export type Side = 'client' | 'supplier';

export type EntryType =
  | 'debt_client'
  | 'debt_supplier'
  | 'payment_from_client'
  | 'payment_to_supplier'
  | 'cash_sale'
  | 'opening';

export interface Account {
  id: string;
  name: string;
  side: Side;
  ledgerTransfer: 'open' | 'completed';
  createdAt: string;
}

export interface Entry {
  id: string;
  type: EntryType;
  accountId?: string;
  amount: number;
  ts: string;
  note?: string;
  linkedTo?: string;
}

export interface DerivedBalance {
  totalDebt: number;
  totalPaid: number;
  balance: number;
}

export interface AccountSummary {
  account: Account;
  summary: DerivedBalance;
  entries: Entry[];
}

export interface AccountRow {
  accountId: string;
  name: string;
  side: Side;
  balance: number;
  summary: DerivedBalance;
  ledgerTransfer: 'open' | 'completed';
}

export interface DayLogRow {
  entryId: string;
  ts: string;
  type: EntryType;
  label: string;
  amount: number;
  accountId?: string;
}

export interface NewEntry {
  type: EntryType;
  accountId?: string;
  amount: number;
  ts?: string;
  note?: string;
  linkedTo?: string;
}

export interface EntryResult {
  ok: boolean;
  entry?: Entry;
  errors?: string[];
}

export interface AccountResult {
  ok: boolean;
  account?: Account;
  errors?: string[];
}

export interface MetaData {
  schemaVersion: number;
  lastInitialized?: string;
}

// [base-T4] Sorting support for accounts list
export type SortField = 'name' | 'balance' | 'totalDebt';
export type SortOrder = 'asc' | 'desc';

export interface SortOptions {
  field?: SortField;
  order?: SortOrder;
}

export interface AccountsListResult {
  accounts: AccountRow[];
  totalCount: number;
  query?: string;
  side?: Side;
}
