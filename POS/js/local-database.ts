import { Account, Entry, MetaData } from './types';

const DB_NAME = 'POS-Ledger';
const DB_VERSION = 1;
const STORES = {
  ENTRIES: 'entries',
  ACCOUNTS: 'accounts',
  META: 'meta',
};

export class LocalDatabase {
  private db: IDBDatabase | null = null;

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORES.ENTRIES)) {
          const entriesStore = db.createObjectStore(STORES.ENTRIES, { keyPath: 'id' });
          entriesStore.createIndex('ts', 'ts', { unique: false });
          entriesStore.createIndex('accountId', 'accountId', { unique: false });
          entriesStore.createIndex('type', 'type', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.ACCOUNTS)) {
          const accountsStore = db.createObjectStore(STORES.ACCOUNTS, { keyPath: 'id' });
          accountsStore.createIndex('side', 'side', { unique: false });
          accountsStore.createIndex('side_name', ['side', 'name'], { unique: true });
        }

        if (!db.objectStoreNames.contains(STORES.META)) {
          db.createObjectStore(STORES.META, { keyPath: 'key' });
        }
      };
    });
  }

  private getStore(name: string, mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const transaction = this.db.transaction(name, mode);
    return transaction.objectStore(name);
  }

  async appendEntry(entry: Entry): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ENTRIES, 'readwrite');
      const request = store.add(entry);

      request.onerror = () => {
        reject(new Error(`Failed to append entry: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async findOrCreateAccount(name: string, side: 'client' | 'supplier'): Promise<Account | null> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ACCOUNTS, 'readonly');
      const index = store.index('side_name');
      const request = index.get([side, name]);

      request.onerror = () => {
        reject(new Error(`Failed to find account: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve(request.result || null);
      };
    });
  }

  async createAccount(account: Account): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ACCOUNTS, 'readwrite');
      const request = store.add(account);

      request.onerror = () => {
        reject(new Error(`Failed to create account: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async updateAccount(account: Account): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ACCOUNTS, 'readwrite');
      const request = store.put(account);

      request.onerror = () => {
        reject(new Error(`Failed to update account: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async getEntriesByAccount(accountId: string): Promise<Entry[]> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ENTRIES, 'readonly');
      const index = store.index('accountId');
      const request = index.getAll(accountId);

      request.onerror = () => {
        reject(new Error(`Failed to get entries by account: ${request.error}`));
      };

      request.onsuccess = () => {
        const entries = request.result || [];
        entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        resolve(entries);
      };
    });
  }

  async getEntriesByDay(date: string): Promise<Entry[]> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ENTRIES, 'readonly');
      const index = store.index('ts');

      const dayStart = `${date}T00:00:00`;
      const dayEnd = `${date}T23:59:59`;

      const range = IDBKeyRange.bound(dayStart, dayEnd, false, false);
      const request = index.getAll(range);

      request.onerror = () => {
        reject(new Error(`Failed to get entries by day: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve(request.result || []);
      };
    });
  }

  async findAccounts(side: 'client' | 'supplier', query?: string): Promise<Account[]> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ACCOUNTS, 'readonly');
      const index = store.index('side');
      const request = index.getAll(side);

      request.onerror = () => {
        reject(new Error(`Failed to find accounts: ${request.error}`));
      };

      request.onsuccess = () => {
        let accounts = request.result || [];
        if (query) {
          const lowerQuery = query.toLowerCase();
          accounts = accounts.filter((acc) => acc.name.toLowerCase().includes(lowerQuery));
        }
        accounts.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
        resolve(accounts);
      };
    });
  }

  async getAccount(accountId: string): Promise<Account | null> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ACCOUNTS, 'readonly');
      const request = store.get(accountId);

      request.onerror = () => {
        reject(new Error(`Failed to get account: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve(request.result || null);
      };
    });
  }

  async getAllEntries(): Promise<Entry[]> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ENTRIES, 'readonly');
      const request = store.getAll();

      request.onerror = () => {
        reject(new Error(`Failed to get all entries: ${request.error}`));
      };

      request.onsuccess = () => {
        const entries = request.result || [];
        entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        resolve(entries);
      };
    });
  }

  async getAllAccounts(): Promise<Account[]> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ACCOUNTS, 'readonly');
      const request = store.getAll();

      request.onerror = () => {
        reject(new Error(`Failed to get all accounts: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve(request.result || []);
      };
    });
  }

  async getMetaData(): Promise<MetaData | null> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.META, 'readonly');
      const request = store.get('schema');

      request.onerror = () => {
        reject(new Error(`Failed to get metadata: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve(request.result || null);
      };
    });
  }

  async setMetaData(meta: MetaData): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.META, 'readwrite');
      const request = store.put({ key: 'schema', ...meta });

      request.onerror = () => {
        reject(new Error(`Failed to set metadata: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      const transaction = this.db.transaction(
        [STORES.ENTRIES, STORES.ACCOUNTS, STORES.META],
        'readwrite'
      );

      const entriesStore = transaction.objectStore(STORES.ENTRIES);
      const accountsStore = transaction.objectStore(STORES.ACCOUNTS);
      const metaStore = transaction.objectStore(STORES.META);

      entriesStore.clear();
      accountsStore.clear();
      metaStore.clear();

      transaction.onerror = () => {
        reject(new Error(`Failed to clear database: ${transaction.error}`));
      };

      transaction.oncomplete = () => {
        resolve();
      };
    });
  }
}
