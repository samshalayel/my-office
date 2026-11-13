# [base-T3] Account: إضافة حساب بتحقق كامل

## Overview
Complete implementation of Account creation with full validation at the data layer.

## Implementation Details

### Contract: C-2 findOrCreateAccount
**Signature:** `findOrCreateAccount(name: string, side: Side) → AccountResult`

**Data Layer:** LedgerStore → LocalDatabase → IndexedDB

### Requirements (from S2 Contract)

#### Account Type
```typescript
Account {
  id: UUID                                      // Unique identifier
  name: string                                  // Unique within side
  side: Side                                    // 'client' | 'supplier' — constant after creation
  ledgerTransfer: 'open' | 'completed'         // Migration status
  createdAt: ISODateTime                        // Creation timestamp
}
```

#### Validations
1. **Name validation:**
   - Required (non-empty)
   - At least 2 characters
   - Trimmed of whitespace
   
2. **Side validation:**
   - Must be 'client' or 'supplier'
   - Constant after creation (cannot change)

3. **Uniqueness constraint:**
   - Name must be unique within the same side
   - Same name allowed for different sides
   - Case-insensitive comparison
   - Whitespace-trimmed comparison

4. **Standard fields:**
   - Auto-generated UUID for id
   - Current timestamp for createdAt
   - Initial ledgerTransfer value: 'open'

### Error Handling
Returns `AccountResult`:
```typescript
{
  ok: true,
  account: Account
}
// or
{
  ok: false,
  errors: string[]
}
```

#### Error Messages (Arabic)
- "الاسم مطلوب" - Name is required
- "الاسم يجب أن يكون حرفين على الأقل" - Name must be at least 2 characters
- "الاتجاه غير صحيح" - Side is invalid
- "هذا الاسم موجود بالفعل" - Name already exists
- Database/persistence errors handled gracefully

## Implementation Files

### Core Implementation
- `POS/js/account-validator.ts` - Validation logic
- `POS/js/ledger-store.ts` - C-2 contract implementation (updated)
- `POS/js/local-database.ts` - IndexedDB operations (unchanged)
- `POS/js/types.ts` - Type definitions (verified against S2 contract)

### Tests
- `POS/js/__tests__/account-validator.test.ts` - Validator unit tests
- `POS/js/__tests__/ledger-store.test.ts` - Integration tests for account creation

## Database Schema
IndexedDB Object Store: `accounts`
- **Key Path:** `id` (UUID)
- **Indexes:**
  - `side` - for querying by direction
  - `side_name` - composite unique index for enforcing name uniqueness within side

## Edge Cases Handled
1. ✅ Empty/whitespace-only names rejected
2. ✅ Duplicate names within same side rejected
3. ✅ Duplicate names in different sides allowed
4. ✅ Case-insensitive duplicate detection
5. ✅ Whitespace trimming in names
6. ✅ Concurrent account creation operations
7. ✅ Database persistence verification
8. ✅ Timestamp generation within valid range

## Testing Coverage

### Unit Tests (AccountValidator)
- Name validation (valid, empty, whitespace, too short)
- Side validation (valid, invalid, null, undefined)
- Composite account validation
- Duplicate detection
- Case-insensitive checking

### Integration Tests (LedgerStore + LocalDatabase)
- Create new account with valid data
- Return existing account instead of duplicate
- Allow same name for different sides
- Whitespace trimming
- Error handling and reporting
- UUID format validation
- Timestamp generation
- Persistence verification
- Concurrent operations
- Database error handling

## Definition of Done Checklist
- ✅ C-2 contract implemented with correct signature
- ✅ All validation rules from S2 contract implemented
- ✅ Unique name within side constraint enforced at database level
- ✅ Side is constant after creation (stored as immutable)
- ✅ Standard fields all present and correctly formatted
- ✅ Comprehensive test coverage for happy path and edge cases
- ✅ Error messages in Arabic as per contract
- ✅ No network calls in data layer (offline-first per HR-1)
- ✅ Append-only pattern for database operations (HR-3)
- ✅ commit message tagged with [base-T3]

## Dependencies
- **Depends on:** [base-T1] (LocalDatabase + LedgerStore foundation)
- **Used by:** [base-T4], [base-T6], [base-T7], and all other account-related tasks

## Notes
- Account side is immutable after creation - enforced by not providing update mechanism
- ledgerTransfer is status for migration tracking (S2 requirement), initially 'open'
- No updates/deletes on accounts - only creation (following append-only pattern for auditability)
