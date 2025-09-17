# Database Initialization Troubleshooting

## Issue: Server stuck on "Initializing database schema..."

### What's Happening
The server is trying to create database tables but appears to be stuck. This usually happens when:
1. Database connection issues
2. Database not ready yet
3. Permission problems
4. Network connectivity issues

### Solutions

#### 1. Check Database Container Status
```bash
# In Portainer, check if the database container is running
# Look for any error messages in the database logs
```

#### 2. Verify Database Connection
The server should be able to connect to the database using:
- **Host**: `db` (container name)
- **Port**: `3306`
- **Database**: `church_attendance`
- **User**: `church_user`
- **Password**: (from your stack.env)

#### 3. Check Environment Variables
Make sure these are set correctly in `stack.env`:
```env
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=your_secure_db_password_here
```

#### 4. Database Initialization Process
The server will automatically:
1. Connect to the database
2. Check for existing tables
3. Create missing tables
4. Create default admin user

#### 5. Manual Database Reset (if needed)
If the database gets corrupted, you can reset it:

```bash
# Stop the stack
# Delete the db_data volume
# Restart the stack
```

#### 6. Check Server Logs
Look for specific error messages in the server logs:
- Connection refused
- Access denied
- Table creation errors

### Expected Behavior
1. Database container starts and becomes healthy
2. Server waits for database to be ready
3. Server connects to database
4. Server creates tables (if they don't exist)
5. Server starts successfully

### Timeout Issues
If the server times out waiting for the database:
- Increase the health check retries
- Check if the database password is correct
- Verify the database user has proper permissions

### Common Fixes
1. **Restart the entire stack** - This often resolves timing issues
2. **Check database logs** - Look for initialization errors
3. **Verify environment variables** - Ensure all DB settings are correct
4. **Wait longer** - Sometimes the database needs more time to initialize

### If Still Stuck
1. Stop the stack
2. Delete the `db_data` volume
3. Restart the stack
4. Monitor the logs for specific error messages 