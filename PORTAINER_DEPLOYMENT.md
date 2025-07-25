# Portainer Deployment Guide

This guide explains how to deploy the Let My People Grow application using Portainer with the provided stack files.

## Prerequisites

- Portainer installed and running
- Access to Docker Hub images: `staugustine1/letmypeoplegrow-server` and `staugustine1/letmypeoplegrow-client`

## Files Required

1. **`portainer-stack.yml`** - The Docker Compose stack file
2. **`stack.env`** - Environment variables with your API keys (⚠️ **KEEP SECURE**)
3. **`nginx.conf`** - Nginx configuration file
4. **`server/scripts/init.sql`** - Database initialization script

## ⚠️ Security Notice

The `stack.env` file contains sensitive information including:
- Database passwords
- JWT secrets
- API keys for Twilio and Brevo
- Other production credentials

**Never commit this file to version control or share it publicly.**

## Deployment Steps

### 1. Prepare Your Files

Ensure you have all required files in your Portainer host:
- `portainer-stack.yml`
- `stack.env` (with your actual values)
- `nginx.conf`
- `server/scripts/init.sql`

### 2. Upload to Portainer

1. **Log into Portainer**
2. **Navigate to Stacks**
3. **Click "Add stack"**
4. **Upload the files:**
   - Upload `portainer-stack.yml` as the stack file
   - Upload `stack.env` as the environment file
   - Upload `nginx.conf` to the appropriate location
   - Upload `server/scripts/init.sql` to the appropriate location

### 3. Configure the Stack

1. **Stack name**: `letmypeoplegrow`
2. **Build method**: Select "Upload"
3. **Stack file**: Upload `portainer-stack.yml`
4. **Environment file**: Upload `stack.env`

### 4. Deploy

Click "Deploy the stack" to start the deployment.

## Environment Variables

The `stack.env` file contains all necessary environment variables:

### Docker Configuration
- `IMAGE_TAG=v0.1.1` - Docker image version

### Database
- `DB_ROOT_PASSWORD` - MariaDB root password
- `DB_NAME` - Database name
- `DB_USER` - Database user
- `DB_PASSWORD` - Database password

### Application
- `JWT_SECRET` - JWT signing secret
- `JWT_EXPIRE` - JWT expiration time
- `EMAIL_FROM` - Email sender address

### API Keys
- `TWILIO_ACCOUNT_SID` - Twilio account SID
- `TWILIO_AUTH_TOKEN` - Twilio auth token
- `TWILIO_FROM_NUMBER` - Twilio phone number
- `BREVO_API_KEY` - Brevo email API key

### Ports
- `SERVER_PORT` - Backend API port
- `CLIENT_PORT` - Frontend port
- `NGINX_HTTP_PORT` - HTTP port
- `NGINX_HTTPS_PORT` - HTTPS port

## Services

The stack deploys 4 services:

1. **Database** (`db`) - MariaDB 10.6
2. **Server** (`server`) - Node.js backend API
3. **Client** (`client`) - React frontend
4. **Nginx** (`nginx`) - Reverse proxy

## Monitoring

### Check Service Status
- Navigate to the stack in Portainer
- View individual service logs
- Monitor resource usage

### Health Checks
- Database has built-in health checks
- Services restart automatically on failure

## Updating the Application

### Update to New Version
1. Update `IMAGE_TAG` in `stack.env`
2. Redeploy the stack in Portainer

### Update Environment Variables
1. Modify `stack.env` with new values
2. Redeploy the stack in Portainer

## Troubleshooting

### Common Issues

1. **Database connection errors**
   - Check database credentials in `stack.env`
   - Ensure database service is healthy

2. **Port conflicts**
   - Modify port variables in `stack.env`
   - Check for other services using the same ports

3. **API key errors**
   - Verify Twilio and Brevo credentials in `stack.env`
   - Check API key permissions

### Logs
- View logs in Portainer for each service
- Check for specific error messages
- Monitor resource usage

## Backup

### Database Backup
```bash
# Create backup
docker exec church_attendance_db mysqldump -u church_user -p church_attendance > backup.sql

# Restore backup
docker exec -i church_attendance_db mysql -u church_user -p church_attendance < backup.sql
```

### Environment Backup
- Keep a secure copy of `stack.env`
- Store in a secure location (password manager, etc.)
- Never commit to version control

## Security Best Practices

1. **Change default passwords** in `stack.env`
2. **Use strong JWT secrets**
3. **Restrict access** to Portainer admin interface
4. **Regular updates** of Docker images
5. **Monitor logs** for suspicious activity
6. **Backup regularly** your database and configuration 