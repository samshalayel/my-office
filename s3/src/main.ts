// Main application entry point for POS Ledger PWA
// [base-T2] Service Worker registration and app initialization
// ADR-1: Service Worker registered on first load
// HR-1: All data through LedgerStore (IndexedDB), no direct network access

import { AppShell } from './app-shell';

class POSLedgerApp {
  private appShell: AppShell | null = null;
  private swRegistration: ServiceWorkerRegistration | null = null;

  async initialize(): Promise<void> {
    console.log('[App] Initializing POS Ledger...');

    // Setup online/offline tracking (HR-1: display-aware but no direct network calls)
    this.setupOnlineTracking();

    // Register service worker (ADR-1: from day one)
    await this.registerServiceWorker();

    // Initialize app shell (navigation structure)
    this.appShell = new AppShell('app');
    await this.appShell.initialize();

    // Setup page routing and loader
    this.setupPageRouting();

    console.log('[App] Initialization complete');
  }

  /**
   * Register Service Worker for offline capability
   * ADR-1: Service Worker must be available from first launch
   */
  private async registerServiceWorker(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      console.warn('[App] Service Workers not supported in this browser');
      return;
    }

    try {
      console.log('[App] Registering service worker...');

      // The service worker file should be in public/ directory
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        // updateViaCache: 'none', // Always check for SW updates
      });

      this.swRegistration = registration;
      console.log('[App] Service Worker registered:', registration.scope);

      // Listen for updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[App] Service Worker updated, showing reload prompt');
              this.showUpdatePrompt();
            }
          });
        }
      });

      // Check for updates periodically (if SW available for checking)
      setInterval(() => {
        registration.update();
      }, 60000); // Check every minute

      return;
    } catch (error) {
      console.error('[App] Service Worker registration failed:', error);
      // Don't fail app startup if SW registration fails - app works with IndexedDB
      // but won't have offline capability
    }
  }

  /**
   * Track online/offline status
   * HR-1: Display only - doesn't trigger network calls
   */
  private setupOnlineTracking(): void {
    const updateStatus = () => {
      const isOnline = navigator.onLine;
      if (this.appShell) {
        this.appShell.updateOnlineStatus(isOnline);
      }
    };

    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);

    // Initial status
    updateStatus();
  }

  /**
   * Setup page routing and dynamic page loading
   * Pages listen to 'page-change' event and load their own content
   */
  private setupPageRouting(): void {
    window.addEventListener('page-change', async (e: Event) => {
      const event = e as CustomEvent;
      const { pageId } = event.detail;

      try {
        // Dynamic import of page component
        const pageModule = await this.loadPageModule(pageId);
        if (pageModule && pageModule.renderPage) {
          const pageContainer = document.getElementById('page-container');
          if (pageContainer) {
            // Clear loading state and render page
            pageContainer.innerHTML = '';
            await pageModule.renderPage(pageContainer);
          }
        }
      } catch (error) {
        console.error('[App] Failed to load page:', pageId, error);
        const pageContainer = document.getElementById('page-container');
        if (pageContainer) {
          pageContainer.innerHTML = `<div class="error">خطأ في تحميل الصفحة</div>`;
        }
      }
    });
  }

  /**
   * Dynamically load page module based on pageId
   * HR-1: Modules should use LedgerStore for all data access
   */
  private async loadPageModule(pageId: string): Promise<any> {
    // Map page IDs to module paths
    const pageModules: Record<string, string> = {
      client_ledger: './pages/ledger-page.ts',
      supplier_ledger: './pages/ledger-page.ts',
      board: './pages/board-page.ts',
      daily_log: './pages/daily-log-page.ts',
    };

    const modulePath = pageModules[pageId];
    if (!modulePath) {
      throw new Error(`No module found for page: ${pageId}`);
    }

    // In development, use import(); in production, this is handled by bundler
    // For now, return dynamic import
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return await import(modulePath);
    } catch (error) {
      console.warn('[App] Dynamic import failed, module may not be implemented yet');
      return {
        renderPage: async (container: HTMLElement) => {
          container.innerHTML = `
            <div style="padding: 16px; text-align: center;" dir="rtl">
              <h2>${pageId}</h2>
              <p>هذه الصفحة قيد التطوير</p>
            </div>
          `;
        },
      };
    }
  }

  /**
   * Show update prompt when SW is updated
   */
  private showUpdatePrompt(): void {
    const container = document.createElement('div');
    container.innerHTML = `
      <div style="
        position: fixed;
        bottom: 20px;
        left: 20px;
        background: #1976d2;
        color: white;
        padding: 16px;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        z-index: 9999;
        max-width: 300px;
        direction: rtl;
      ">
        <p style="margin: 0 0 12px 0; font-size: 14px;">تحديث جديد متاح</p>
        <div style="display: flex; gap: 8px;">
          <button id="reload-btn" style="
            flex: 1;
            padding: 8px;
            background: white;
            color: #1976d2;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
          ">تحديث الآن</button>
          <button id="dismiss-btn" style="
            flex: 1;
            padding: 8px;
            background: transparent;
            color: white;
            border: 1px solid white;
            border-radius: 4px;
            cursor: pointer;
          ">إغلاق</button>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    const reloadBtn = container.querySelector('#reload-btn') as HTMLButtonElement;
    const dismissBtn = container.querySelector('#dismiss-btn') as HTMLButtonElement;

    reloadBtn?.addEventListener('click', () => {
      window.location.reload();
    });

    dismissBtn?.addEventListener('click', () => {
      container.remove();
    });

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
      container.remove();
    }, 10000);
  }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const app = new POSLedgerApp();
    app.initialize();
  });
} else {
  // DOM already loaded (e.g., async script tag with defer)
  const app = new POSLedgerApp();
  app.initialize();
}

export { POSLedgerApp };
