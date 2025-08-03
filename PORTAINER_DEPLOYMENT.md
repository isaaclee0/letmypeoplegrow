# Portainer Deployment Guide

This guide explains how to deploy the Let My People Grow application using Portainer in **production mode**.

## Prerequisites

1. **Portainer CE or EE** installed and running
2. **Docker** installed on the host system
3. **Git repository access** to this project
4. **Available ports**: 3003 (frontend), 3004 (backend API), 3306 (database, internal only)

## Deployment Steps

### 1. Prepare Environment Variables

Before deploying, you need to set up environment variables in Portainer. Go to your Portainer instance and:

1. Navigate to **Stacks** → **Add stack**
2. In the **Environment variables** section, add the following variables:

#### Required Variables (with defaults):
```
DB_ROOT_PASSWORD=your_secure_root_password
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=your_secure_db_password
NODE_ENV=production
JWT_SECRET=your_very_secure_jwt_secret_here
```

#### Optional Variables (with defaults):
```
CLIENT_URL=http://localhost:3003
JWT_EXPIRE=30d
OTC_EXPIRE_MINUTES=10
OTC_RESEND_COOLDOWN_SECONDS=60
EMAIL_FROM=hello@letmypeoplegrow.com.au
EMAIL_FROM_NAME="Let My People Grow"
EMAIL_DOMAIN=letmypeoplegrow.com.au
CHURCH_NAME="Let My People Grow"
```

#### External Service Variables (optional):
```
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=your_twilio_phone_number
BREVO_API_KEY=your_brevo_api_key
```

### 2. Deploy the Stack

1. **Method 1: Upload from Git**
   - In Portainer, go to **Stacks** → **Add stack**
   - Choose **Repository** tab
   - Enter your Git repository URL
   - Set the **Repository reference** (branch/tag)
   - Set the **Compose path** to `portainer-stack.yml`
   - Add your environment variables
   - Click **Deploy the stack**

2. **Method 2: Upload from file**
   - Download the `portainer-stack.yml` file
   - In Portainer, go to **Stacks** → **Add stack**
   - Choose **Upload** tab
   - Upload the `portainer-stack.yml` file
   - Add your environment variables
   - Click **Deploy the stack**

### 3. Network Configuration

The stack requires an external network called `npm_proxy`. If it doesn't exist:

1. Go to **Networks** in Portainer
2. Click **Add network**
3. Name it `npm_proxy`
4. Set driver to `bridge`
5. Click **Create the network**

### 4. Verify Deployment

After deployment, check:

1. **All containers are running** in the stack overview
2. **Database is healthy** (check logs for MariaDB)
3. **Server is responding** (check logs for Node.js server)
4. **Client is accessible** (check logs for React client)

### 5. Access the Application

- **Frontend**: http://your-server-ip:3003
- **Backend API**: http://your-server-ip:3004
- **Database**: Internal access only (port 3306)

## Port Configuration

This deployment uses the following ports to avoid conflicts:

| Service | Internal Port | External Port | Purpose |
|---------|---------------|---------------|---------|
| Frontend | 3000 | 3003 | React application |
| Backend | 3001 | 3004 | Node.js API |
| Database | 3306 | Internal only | MariaDB |

**Note**: If you need different ports, modify the `portainer-stack.yml` file before deployment.

## Environment Configuration

### Production vs Development

This stack is configured for **production deployment**:

- `NODE_ENV=production` (default)
- Uses production Docker images from Docker Hub
- Optimized for performance and security
- Database persistence enabled

### For Development

If you need a development environment, use the `docker-compose.dev.yml` file instead:

```bash
# Local development
docker-compose -f docker-compose.dev.yml up
```

## Troubleshooting

### Common Issues

1. **"env file not found" error**
   - Solution: Use the updated `portainer-stack.yml` file which includes default values
   - Make sure all required environment variables are set in Portainer

2. **Database connection issues**
   - Check that database environment variables are correctly set
   - Verify the database container is healthy
   - Check server logs for connection errors

3. **Network issues**
   - Ensure the `npm_proxy` network exists
   - Check that all containers are on the same network

4. **Port conflicts**
   - Ensure ports 3003 and 3004 are available on the host
   - Change ports in the stack file if needed

5. **Application not accessible**
   - Verify containers are running: `docker ps`
   - Check container logs in Portainer
   - Test connectivity: `curl http://localhost:3004/api/health`

### Logs and Debugging

1. **View container logs** in Portainer:
   - Go to **Containers** → Select container → **Logs**

2. **Check database health**:
   ```bash
   docker exec -it church_attendance_db mariadb -u church_user -p
   ```

3. **Test API connectivity**:
   ```bash
   curl http://localhost:3004/api/health
   ```

4. **Test frontend accessibility**:
   ```bash
   curl http://localhost:3003
   ```

## Security Considerations

1. **Change default passwords** for database and JWT
2. **Use HTTPS** in production (configure nginx)
3. **Set up firewall rules** to restrict access
4. **Regular backups** of the database volume
5. **Monitor logs** for security issues

## Production Recommendations

1. **Use a reverse proxy** (nginx/traefik) for SSL termination
2. **Set up automated backups** of the database
3. **Configure monitoring** and alerting
4. **Use secrets management** for sensitive environment variables
5. **Regular security updates** of base images

## Support

If you encounter issues:
1. Check the logs in Portainer
2. Verify all environment variables are set
3. Ensure Docker and Portainer are up to date
4. Check the troubleshooting section above 