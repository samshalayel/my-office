// Ledger page component - displays account ledger for client or supplier
// [base-T2] AppShell page - renders through dynamic page loading
// Depends on [calc-T1]: C-3 AccountSummary
// HR-1: All data loaded through LedgerStore (IndexedDB)

export async function renderPage(container: HTMLElement): Promise<void> {
  const side = window.location.pathname.includes('client') ? 'client' : 'supplier';

  container.innerHTML = `
    <div class="ledger-page" dir="rtl">
      <header class="ledger-page__header">
        <h1>${side === 'client' ? 'دفتر العملاء' : 'دفتر الموردين'}</h1>
      </header>

      <div class="ledger-page__content">
        <div class="placeholder" style="
          padding: 40px;
          text-align: center;
          color: #999;
        ">
          <p>هذه الصفحة قيد التطوير</p>
          <p style="font-size: 12px; margin-top: 10px;">
            تُعتمد على تنفيذ:
            <br/>[calc-T1]: محرك الاحتساب والاستعلام
            <br/>[entry-T1]: مسار كتابة العملية
          </p>
        </div>
      </div>

      <style>
        .ledger-page {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .ledger-page__header {
          background: white;
          padding: 20px;
          border-radius: 4px;
          border-bottom: 2px solid #1976d2;
        }

        .ledger-page__header h1 {
          margin: 0;
          font-size: 24px;
          color: #333;
        }

        .ledger-page__content {
          flex: 1;
          background: white;
          border-radius: 4px;
          padding: 20px;
          min-height: 300px;
        }
      </style>
    </div>
  `;
}
