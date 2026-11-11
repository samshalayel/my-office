# POS Application - Security Guidelines

## Overview

This document outlines the security measures implemented in the POS application, particularly for BASE-11 (Basic Security).

## 1. Input Validation in Data Layer

All user input is validated at the data layer before being stored in IndexedDB.

### Validation Module: `POS/js/validation.ts`

The `InputValidator` class provides comprehensive validation for:

- **Entries**: Type, amount, account ID, timestamp, notes
- **Account names**: Length, content validation
- **Amounts**: Type checking, positive values, finite numbers
- **Dates**: Format validation (YYYY-MM-DD), future date prevention
- **Search queries**: Length limits

### Usage Example

```typescript
import { InputValidator } from './validation';
import { NewEntry } from './types';

const entry: NewEntry = {
  type: 'debt_client',
  accountId: 'acc-123',
  amount: 500,
  ts: new Date().toISOString()
};

const errors = InputValidator.validateEntry(entry);
if (errors.length > 0) {
  console.error('Validation errors:', errors);
} else {
  // Safe to process
  await ledger.addEntry(entry);
}
```

### Validation Rules

#### Entry Validation
- `type`: Must be one of the defined EntryType values
- `amount`: Must be a positive number, <= 2 decimal places
- `accountId`: Required for all types except 'cash_sale'
- `ts`: Must be a valid ISO date string, not in the future
- `note`: Optional, max 1000 characters
- `linkedTo`: Optional, must be a valid UUID if provided

#### Account Name Validation
- Minimum 2 characters
- Maximum 200 characters
- Cannot be empty or whitespace-only

#### Amount Validation
- Must be a finite number
- Must be positive (> 0)
- Automatically rounded to 2 decimal places

## 2. Secrets Management

No secrets should ever be committed to the repository.

### Protected Files

The `.gitignore` file prevents the following from being committed:

```
.env              # Local environment variables
.env.local        # Local overrides
*.key             # Private keys
*.pem             # Certificate files
secrets/          # Secrets directory
.secrets          # Hidden secrets file
```

### Environment Variables

All configuration that contains sensitive information is stored in `.env` file (not committed).

**Template**: `.env.example`

```bash
# Copy to .env and fill in your actual values
cp .env.example .env
```

### Secrets to Protect

- Database credentials
- API keys
- SSL/TLS certificate paths
- Authentication tokens
- Session secrets
- API endpoints (if sensitive)

### Best Practices

1. **Never commit .env files** - They're in `.gitignore`
2. **Use environment variables** - For all sensitive configuration
3. **Use `.env.example`** - Show the structure without secrets
4. **Rotate secrets** - Regularly change passwords and tokens
5. **Use different secrets per environment** - dev, staging, production
6. **Audit git history** - Check if secrets were accidentally committed:
   ```bash
   git log -p | grep -i "password\|secret\|key\|token"
   ```

## 3. HTTPS for Hosting

HTTPS is required for Service Worker functionality and overall application security.

### Configuration

See `HTTPS_SETUP.md` for detailed setup instructions.

### Development

For local HTTPS:
```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes
export ENABLE_HTTPS=true
export SSL_CERT_PATH=./cert.pem
export SSL_KEY_PATH=./key.pem
npm start
```

### Production Requirements

- Use Let's Encrypt or trusted CA certificates
- Implement HSTS (HTTP Strict Transport Security)
- Use TLS 1.2 or higher
- Disable HTTP (redirect to HTTPS)

### Security Headers

The following headers should be set by the server:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
```

## 4. Additional Security Measures

### Data Storage

- IndexedDB is used for local client-side storage
- Data is not encrypted at rest (browser-dependent)
- Clear data on logout: `await ledger.clear()`

### API Security

- Always use HTTPS for API requests
- Validate all inputs before processing
- Return meaningful error messages (without exposing internals)
- Implement rate limiting if applicable (noted as N/A for this phase)

### Error Handling

- Log errors securely (don't log sensitive data)
- Return generic error messages to users
- Include detailed errors only in server logs

### Code Review Checklist

Before committing security-related code:

- [ ] No hardcoded secrets or API keys
- [ ] All user input is validated
- [ ] HTTPS is enforced in production
- [ ] Error messages don't expose internals
- [ ] Dependencies are up to date
- [ ] .gitignore covers sensitive files
- [ ] Environment variables are documented

## 5. Compliance Status

### BASE-11 Requirements

| Requirement | Status | Implementation |
|---|---|---|
| Input validation in data layer | ✅ Complete | `POS/js/validation.ts` |
| No secrets in repository | ✅ Complete | `.gitignore` + `.env.example` |
| HTTPS for hosting | ✅ Complete | `HTTPS_SETUP.md` + Environment config |
| Password policies | ⚠️ N/A | No user authentication in scope |
| Rate limiting | ⚠️ N/A | No users/API in scope |

## 6. References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)
- [Node.js Security Checklist](https://nodejs.org/en/knowledge/file-system/security/introduction/)
- [Service Worker HTTPS Requirement](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API#https_requirement)
