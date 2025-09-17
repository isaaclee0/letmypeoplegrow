# Let My People Grow - Docker Setup

This Docker setup provides a complete, isolated environment for running the Let My People Grow application without worrying about dependency conflicts or system-specific issues.

## 🐳 What's Included

- **MariaDB 10.6** - Database with automatic schema initialization
- **Node.js 18** - Backend API server with hot reloading
- **React 18** - Frontend client with hot reloading
- **Nginx** - Production-ready web server for the frontend
- **Docker Compose** - Orchestration for all services

## 🚀 Quick Start

### Prerequisites

1. **Docker Desktop** installed and running
2. **Git** (to clone the repository)

### Development Mode (Recommended)

```bash
# Start the application in development mode
./start.sh

# Or manually:
docker-compose -f docker-compose.dev.yml up --build -d
```

### Production Mode

```bash
# Start the application in production mode
docker-compose up --build -d
```

## 📋 Access Information

Once running, access your application at:

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001
- **Database**: localhost:3306

### Default Login

- **Email**: `admin@church.local`
- **Role**: Administrator

## 🛠️ Development Commands

### View Logs

```bash
# All services
docker-compose -f docker-compose.dev.yml logs -f

# Specific service
docker-compose -f docker-compose.dev.yml logs -f server
docker-compose -f docker-compose.dev.yml logs -f client
docker-compose -f docker-compose.dev.yml logs -f db
```

### Stop Services

```bash
# Stop all services
docker-compose -f docker-compose.dev.yml down

# Stop and remove volumes (database data)
docker-compose -f docker-compose.dev.yml down -v
```

### Restart Services

```bash
# Restart all services
docker-compose -f docker-compose.dev.yml restart

# Restart specific service
docker-compose -f docker-compose.dev.yml restart server
```

### Rebuild Services

```bash
# Rebuild all services
docker-compose -f docker-compose.dev.yml up --build -d

# Rebuild specific service
docker-compose -f docker-compose.dev.yml up --build -d server
```

## 🔧 Configuration

### Environment Variables

The application uses environment variables for configuration. These are set in the `docker-compose.dev.yml` file:

- **Database**: MariaDB connection settings
- **JWT**: Authentication secret and expiration
- **Email**: Brevo API configuration
- **SMS**: Twilio configuration

### Database

The MariaDB database is automatically initialized with:
- Database schema
- Default admin user
- Sample gathering types

### Volumes

- **Database**: Persistent storage for MariaDB data
- **Uploads**: File uploads from the application
- **Source Code**: Mounted for hot reloading in development

## 🐛 Troubleshooting

### Common Issues

1. **Port Already in Use**
   ```bash
   # Check what's using the ports
   lsof -i :3000 -i :3001 -i :3306
   
   # Stop conflicting services
   docker-compose -f docker-compose.dev.yml down
   ```

2. **Database Connection Issues**
   ```bash
   # Check database logs
   docker-compose -f docker-compose.dev.yml logs db
   
   # Restart database
   docker-compose -f docker-compose.dev.yml restart db
   ```

3. **Build Failures**
   ```bash
   # Clean build
   docker-compose -f docker-compose.dev.yml down
   docker system prune -f
   docker-compose -f docker-compose.dev.yml up --build -d
   ```

### Reset Everything

```bash
# Stop all services and remove everything
docker-compose -f docker-compose.dev.yml down -v
docker system prune -f
docker volume prune -f

# Start fresh
./start.sh
```

## 📁 File Structure

```
Let My People Grow/
├── docker-compose.yml          # Production configuration
├── docker-compose.dev.yml      # Development configuration
├── Dockerfile.client           # Production client build
├── Dockerfile.client.dev       # Development client
├── Dockerfile.server           # Production server
├── Dockerfile.server.dev       # Development server
├── nginx.conf                  # Nginx configuration
├── start.sh                    # Quick start script
├── .dockerignore               # Docker build exclusions
├── server/
│   └── scripts/
│       └── init.sql            # Database initialization
└── client/
    └── ...                     # React application
```

## 🔒 Security Notes

- Default passwords are used for development
- JWT secrets should be changed for production
- API keys are included for development - change for production
- Database is exposed on localhost only

## 🚀 Production Deployment

For production deployment:

1. Change all default passwords and secrets
2. Use environment-specific API keys
3. Configure proper SSL/TLS certificates
4. Set up proper backup strategies
5. Use production Docker Compose file

## 📞 Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review the logs: `docker-compose -f docker-compose.dev.yml logs`
3. Ensure Docker Desktop is running
4. Verify ports 3000, 3001, and 3306 are available

---

**Happy coding! 🎉** 