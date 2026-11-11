# Backup & Restore Usage Guide

## Overview

The `BackupRestoreService` provides local JSON export/import functionality for the POS ledger system. This is Layer 1 backup (offline-first, device storage).

## Installation

The service is available in `js/backup-restore.ts`:

```typescript
import { BackupRestoreService } from './backup-restore';
import { LocalDatabase } from './local-database';

// Initialize the service
const db = new LocalDatabase();
const backupService = new BackupRestoreService(db);
```

## API Reference

### Export Operations

#### `exportLedger(): Promise<LedgerBackup>`
Exports complete ledger as typed object.

**Returns:** `LedgerBackup` interface with:
- `version` - Backup format version (currently "1.0")
- `exportedAt` - ISO 8601 timestamp
- `metadata` - Schema version and initialization date
- `accounts` - Array of all Account records
- `entries` - Array of all Entry records

**Example:**
```typescript
const backup = await backupService.exportLedger();
console.log(`Exported ${backup.accounts.length} accounts and ${backup.entries.length} entries`);
console.log(`Backup version: ${backup.version}`);
console.log(`Created: ${backup.exportedAt}`);
```

#### `exportLedgerAsJson(): Promise<string>`
Exports complete ledger as formatted JSON string (for file download).

**Returns:** Formatted JSON string (2-space indentation)

**Example:**
```typescript
const jsonString = await backupService.exportLedgerAsJson();
// Save to file
const blob = new Blob([jsonString], { type: 'application/json' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `ledger-backup-${new Date().toISOString().split('T')[0]}.json`;
a.click();
```

### Restore Operations

#### `restoreLedger(backup: LedgerBackup): Promise<void>`
Restores ledger from backup object.

**Parameters:**
- `backup` - LedgerBackup object from prior export

**Throws:** `Error` if database is not empty

**Example:**
```typescript
try {
  await backupService.restoreLedger(backupData);
  console.log('Restore completed successfully');
} catch (error) {
  if (error.message.includes('not empty')) {
    console.log('Database has existing data. Clear first.');
  }
}
```

#### `restoreLedgerFromJson(jsonString: string): Promise<void>`
Restores ledger from JSON string (parses and restores).

**Parameters:**
- `jsonString` - JSON string from file upload or previous export

**Throws:** 
- `Error` if JSON is invalid
- `Error` if database is not empty

**Example:**
```typescript
// Read from file input
const fileInput = document.querySelector('input[type="file"]');
const file = fileInput.files[0];
const jsonString = await file.text();

try {
  await backupService.restoreLedgerFromJson(jsonString);
  console.log('Restore completed');
} catch (error) {
  console.error('Restore failed:', error.message);
}
```

### Validation

#### `isDatabaseEmpty(): Promise<boolean>`
Checks if database is suitable for restoration.

**Returns:** `true` if both accounts and entries are empty

**Example:**
```typescript
const isEmpty = await backupService.isDatabaseEmpty();
if (isEmpty) {
  console.log('Database is ready for restore');
} else {
  console.log('Clear all data before restoring');
}
```

## Backup Format (JSON Structure)

```json
{
  "version": "1.0",
  "exportedAt": "2026-11-11T12:00:00.000Z",
  "metadata": {
    "schemaVersion": "1.0",
    "initializedAt": "2026-11-01T00:00:00.000Z"
  },
  "accounts": [
    {
      "id": "acc_123",
      "name": "أحمد محمد",
      "side": "client",
      "transferred": false,
      "createdAt": "2026-11-01T10:00:00.000Z"
    }
  ],
  "entries": [
    {
      "id": "entry_456",
      "type": "clientDebt",
      "accountId": "acc_123",
      "amount": 1000,
      "timestamp": "2026-11-01T14:30:00.000Z",
      "notes": "Invoice #001"
    }
  ]
}
```

## Restore Workflow

### Safe Restore Procedure

1. **Verify empty database**
   ```typescript
   const canRestore = await backupService.isDatabaseEmpty();
   if (!canRestore) {
     // Prompt user: "Clear all data first?"
     await db.clear();
   }
   ```

2. **Load backup file**
   ```typescript
   const jsonString = await uploadedFile.text();
   ```

3. **Restore**
   ```typescript
   try {
     await backupService.restoreLedgerFromJson(jsonString);
     // Success: database now contains backup data
   } catch (error) {
     // Handle error: invalid JSON or other issues
   }
   ```

## Error Handling

### Database Not Empty

```typescript
try {
  await backupService.restoreLedger(backup);
} catch (error) {
  if (error.message.includes('not empty')) {
    // Show user confirmation dialog
    if (confirm('Clear existing data and restore from backup?')) {
      await db.clear();
      await backupService.restoreLedger(backup);
    }
  }
}
```

### Invalid JSON

```typescript
try {
  await backupService.restoreLedgerFromJson(jsonString);
} catch (error) {
  if (error.message.includes('parse')) {
    console.error('Invalid backup file format');
  }
}
```

## Performance Considerations

- **Export:** O(n) where n = total number of entries + accounts
- **Restore:** O(n) with sequential database writes
- Large ledgers (10K+ entries) may take several seconds

## Security Notes

- **Layer 1 (this implementation):** No encryption. User responsible for backup file security
- **Layer 2 (planned):** Cloud encrypted backup for disaster recovery
- **Device storage:** Keep backups on secure devices
- **Network transmission:** Use HTTPS if uploading backups

## Testing

### Test Export
```typescript
const backup = await backupService.exportLedger();
console.assert(backup.version === '1.0');
console.assert(Array.isArray(backup.accounts));
console.assert(Array.isArray(backup.entries));
console.assert(backup.exportedAt !== undefined);
```

### Test Restore
```typescript
// 1. Create a backup
const backup1 = await backupService.exportLedger();

// 2. Clear database
await db.clear();

// 3. Restore
await backupService.restoreLedger(backup1);

// 4. Verify
const backup2 = await backupService.exportLedger();
console.assert(backup1.accounts.length === backup2.accounts.length);
console.assert(backup1.entries.length === backup2.entries.length);
```

### Test Safety Guard
```typescript
// Should fail if database not empty
try {
  await backupService.restoreLedger(someBackup);
  console.error('Safety guard failed!');
} catch (error) {
  console.assert(error.message.includes('not empty'));
}
```
