import { Account, Entry, EntryType, Side, DayLogRow, AccountRow } from './types';
import { LedgerStore } from './ledger-store';

export class CSVExporter {
  private store: LedgerStore;

  constructor(store: LedgerStore) {
    this.store = store;
  }

  private escapeCSVField(field: string | number | undefined | null): string {
    if (field === null || field === undefined) {
      return '';
    }

    const str = String(field);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  private addBOM(content: string): Uint8Array {
    const encoder = new TextEncoder();
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const encoded = encoder.encode(content);
    const result = new Uint8Array(bom.length + encoded.length);
    result.set(bom);
    result.set(encoded, bom.length);
    return result;
  }

  async exportAccountsList(side?: Side): Promise<Blob> {
    const rows = side
      ? await this.store.listAccountSummaries(side)
      : await Promise.all([
          this.store.listAccountSummaries('client'),
          this.store.listAccountSummaries('supplier'),
        ]).then((results) => [...results[0], ...results[1]]);

    const headers = ['رقم الحساب', 'اسم الحساب', 'النوع', 'الرصيد', 'إجمالي الدين', 'إجمالي المدفوع', 'حالة النقل'];
    let csv = headers.map((h) => this.escapeCSVField(h)).join(',') + '\n';

    for (const row of rows) {
      const sideLabel = row.side === 'client' ? 'عميل' : 'مورد';
      const ledgerLabel = row.ledgerTransfer === 'completed' ? 'مكتمل' : 'مفتوح';
      const line = [
        this.escapeCSVField(row.accountId),
        this.escapeCSVField(row.name),
        this.escapeCSVField(sideLabel),
        this.escapeCSVField(row.balance),
        this.escapeCSVField(row.summary.totalDebt),
        this.escapeCSVField(row.summary.totalPaid),
        this.escapeCSVField(ledgerLabel),
      ];
      csv += line.map((f) => this.escapeCSVField(f)).join(',') + '\n';
    }

    const data = this.addBOM(csv);
    return new Blob([data], { type: 'text/csv;charset=utf-8' });
  }

  async exportAccountHistory(accountId: string): Promise<Blob> {
    const summary = await this.store.getAccountSummary(accountId);
    if (!summary) {
      throw new Error('الحساب غير موجود');
    }

    const headers = ['رقم العملية', 'التاريخ والوقت', 'النوع', 'المبلغ', 'الملاحظات'];
    let csv = headers.map((h) => this.escapeCSVField(h)).join(',') + '\n';

    for (const entry of summary.entries) {
      const typeLabel = this.getEntryTypeLabel(entry.type);
      const dateStr = new Date(entry.ts).toLocaleString('ar-SA');
      const line = [
        this.escapeCSVField(entry.id),
        this.escapeCSVField(dateStr),
        this.escapeCSVField(typeLabel),
        this.escapeCSVField(entry.amount),
        this.escapeCSVField(entry.note || ''),
      ];
      csv += line.map((f) => this.escapeCSVField(f)).join(',') + '\n';
    }

    const data = this.addBOM(csv);
    return new Blob([data], { type: 'text/csv;charset=utf-8' });
  }

  async exportTodaysLog(date?: string): Promise<Blob> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const dayLog = await this.store.getDayLog(targetDate);

    const headers = ['رقم العملية', 'التاريخ والوقت', 'النوع', 'المبلغ', 'الحساب', 'الملاحظات'];
    let csv = headers.map((h) => this.escapeCSVField(h)).join(',') + '\n';

    for (const row of dayLog) {
      const dateStr = new Date(row.ts).toLocaleString('ar-SA');
      const line = [
        this.escapeCSVField(row.entryId),
        this.escapeCSVField(dateStr),
        this.escapeCSVField(row.label),
        this.escapeCSVField(row.amount),
        this.escapeCSVField(''),
        this.escapeCSVField(''),
      ];
      csv += line.map((f) => this.escapeCSVField(f)).join(',') + '\n';
    }

    const data = this.addBOM(csv);
    return new Blob([data], { type: 'text/csv;charset=utf-8' });
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
}
