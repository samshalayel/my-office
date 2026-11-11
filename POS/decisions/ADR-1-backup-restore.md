# ADR-1: Backup and Restore Strategy

**Date:** 2026-11-11  
**Status:** ACCEPTED  
**References:** BASE-7, BASE-T11, BASE-T15

## Problem

The POS ledger system stores all data locally in IndexedDB with no mechanism to:
- Export data to portable format
- Restore from backups
- Protect against data loss from device failure

## Solution: Layered Backup Architecture

### Layer 1: Local JSON Export/Import (BASE-7, this task)
**Purpose:** Offline-first backup suitable for local device storage or manual transfer

**Capabilities:**
- Export complete ledger (accounts, entries, metadata) as JSON
- Restore from JSON backup to empty database only
- Validates that database is empty before restore (prevents accidental overwrites)
- Portable across devices and storage media

**Implementation:**
- `BackupRestoreService` in `backup-restore.ts`
- Methods:
  - `exportLedger()` - returns typed LedgerBackup object
  - `exportLedgerAsJson()` - returns JSON string (for file download)
  - `restoreLedger(backup)` - imports from LedgerBackup object
  - `restoreLedgerFromJson(jsonString)` - imports from JSON string
  - `isDatabaseEmpty()` - validates database state

**Constraints:**
- Requires empty database for restore (safety guard against data loss)
- No encryption at this layer (device-local responsibility)
- No compression (for data integrity verification)
- Plain JSON format for transparency and debugging

### Layer 2: Cloud Encrypted Backup (BASE-T15, future)
**Purpose:** Secure, off-device backup for disaster recovery

**Planned approach:**
- End-to-end encrypted sync to cloud storage
- Optional automated backups
- Separate from Layer 1 (independent mechanisms)

## Tradeoffs

**Layer 1 Design Choices:**

| Choice | Benefit | Cost |
|--------|---------|------|
| JSON format | Human-readable, portable, debug-friendly | Larger file size |
| Empty-DB-only restore | Prevents accidental data loss | Requires explicit clear operation first |
| No compression | Integrity verification, simple implementation | Larger backup files |
| No encryption | User controls where backups are stored | Device security is user's responsibility |

## Success Criteria

- [x] Export all accounts and entries as JSON
- [x] Restore JSON to empty database
- [x] Prevent restore if database is not empty
- [x] Include metadata in backup (schema version, timestamps)
- [ ] Integration with UI for manual export/import (scope for later)
- [ ] Documented restore procedure for users

## Related Tasks

- **BASE-7** (this task): Local backup/restore implementation
- **BASE-T15**: Cloud encrypted backup layer

## Future Considerations

1. **Automated backups:** Periodic snapshots without user intervention
2. **Selective restore:** Import only specific accounts/date ranges
3. **Backup versioning:** Track multiple backup versions
4. **Merge capability:** Combine data from multiple backups
5. **Compression:** Optional gzip for large ledgers
