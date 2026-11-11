// AppShell component: Main navigation shell for POS Ledger
// [base-T2] Offline-first architecture
// Navigation: two books (client ledger, supplier ledger) + board + daily log

export interface PageConfig {
  id: string;
  titleAr: string;
  titleEn: string;
  icon: string;
  path: string;
}

export const PAGES: Record<string, PageConfig> = {
  client_ledger: {
    id: 'client_ledger',
    titleAr: 'دفتر العملاء',
    titleEn: 'Client Ledger',
    icon: '👥',
    path: '/ledger/client',
  },
  supplier_ledger: {
    id: 'supplier_ledger',
    titleAr: 'دفتر الموردين',
    titleEn: 'Supplier Ledger',
    icon: '🏢',
    path: '/ledger/supplier',
  },
  board: {
    id: 'board',
    titleAr: 'لوحة التحكم',
    titleEn: 'Board',
    icon: '📊',
    path: '/board',
  },
  daily_log: {
    id: 'daily_log',
    titleAr: 'سجل اليوم',
    titleEn: 'Daily Log',
    icon: '📅',
    path: '/daily-log',
  },
};

export class AppShell {
  private container: HTMLElement;
  private currentPage: string = 'client_ledger';

  constructor(containerId: string = 'app') {
    const el = document.getElementById(containerId);
    if (!el) {
      throw new Error(`Container element with id "${containerId}" not found`);
    }
    this.container = el;
  }

  /**
   * Initialize the app shell with navigation and route handling
   * HR-1: All data loading happens through LedgerStore (no direct network calls)
   */
  async initialize(): Promise<void> {
    this.render();
    this.setupNavigation();
    this.setupRouting();
    // Initial page load
    await this.navigateToPage('client_ledger');
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="app-shell">
        <nav class="app-shell__nav" role="navigation" aria-label="Main navigation">
          <ul class="app-shell__nav-list" dir="rtl">
            ${Object.values(PAGES)
              .map(
                (page) =>
                  `<li class="app-shell__nav-item">
                    <button
                      class="app-shell__nav-button"
                      data-page-id="${page.id}"
                      aria-current="false"
                      title="${page.titleEn} • ${page.titleAr}"
                    >
                      <span class="app-shell__nav-icon">${page.icon}</span>
                      <span class="app-shell__nav-text">${page.titleAr}</span>
                    </button>
                  </li>`
              )
              .join('')}
          </ul>
        </nav>

        <main class="app-shell__content" role="main">
          <div id="page-container" class="page-container">
            <!-- Page content loaded here -->
          </div>
        </main>

        <footer class="app-shell__footer" role="contentinfo" dir="rtl">
          <span class="app-shell__status" id="offline-status">
            <!-- Online/offline status -->
          </span>
        </footer>
      </div>

      <style>
        .app-shell {
          display: flex;
          flex-direction: column;
          height: 100vh;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          background-color: #f5f5f5;
        }

        .app-shell__nav {
          background-color: #fff;
          border-bottom: 1px solid #e0e0e0;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          padding: 0;
        }

        .app-shell__nav-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          gap: 0;
          flex-direction: row-reverse;
        }

        .app-shell__nav-item {
          flex: 1;
          min-width: 0;
        }

        .app-shell__nav-button {
          width: 100%;
          padding: 12px 8px;
          border: none;
          background: transparent;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          color: #666;
          font-size: 12px;
          transition: all 0.2s ease;
          border-bottom: 3px solid transparent;
        }

        .app-shell__nav-button:hover {
          background-color: #f5f5f5;
          color: #333;
        }

        .app-shell__nav-button[aria-current="true"] {
          color: #1976d2;
          border-bottom-color: #1976d2;
          font-weight: 600;
        }

        .app-shell__nav-icon {
          font-size: 20px;
        }

        .app-shell__nav-text {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .app-shell__content {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 16px;
        }

        .app-shell__footer {
          border-top: 1px solid #e0e0e0;
          background-color: #fff;
          padding: 12px 16px;
          font-size: 12px;
          color: #999;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .app-shell__status.offline {
          color: #f44336;
          font-weight: 600;
        }

        .app-shell__status.online {
          color: #4caf50;
        }

        .page-container {
          min-height: 100%;
        }

        /* Responsive: stack nav vertically on smaller screens */
        @media (max-width: 600px) {
          .app-shell {
            flex-direction: column-reverse;
          }

          .app-shell__nav {
            border-top: 1px solid #e0e0e0;
            border-bottom: none;
          }

          .app-shell__nav-list {
            flex-direction: row;
          }

          .app-shell__nav-button {
            padding: 8px 6px;
            font-size: 11px;
          }

          .app-shell__nav-icon {
            font-size: 18px;
          }

          .app-shell__nav-text {
            display: none;
          }
        }
      </style>
    `;
  }

  private setupNavigation(): void {
    const navButtons = this.container.querySelectorAll('.app-shell__nav-button');
    navButtons.forEach((button) => {
      button.addEventListener('click', async (e) => {
        const pageId = (e.currentTarget as HTMLElement).getAttribute('data-page-id');
        if (pageId) {
          await this.navigateToPage(pageId);
        }
      });
    });
  }

  private setupRouting(): void {
    window.addEventListener('popstate', async (e) => {
      const pageId = e.state?.pageId || 'client_ledger';
      await this.navigateToPage(pageId, false);
    });
  }

  async navigateToPage(pageId: string, pushState: boolean = true): Promise<void> {
    const page = PAGES[pageId];
    if (!page) {
      console.error(`Unknown page: ${pageId}`);
      return;
    }

    // Update current page
    this.currentPage = pageId;

    // Update nav button states
    const navButtons = this.container.querySelectorAll('.app-shell__nav-button');
    navButtons.forEach((button) => {
      const buttonPageId = button.getAttribute('data-page-id');
      button.setAttribute('aria-current', buttonPageId === pageId ? 'true' : 'false');
    });

    // Update page title
    document.title = `${page.titleAr} - POS Ledger`;

    // Push history state
    if (pushState) {
      window.history.pushState({ pageId }, page.titleAr, page.path);
    }

    // Load page content - this dispatches a custom event that pages listen to
    const pageContainer = this.container.querySelector('#page-container');
    if (pageContainer) {
      // Emit page change event - pages should listen and load their content
      const event = new CustomEvent('page-change', {
        detail: { pageId, page },
      });
      window.dispatchEvent(event);

      // Show loading state while page loads
      pageContainer.innerHTML = '<div class="page-loading">جاري التحميل...</div>';
    }
  }

  getCurrentPage(): string {
    return this.currentPage;
  }

  /**
   * Update offline/online status in footer
   * HR-1: Display component is offline-aware but doesn't trigger network calls
   */
  updateOnlineStatus(isOnline: boolean): void {
    const statusEl = this.container.querySelector('#offline-status');
    if (statusEl) {
      if (isOnline) {
        statusEl.textContent = '🟢 متصل';
        statusEl.classList.remove('offline');
        statusEl.classList.add('online');
      } else {
        statusEl.textContent = '⚫ بلا اتصال';
        statusEl.classList.remove('online');
        statusEl.classList.add('offline');
      }
    }
  }
}
