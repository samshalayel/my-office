// Board page component - displays dashboard/summary
// [base-T2] AppShell page
// HR-1: All data through LedgerStore

export async function renderPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="board-page" dir="rtl">
      <header class="board-page__header">
        <h1>📊 لوحة التحكم</h1>
      </header>

      <div class="board-page__content">
        <div class="placeholder" style="
          padding: 40px;
          text-align: center;
          color: #999;
        ">
          <p>هذه الصفحة قيد التطوير</p>
          <p style="font-size: 12px; margin-top: 10px;">
            ستعرض ملخص الأرصدة والإحصائيات
          </p>
        </div>
      </div>

      <style>
        .board-page {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .board-page__header {
          background: white;
          padding: 20px;
          border-radius: 4px;
          border-bottom: 2px solid #1976d2;
        }

        .board-page__header h1 {
          margin: 0;
          font-size: 24px;
          color: #333;
        }

        .board-page__content {
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
