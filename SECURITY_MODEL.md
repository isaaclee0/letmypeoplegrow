# Security Model and Church ID System

## Overview

This document explains the security model for church data isolation and the church ID system used to prevent unauthorized access to church data.

## Church ID System

### Development Environment
- **Format**: Simple, readable IDs (e.g., `devch1`, `redcc1`)
- **Purpose**: Easy debugging and development
- **Security**: Lower security, but acceptable for development

### Production Environment
- **Format**: Secure, unpredictable IDs (e.g., `dev_abc123def456`, `red_xyz789ghi012`)
- **Structure**: `{base}_{random_hex}`
  - `base`: First 3 letters of church name
  - `random_hex`: 12-character random hex string
- **Security**: High security, not easily guessable

## Security Measures

### 1. Authentication Required
- All data access requires valid JWT tokens
- Tokens include church_id and expire automatically
- No anonymous access to church data

### 2. Church Isolation
- Users can only access data from their assigned church
- Middleware validates church_id on every request
- Database queries automatically filter by church_id

### 3. Church ID Validation
- All church IDs are validated for correct format
- Invalid church IDs are rejected immediately
- Logging includes sanitized church IDs for security

### 4. Rate Limiting
- **Church ID Guessing**: 10 attempts per 15 minutes per IP
- **Authentication**: 5 failed attempts per 15 minutes per IP
- **General API**: 100 requests per 15 minutes per IP

### 5. Input Validation
- All church IDs are validated before use
- SQL injection protection on all database queries
- Input sanitization for all user data

### 6. Logging and Monitoring
- All church access is logged (with sanitized IDs)
- Failed authentication attempts are tracked
- Suspicious activity patterns are flagged

## Potential Attack Vectors and Mitigations

### 1. Church ID Guessing
**Risk**: Attacker tries to guess church IDs to access data
**Mitigation**: 
- Secure church IDs in production (random suffix)
- Rate limiting on failed attempts
- Authentication required for all access

### 2. Token Theft
**Risk**: JWT tokens are stolen and used to access data
**Mitigation**:
- HTTP-only cookies for token storage
- Short token expiration (30 days)
- Token refresh mechanism with validation

### 3. Database Access
**Risk**: Direct database access bypasses application security
**Mitigation**:
- Church isolation at database level
- Prepared statements prevent SQL injection
- Database user has minimal required permissions

### 4. Cross-Church Access
**Risk**: User accesses data from different church
**Mitigation**:
- Church isolation middleware on all routes
- Database queries filter by church_id
- User tokens include church_id validation

## Security Best Practices

### For Developers
1. **Never log full church IDs** - use sanitization functions
2. **Always validate church IDs** - check format before use
3. **Use prepared statements** - prevent SQL injection
4. **Test security measures** - verify isolation works

### For Administrators
1. **Monitor access logs** - watch for suspicious patterns
2. **Regular security audits** - check for vulnerabilities
3. **Keep dependencies updated** - patch security issues
4. **Use HTTPS in production** - encrypt all traffic

### For Users
1. **Keep tokens secure** - don't share authentication
2. **Log out when done** - clear browser sessions
3. **Report suspicious activity** - notify administrators
4. **Use strong passwords** - protect account access

## Security Configuration

### Environment Variables
```bash
# Security settings
NODE_ENV=production  # Enables secure church IDs
JWT_SECRET=your_secure_secret  # Must be strong and unique
JWT_EXPIRE=30d  # Token expiration time

# Rate limiting
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100  # Max requests per window
```

### Database Security
```sql
-- Church isolation is enforced at database level
-- All tables include church_id column
-- Queries automatically filter by church_id
```

## Incident Response

### If Church ID is Compromised
1. **Immediate**: Revoke all tokens for affected church
2. **Investigation**: Check logs for unauthorized access
3. **Recovery**: Generate new church ID and migrate data
4. **Prevention**: Review security measures and update

### If Token is Stolen
1. **Immediate**: Revoke specific token
2. **Investigation**: Check for unauthorized access
3. **Recovery**: Issue new token to user
4. **Prevention**: Review token security measures

## Compliance

This security model is designed to meet common compliance requirements:
- **Data Isolation**: Church data is completely isolated
- **Access Control**: Role-based access with authentication
- **Audit Logging**: All access is logged and monitored
- **Input Validation**: All inputs are validated and sanitized

## Future Enhancements

### Planned Security Improvements
1. **Multi-factor Authentication**: Add 2FA for admin accounts
2. **IP Whitelisting**: Restrict access to known IP ranges
3. **Advanced Monitoring**: AI-based threat detection
4. **Encryption at Rest**: Encrypt sensitive data in database

### Security Testing
1. **Penetration Testing**: Regular security assessments
2. **Code Reviews**: Security-focused code reviews
3. **Dependency Scanning**: Automated vulnerability scanning
4. **Security Training**: Regular developer security training
