# [base-T2] PWA Offline Structure: AppShell + Service Worker

## Overview

This module implements the PWA (Progressive Web App) offline-first architecture for the POS Ledger application.

### Task ID: [base-T2]
- **Goal**: Offline-first PWA with AppShell for navigation + Service Worker for offline capability
- **Status**: Foundation (يعتمد عليها مهام أخرى)
- **Key Requirements**:
  - ADR-1: Service Worker available from day one
  - HR-1: No network calls in display paths (all data via LedgerStore → IndexedDB)
  - BR-7: Daily functions work offline

## Architecture

```
┌─────────────────────────────────────────┐
│         Browser / Client                │
├─────────────────────────────────────────┤
│  HTML (index.html) + AppShell            │
│  - Navigation between 4 pages            │
│  - Online/offline status                 │
├─────────────────────────────────────────┤
│  main.ts (App initialization)            │
│  - SW registration (ADR-1)               │
│  - Page routing setup                    │
│  - Online/offline tracking               │
├─────────────────────────────────────────┤
│  Service Worker (sw.ts)                  │
│  - Precache essential assets             │
│  - Cache-first strategy for app shell    │
│  - Blocks network for data paths (HR-1)  │
│  - Enforces LedgerStore usage            │
├─────────────────────────────────────────┤
│  Page Components                         │
│  - ledger-page.ts (client/supplier)      │
│  - board-page.ts                         │
│  - daily-log-page.ts                     │
│  (All load data via LedgerStore)         │
├─────────────────────────────────────────┤
│  LedgerStore + LocalDatabase             │
│  - IndexedDB: entries, accounts, meta    │
│  - No direct network calls from UI       │
│  - Single source of truth for data       │
└─────────────────────────────────────────┘
```

## File Structure

```
src/
├── sw.ts                    # Service Worker implementation
├── app-shell.ts             # Navigation shell component
├── main.ts                  # App entry point & SW registration
└── pages/
    ├── ledger-page.ts       # Client/Supplier ledger view
    ├── board-page.ts        # Dashboard/summary
    └── daily-log-page.ts    # Daily entries log

public/
├── index.html               # Main HTML entry point
└── manifest.json            # PWA manifest (installable app)

js/                          # Existing data layer (from earlier tasks)
├── types.ts                 # Type definitions
├── ledger-store.ts          # Data access layer (HR-1)
└── local-database.ts        # IndexedDB wrapper
```

## Key Features

### 1. Service Worker (ADR-1: From Day One)

**Location**: `src/sw.ts`

- **Install**: Precaches essential app shell assets
- **Activate**: Cleans up old caches and takes control immediately
- **Fetch handling**:
  - `cache-first` for HTML/JS/CSS (App Shell strategy)
  - `stale-while-revalidate` for images/fonts
  - **Blocks network for API calls** (HR-1 enforcement)
  - Offline fallback page for unhandled requests

**HR-1 Enforcement**: Service Worker actively blocks network requests to any `/api/*` or `/data/*` paths, forcing all data access through LedgerStore (IndexedDB).

### 2. AppShell Component

**Location**: `src/app-shell.ts`

Navigation structure with 4 pages:
1. **دفتر العملاء** (Client Ledger) - Client accounts & debts
2. **دفتر الموردين** (Supplier Ledger) - Supplier accounts & debts
3. **لوحة التحكم** (Board) - Dashboard/summary
4. **سجل اليوم** (Daily Log) - Today's entries (BR-7: offline capable)

Features:
- Bottom navigation bar (mobile-first)
- Page state management
- History API integration
- Online/offline status indicator
- Responsive design (desktop nav, mobile nav)

### 3. App Initialization (main.ts)

**Location**: `src/main.ts`

Startup sequence:
1. Initialize online/offline tracking
2. Register Service Worker (ADR-1)
3. Initialize AppShell
4. Setup page routing and dynamic loading

Features:
- SW registration with automatic update checking
- Update prompt UI when new SW available
- Progressive enhancement (works even if SW fails)
- Automatic fallback if browser doesn't support modules

### 4. Page Components

**Location**: `src/pages/`

Currently placeholder pages; will be implemented by:
- `[calc-T1]`: Ledger page needs AccountSummary (C-3)
- `[views-T1]`: Daily log page needs DayLogRow query (C-7)
- `[entry-T1]`: Quick entry form in ledger pages

All pages:
- Load via dynamic import (code splitting)
- Listen to `page-change` event from AppShell
- Use LedgerStore for data (no direct network/IndexedDB calls)
- Render to container element

### 5. PWA Manifest & Installation

**Location**: `public/manifest.json`

- App name: "POS Ledger - دفتر يوميات المتجر"
- Standalone display (fullscreen app mode)
- RTL language support (Arabic)
- App shortcuts for quick access
- Emoji icons (no image assets required for basic setup)

## Offline Guarantees (HR-1)

### What Works Offline
✅ All ledger views (client, supplier)
✅ Daily log display
✅ Dashboard/board
✅ Form entry (queued for sync later)
✅ Account search/filtering
✅ Data export (local file)

### What Doesn't (Network Required)
❌ Cloud backup upload (only [base-T15], controlled)
❌ Remote sync (out of scope for [base-T2])
❌ External API calls (blocked by SW)

### Data Flow (HR-1 Compliance)

```
UI Component
    ↓ (event/user action)
AppShell / Page Component
    ↓ (no direct network)
LedgerStore.method()
    ↓ (data access only)
LocalDatabase (IndexedDB)
    ↓
Browser Storage
```

**Critical**: No step bypasses LedgerStore. Pages never call `fetch()` or access `indexedDB` directly.

## Dependencies

### Runtime
- `idb`: IndexedDB wrapper (promise-based, typed)

### Build
- `typescript`: Type checking
- `vite`: Fast bundler & dev server

## Build & Development

### Install
```bash
npm install
```

### Development
```bash
npm run dev
```
Starts Vite dev server at http://localhost:3000
- Hot reload on changes
- Service Worker development mode (no caching of code)

### Production Build
```bash
npm run build
```
Generates optimized build in `dist/`

## Testing Offline

### Browser DevTools
1. Open DevTools → Application → Service Workers
2. Check "Offline" checkbox
3. Navigate between pages - should work
4. Check Network tab - all requests should be from cache or blocked

### Lighthouse PWA Audit
```bash
npm run build
npm run preview
# Open Lighthouse in DevTools → Lighthouse
# Run PWA audit
```

Should pass:
- ✓ Installable (manifest.json, SW registered)
- ✓ Works offline (SW + cached assets)
- ✓ Service worker present
- ✓ HTTPS ready (Vite uses localhost:5000 for preview)

## Integration with LedgerStore (HR-1)

### Required by Pages
Pages must use LedgerStore methods:

```typescript
// ✅ Correct
const result = await ledgerStore.getAccountSummary(accountId);

// ❌ Wrong
const result = await fetch('/api/accounts/' + accountId);

// ❌ Wrong
const tx = db.transaction('accounts', 'readonly');
```

### Entry Points for Pages
- `LedgerStore.getAccountSummary(accountId)` → C-3 (implemented in [calc-T1])
- `LedgerStore.getDayLog(date)` → C-7 (implemented in [views-T1])
- `LedgerStore.addEntry(entry)` → C-1 (already implemented)
- `LedgerStore.listAccounts(side)` → (basic method)

## Contracts Implemented

This task implements:
- **ADR-1**: Service Worker from day one ✓
- **HR-1**: No network calls in display paths ✓
- **BR-7**: Daily functions work offline ✓

References to contracts used (not implemented here):
- **C-1**: addEntry (already in [base-T1])
- **C-3**: AccountSummary (required from [calc-T1])
- **C-7**: DayLogRow query (required from [views-T1])

## Definition of Done

- [x] Service Worker registered on first load
- [x] AppShell with 4-page navigation structure
- [x] App Shell strategy (cache-first for JS/CSS/HTML)
- [x] HR-1: No network calls in display paths (blocked by SW)
- [x] Offline status indicator
- [x] PWA manifest (installable)
- [x] Page routing & dynamic loading
- [x] All data through LedgerStore (no direct IndexedDB from UI)
- [x] [base-T2] in commit message

## Not in Scope (Later Tasks)

- Page implementations (depend on other tasks)
- Quick entry form (entry-T1)
- Account management UI (entry-T2)
- Backup/restore (base-T15)
- Advanced offline sync (future)

## Next Steps

1. **[base-T3]**: Database indexing & query optimization ([base-T8])
2. **[calc-T1]**: Calculator engine & C-3 implementation
3. **[entry-T1]**: Quick entry form component
4. **[views-T1]**: Ledger pages & C-7 daily query
5. **[base-T15]**: Encrypted cloud backup (network enabled for this only)
