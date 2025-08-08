# Production Deployment Guide

This guide explains how to deploy the Let My People Grow application using Docker images from Docker Hub.

## Prerequisites

- Docker and Docker Compose installed on your server
- Access to the Docker Hub images: `staugustine1/letmypeoplegrow-server` and `staugustine1/letmypeoplegrow-client`

## Quick Start

1. **Clone or download the project files** (you only need the deployment files, not the full source code)

2. **Copy the deployment files:**
   ```bash
   cp docker-compose.prod.yml docker-compose.yml
   cp .env.example .env
   ```

3. **Configure your environment:**
   ```bash
   # Edit the .env file with your production values
   nano .env
   ```

4. **Create the server environment file:**
   ```bash
   mkdir -p server
   cp server/.env.example server/.env
   # Edit server/.env with your API keys and configuration
   ```

5. **Deploy the application:**
   ```bash
   docker-compose up -d
   ```

## Configuration

### Environment Variables

The main configuration is done through the `.env` file. Key variables include:

- `IMAGE_TAG`: The Docker image version to use (default: v0.9.0)
- `DB_PASSWORD`: Database password
- `JWT_SECRET`: Secret key for JWT tokens
- `EMAIL_FROM`: Email address for sending notifications

### Server Configuration

Create a `server/.env` file with your API keys:

```env
# Twilio Configuration (for SMS)
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number

# Brevo Configuration (for email)
BREVO_API_KEY=your_brevo_api_key

# Other server-specific settings
NODE_ENV=production
```

## Available Images

### Current Version: v0.9.0

- **Server**: `staugustine1/letmypeoplegrow-server:v0.9.0`
- **Client**: `staugustine1/letmypeoplegrow-client:v0.9.0`

### Updating to a New Version

To update to a new version:

1. Update the `IMAGE_TAG` in your `.env` file
2. Pull the new images:
   ```bash
   docker-compose pull
   ```
3. Restart the services:
   ```bash
   docker-compose up -d
   ```

## Services

The deployment includes:

- **Database**: MariaDB 10.6 with persistent storage
- **Server**: Node.js backend API
- **Client**: React frontend application
- **Nginx**: Reverse proxy for routing and SSL termination

## Ports

Default port mappings:

- **80**: HTTP (Nginx)
- **443**: HTTPS (Nginx)
- **3000**: Client (direct access)
- **3001**: Server API (direct access)

You can customize these by setting the corresponding environment variables.

## SSL Configuration

To enable HTTPS:

1. Create an `ssl` directory
2. Place your SSL certificates in the `ssl` directory
3. Update the nginx configuration to use SSL
4. Set `NGINX_HTTPS_PORT=443` in your `.env` file

## Data Persistence

The database data is persisted in a Docker volume named `db_data`. To backup your data:

```bash
# Create a backup
docker exec church_attendance_db mysqldump -u church_user -p church_attendance > backup.sql

# Restore from backup
docker exec -i church_attendance_db mysql -u church_user -p church_attendance < backup.sql
```

## Monitoring

Check the status of your services:

```bash
# View running containers
docker-compose ps

# View logs
docker-compose logs -f

# View logs for a specific service
docker-compose logs -f server
```

## Troubleshooting

### Common Issues

1. **Database connection errors**: Ensure the database is healthy before starting the server
2. **Port conflicts**: Change the port mappings in the `.env` file
3. **Permission issues**: Ensure the `server/uploads` directory has proper permissions

### Health Checks

The database includes a health check. You can monitor it with:

```bash
docker-compose ps db
```

## Support

For issues with the Docker images or deployment, please check:

1. Docker logs for error messages
2. Application logs for specific errors
3. Network connectivity between services 