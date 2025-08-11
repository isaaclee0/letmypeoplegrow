# Rate Limiting Configuration

## Overview
Rate limiting has been enabled across the application to prevent JWT token spam, authentication abuse, and general API abuse. The configuration is environment-aware, with more lenient limits in development and stricter limits in production.

## Global Rate Limiting

### API Endpoints (`/api/*`)
- **Window**: 15 minutes
- **Development**: 1000 requests per IP/user
- **Production**: 100 requests per IP/user
- **Purpose**: Protect against general API abuse and DDoS attacks

## Authentication-Specific Rate Limiting

### One-Time Code Requests (`/auth/request-code`)
- **Window**: 1 minute
- **Development**: 30 requests per IP
- **Production**: 10 requests per IP
- **Purpose**: Prevent OTC spam and abuse

### Authentication Attempts (`/auth/verify-code`)
- **Window**: 15 minutes
- **Development**: 20 requests per IP
- **Production**: 5 requests per IP
- **Purpose**: Prevent brute force attacks

### Token Refresh (`/auth/refresh`)
- **Window**: 15 minutes (auth) + 5 minutes (refresh)
- **Development**: 20 requests per IP (auth) + 50 requests per IP (refresh)
- **Production**: 5 requests per IP (auth) + 10 requests per IP (refresh)
- **Purpose**: Prevent JWT refresh token attacks

## Security Features

### Rate Limiter Configuration
- **Skip Successful Requests**: Only failed requests count toward limits
- **Standard Headers**: Includes `X-RateLimit-*` headers in responses
- **Custom Key Generation**: Uses IP + user ID when available for better tracking
- **Legacy Headers**: Disabled for cleaner responses

### Headers Included
- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests in current window
- `X-RateLimit-Reset`: Time when the rate limit resets (Unix timestamp)

## Environment-Specific Behavior

### Development Mode
- More lenient limits to allow for testing and development
- Higher request limits across all endpoints
- Better for debugging and development workflows

### Production Mode
- Stricter limits to prevent abuse
- Lower request limits for security
- Optimized for real-world usage patterns

## Monitoring and Logging

### Rate Limit Events
- Failed requests due to rate limiting are logged
- Rate limit headers are included in all responses
- Custom error messages provide clear feedback

### Security Benefits
- **JWT Protection**: Prevents token refresh attacks
- **Authentication Security**: Prevents brute force and OTC spam
- **API Protection**: General protection against abuse
- **DDoS Mitigation**: Helps prevent distributed attacks

## Configuration Files

### Primary Configuration
- `server/routes/auth.js`: Authentication-specific rate limiting
- `server/index.js`: Global API rate limiting
- `server/middleware/security.js`: Security rate limiting utilities

### Environment Variables
- `NODE_ENV`: Determines development vs production limits
- Rate limits automatically adjust based on environment

## Testing Rate Limiting

### Development Testing
```bash
# Test OTC rate limiting
for i in {1..31}; do
  curl -X POST http://localhost/api/auth/request-code \
    -H "Content-Type: application/json" \
    -d '{"contact":"test@example.com"}'
done

# Test authentication rate limiting
for i in {1..21}; do
  curl -X POST http://localhost/api/auth/verify-code \
    -H "Content-Type: application/json" \
    -d '{"contact":"test@example.com","code":"000000"}'
done
```

### Production Verification
- Monitor rate limit headers in responses
- Check logs for rate limit violations
- Verify limits are being enforced correctly

## Security Considerations

### Best Practices
- Rate limits are applied before authentication to prevent bypass
- Custom key generation includes user context when available
- Successful requests don't count toward limits
- Clear error messages help legitimate users understand limits

### Monitoring
- Log rate limit violations for security analysis
- Monitor rate limit headers for usage patterns
- Track failed authentication attempts

### Adjustments
- Limits can be adjusted based on usage patterns
- Environment-specific configurations allow for flexibility
- Security vs usability balance maintained 