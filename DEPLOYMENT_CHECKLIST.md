# Deployment Checklist for Let My People Grow

This checklist ensures a successful first-time deployment of the Let My People Grow application.

## Pre-Deployment Checklist

### ✅ System Requirements
- [ ] Docker and Docker Compose installed
- [ ] At least 2GB RAM available
- [ ] At least 10GB disk space
- [ ] Ports 3000, 3002, and 3307 available

### ✅ Environment Setup
- [ ] Repository cloned successfully
- [ ] Environment files created:
  - [ ] `.env` (root directory)
  - [ ] `server/.env` (server configuration)
- [ ] Required environment variables configured (see below)

### ✅ Required Environment Variables

#### Root `.env` file:
```bash
# Docker Image Configuration
IMAGE_TAG=v0.3.3

# Database Configuration
DB_ROOT_PASSWORD=your_secure_root_password
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=your_secure_db_password

# Server Configuration
SERVER_PORT=3001
CLIENT_URL=http://localhost:3000

# JWT Configuration
JWT_SECRET=your_very_secure_jwt_secret_key_here
JWT_EXPIRE=24h

# OTC Configuration
OTC_EXPIRE_MINUTES=10
OTC_RESEND_COOLDOWN_SECONDS=60

# Email Configuration
EMAIL_FROM=hello@letmypeoplegrow.com.au
EMAIL_FROM_NAME="Let My People Grow"
EMAIL_DOMAIN=letmypeoplegrow.com.au
CHURCH_NAME="Let My People Grow"

# Client Configuration
CLIENT_PORT=3000

# Nginx Configuration
NGINX_HTTP_PORT=80
NGINX_HTTPS_PORT=443
```

#### Server `server/.env` file:
```bash
# Twilio SMS Configuration (Optional for first deployment)
TWILIO_ACCOUNT_SID=your_twilio_account_sid_here
TWILIO_AUTH_TOKEN=your_twilio_auth_token_here
TWILIO_FROM_NUMBER=your_twilio_phone_number_here

# Brevo API key (Optional for first deployment)
BREVO_API_KEY=your_brevo_api_key_here

# Basic configuration
NODE_ENV=development
PORT=3001
CLIENT_URL=http://localhost:3000

# Database Configuration (MariaDB)
DB_HOST=db
DB_PORT=3306
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=church_password

# JWT Configuration
JWT_SECRET=your_secure_jwt_secret_change_this_in_production
JWT_EXPIRE=30d

# OTC Configuration
OTC_EXPIRE_MINUTES=10
OTC_RESEND_COOLDOWN_SECONDS=60

# Email Configuration
EMAIL_FROM=hello@letmypeoplegrow.com.au
EMAIL_FROM_NAME="Let My People Grow"
EMAIL_DOMAIN=letmypeoplegrow.com.au
CHURCH_NAME="Let My People Grow"
```

## Deployment Steps

### 1. Initial Setup
```bash
# Clone the repository
git clone https://github.com/isaaclee0/letmypeoplegrow.git
cd letmypeoplegrow

# Create environment files
cp .env.example .env
cp server/.env.example server/.env

# Edit environment files with your values
nano .env
nano server/.env
```

### 2. Start Development Environment
```bash
# Start all services
sudo docker-compose -f docker-compose.dev.yml up -d

# Check container status
sudo docker-compose -f docker-compose.dev.yml ps

# View logs
sudo docker-compose -f docker-compose.dev.yml logs -f
```

### 3. Verify Deployment

#### Health Checks
- [ ] Frontend accessible: http://localhost:3000
- [ ] Backend health check: http://localhost:3002/health
- [ ] Database health check: http://localhost:3002/health/db

#### Expected Responses:
```json
// Health check response
{
  "status": "OK",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "environment": "development",
  "version": "0.8.6"
}

// Database health check response
{
  "status": "OK",
  "database": "connected"
}
```

### 4. Initial Configuration

#### First-Time Setup
- [ ] Access the application at http://localhost:3000
- [ ] Complete the onboarding process
- [ ] Create the first admin user
- [ ] Configure church settings

#### Default Admin User
- **Email**: admin@church.local
- **Password**: Set during onboarding
- **Role**: Administrator

## Troubleshooting

### Common Issues

#### 1. Server Won't Start
**Symptoms**: Server container keeps crashing
**Solutions**:
- Check environment variables are set correctly
- Verify database container is healthy
- Check logs: `sudo docker-compose -f docker-compose.dev.yml logs server`

#### 2. Database Connection Issues
**Symptoms**: Database health check fails
**Solutions**:
- Wait for database to fully initialize (can take 30-60 seconds)
- Check database logs: `sudo docker-compose -f docker-compose.dev.yml logs db`
- Verify database credentials in environment files

#### 3. Frontend Won't Load
**Symptoms**: Cannot access http://localhost:3000
**Solutions**:
- Check if client container is running
- Verify port 3000 is not in use
- Check client logs: `sudo docker-compose -f docker-compose.dev.yml logs client`

#### 4. Permission Issues
**Symptoms**: Docker permission denied errors
**Solutions**:
- Use `sudo` with docker commands
- Or add user to docker group: `sudo usermod -aG docker $USER`

### Log Locations
- **Application logs**: `server/logs/` directory
- **Docker logs**: `sudo docker-compose -f docker-compose.dev.yml logs [service]`
- **Database logs**: Inside the MariaDB container

### Reset Everything
If you need to start fresh:
```bash
# Stop and remove everything
sudo docker-compose -f docker-compose.dev.yml down -v

# Remove all images
sudo docker system prune -a

# Start fresh
sudo docker-compose -f docker-compose.dev.yml up -d
```

## Production Deployment

### Additional Steps for Production
- [ ] Set `NODE_ENV=production` in environment files
- [ ] Use strong, unique passwords for all services
- [ ] Configure SSL/TLS certificates
- [ ] Set up proper backup procedures
- [ ] Configure monitoring and alerting
- [ ] Set up proper firewall rules
- [ ] Configure external email/SMS services

### Security Checklist
- [ ] Change default JWT secret
- [ ] Use strong database passwords
- [ ] Configure proper CORS settings
- [ ] Enable rate limiting
- [ ] Set up proper user authentication
- [ ] Configure audit logging

## Support

If you encounter issues not covered in this checklist:
1. Check the logs for error messages
2. Review the troubleshooting section above
3. Check the project's GitHub issues
4. Create a new issue with detailed error information

## Success Criteria

A successful deployment is achieved when:
- [ ] All containers are running and healthy
- [ ] Health checks return "OK" status
- [ ] Frontend application loads without errors
- [ ] Database is accessible and initialized
- [ ] First admin user can be created
- [ ] Basic functionality works (login, navigation) 