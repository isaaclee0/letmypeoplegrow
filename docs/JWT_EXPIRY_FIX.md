# JWT Expiry Fix - Login Issue Resolution

## Problem
Users were unable to log in because JWT tokens were expiring after 24 hours (`JWT_EXPIRE: 24h`). The error logs showed:
```
Auth middleware error: TokenExpiredError: jwt expired
expiredAt: 2025-07-29T21:29:49.000Z
```

## Root Cause
1. JWT tokens were set to expire after 24 hours
2. No automatic token refresh mechanism was in place
3. Users who logged in more than 24 hours ago were blocked from accessing the application

## Solution Implemented

### 1. Extended JWT Expiration Time
- Changed `JWT_EXPIRE` from `24h` to `30d` (30 days)
- Updated in all Docker Compose files:
  - `docker-compose.yml`
  - `docker-compose.dev.yml` 
  - `docker-compose.prod.yml`
- **FIXED**: Updated `.env` file to match Docker configuration

### 2. Added Automatic Token Refresh
- **Client-side**: Added automatic token refresh every 25 days (before 30-day expiry)
- **API Interceptor**: Added automatic retry with token refresh on 401 errors
- **AuthContext**: Added periodic token refresh for authenticated users
- **FIXED**: Resolved infinite loop issues with proper safeguards

### 3. Improved Error Handling
- Better error messages for expired tokens
- Specific error codes for different token issues
- Graceful fallback to login page when refresh fails
- **FIXED**: Added proper retry logic and request queuing

## Files Modified

### Server-side
- `server/middleware/auth.js` - Better error handling for expired tokens
- `server/routes/auth.js` - Enhanced refresh endpoint with validation and logging
- `docker-compose.yml` - Updated JWT_EXPIRE to 30d
- `docker-compose.dev.yml` - Updated JWT_EXPIRE to 30d
- `docker-compose.prod.yml` - Updated JWT_EXPIRE to 30d

### Client-side
- `client/src/services/api.ts` - Fixed automatic token refresh with infinite loop prevention
- `client/src/contexts/AuthContext.tsx` - Re-enabled periodic token refresh with safeguards
- `.env` - Updated JWT_EXPIRE to 30d for consistency

### Documentation
- `README.md` - Updated JWT_EXPIRE example
- `update-jwt-expiry.sh` - Helper script for production updates
- `JWT_EXPIRY_FIX.md` - This documentation

## Token Refresh System Architecture

### Automatic Refresh (API Interceptor)
- **Trigger**: 401 errors on API requests
- **Safeguards**: 
  - Skips refresh for auth endpoints (`/auth/refresh`, `/auth/logout`)
  - Prevents infinite loops with `_retry` flag
  - Queues concurrent requests during refresh
  - Clears user data and redirects on refresh failure

### Periodic Refresh (AuthContext)
- **Trigger**: Every 25 days (before 30-day expiry)
- **Safeguards**:
  - Prevents concurrent refreshes
  - Debounced redirects (5-second cooldown)
  - Proper cleanup on logout

### Manual Refresh
- **Trigger**: User-initiated or programmatic calls
- **Use Cases**: Before critical operations, user actions

## Deployment Instructions

### Option 1: Using the Helper Script
```bash
./update-jwt-expiry.sh
```

### Option 2: Manual Docker Compose Update
```bash
# Stop containers
docker-compose -f docker-compose.prod.yml down

# Rebuild and start with new configuration
docker-compose -f docker-compose.prod.yml up -d --build
```

### Option 3: Using Build Script
```bash
# Rebuild and push with new version
./build-and-push.sh <new-version>
```

### Option 4: Portainer Update
1. Update your stack with the new `docker-compose.prod.yml`
2. Redeploy the stack in Portainer

## Benefits
1. **Longer Session Duration**: Users can stay logged in for 30 days
2. **Automatic Refresh**: Tokens are refreshed before expiration
3. **Better UX**: No unexpected logouts due to token expiry
4. **Graceful Degradation**: If refresh fails, users are redirected to login
5. **Consistent Configuration**: All environments use the same JWT settings
6. **Robust Error Handling**: Proper handling of edge cases and failures

## Testing
After deployment, verify:
1. Users can log in successfully
2. Sessions persist for longer periods
3. Automatic token refresh works in browser console
4. Expired tokens are handled gracefully
5. No infinite loops occur during refresh
6. Concurrent requests are properly queued

## Security Considerations
- 30-day expiration is still reasonable for most church applications
- Tokens are stored in HTTP-only cookies (secure)
- Automatic refresh only happens for authenticated users
- Failed refresh attempts redirect to login immediately
- Refresh requests are properly validated on the server
- Inactive users cannot refresh tokens

## Recent Fixes (Latest Update)
- **Fixed infinite loop issue** in API interceptor
- **Re-enabled automatic token refresh** with proper safeguards
- **Updated .env file** to match Docker configuration
- **Enhanced server-side refresh endpoint** with better validation
- **Improved error handling** and logging throughout the system
- **Added request queuing** for concurrent refresh attempts 