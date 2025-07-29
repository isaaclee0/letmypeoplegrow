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

### 2. Added Automatic Token Refresh
- **Client-side**: Added automatic token refresh every 23 hours
- **API Interceptor**: Added automatic retry with token refresh on 401 errors
- **AuthContext**: Added periodic token refresh for authenticated users

### 3. Improved Error Handling
- Better error messages for expired tokens
- Specific error codes for different token issues
- Graceful fallback to login page when refresh fails

## Files Modified

### Server-side
- `server/middleware/auth.js` - Better error handling for expired tokens
- `docker-compose.yml` - Updated JWT_EXPIRE to 30d
- `docker-compose.dev.yml` - Updated JWT_EXPIRE to 30d
- `docker-compose.prod.yml` - Updated JWT_EXPIRE to 30d

### Client-side
- `client/src/services/api.ts` - Added automatic token refresh in response interceptor
- `client/src/contexts/AuthContext.tsx` - Added periodic token refresh mechanism

### Documentation
- `README.md` - Updated JWT_EXPIRE example
- `update-jwt-expiry.sh` - Helper script for production updates
- `JWT_EXPIRY_FIX.md` - This documentation

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

## Testing
After deployment, verify:
1. Users can log in successfully
2. Sessions persist for longer periods
3. Automatic token refresh works in browser console
4. Expired tokens are handled gracefully

## Security Considerations
- 30-day expiration is still reasonable for most church applications
- Tokens are stored in HTTP-only cookies (secure)
- Automatic refresh only happens for authenticated users
- Failed refresh attempts redirect to login immediately 