# Docker Development Guide

## Overview
All development work for this project should be done using Docker containers to ensure consistency across environments and avoid "works on my machine" issues.

## Prerequisites
- Docker Desktop installed and running
- Docker Compose installed

## Quick Start

### 1. Start the Application

#### Development Mode (Recommended)
```bash
# Start all services in development mode (with hot reload)
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f

# View logs for specific service
docker-compose -f docker-compose.dev.yml logs -f server
docker-compose -f docker-compose.dev.yml logs -f client
docker-compose -f docker-compose.dev.yml logs -f db
```

#### Production Mode
```bash
# Start all services in production mode
docker-compose up -d

# View logs
docker-compose logs -f
```

### 2. Stop the Application

#### Development Mode
```bash
# Stop all services
docker-compose -f docker-compose.dev.yml down

# Stop and remove volumes (WARNING: This will delete database data)
docker-compose -f docker-compose.dev.yml down -v
```

#### Production Mode
```bash
# Stop all services
docker-compose down

# Stop and remove volumes (WARNING: This will delete database data)
docker-compose down -v
```

## Development Workflow

### Adding New Dependencies

#### Server Dependencies
1. **Edit `server/package.json`** - Add the new dependency
2. **Rebuild the server container**:
   ```bash
   # Development mode
   docker-compose -f docker-compose.dev.yml build server
   docker-compose -f docker-compose.dev.yml up -d server
   
   # Production mode
   docker-compose build server
   docker-compose up -d server
   ```

#### Client Dependencies
1. **Edit `client/package.json`** - Add the new dependency
2. **Rebuild the client container**:
   ```bash
   # Development mode
   docker-compose -f docker-compose.dev.yml build client
   docker-compose -f docker-compose.dev.yml up -d client
   
   # Production mode
   docker-compose build client
   docker-compose up -d client
   ```

### Making Code Changes

#### Server Changes
1. **Edit files in `server/` directory**
2. **Restart the server container** (if using nodemon, changes auto-reload):
   ```bash
   docker-compose restart server
   ```

#### Client Changes
1. **Edit files in `client/` directory**
2. **Changes auto-reload** (React development server with hot reload)

### Database Changes

#### Schema Changes
1. **Edit `server/scripts/init.sql`** - Add new tables, columns, etc.
2. **Reset the database**:
   ```bash
   docker-compose down -v
   docker-compose up -d
   ```

#### Data Changes
1. **Connect to the database**:
   ```bash
   docker-compose exec db mariadb -u church_user -pchurch_password church_attendance
   ```

### Environment Variables

#### Server Environment
- Edit environment variables in `docker-compose.yml` under the `server` service
- Restart the server after changes:
  ```bash
  docker-compose restart server
  ```

#### Client Environment
- Create/edit `client/.env` file
- Rebuild the client container:
  ```bash
  docker-compose build client
  docker-compose up -d client
  ```

## Useful Commands

### Container Management
```bash
# View running containers
docker-compose ps

# View container logs
docker-compose logs [service-name]

# Execute commands in containers
docker-compose exec server npm run dev
docker-compose exec db mariadb -u church_user -pchurch_password church_attendance

# Access container shell
docker-compose exec server sh
docker-compose exec client sh
```

### Database Operations
```bash
# Backup database
docker-compose exec db mariadb-dump -u church_user -pchurch_password church_attendance > backup.sql

# Restore database
docker-compose exec -T db mariadb -u church_user -pchurch_password church_attendance < backup.sql

# Reset database (WARNING: Deletes all data)
docker-compose down -v
docker-compose up -d
```

### Development Mode
```bash
# Use development compose file (if available)
docker-compose -f docker-compose.dev.yml up -d

# Rebuild all containers
docker-compose build --no-cache

# Clean up unused images and containers
docker system prune -a
```

## Troubleshooting

### Common Issues

#### Port Conflicts
If ports 3000, 3001, or 3306 are already in use:
```bash
# Find what's using the port
lsof -i :3000
lsof -i :3001
lsof -i :3306

# Stop conflicting services or change ports in docker-compose.yml
```

#### Container Won't Start
```bash
# Check container logs
docker-compose logs [service-name]

# Check container status
docker-compose ps

# Restart specific service
docker-compose restart [service-name]
```

#### Database Connection Issues
```bash
# Check if database is running
docker-compose ps db

# Check database logs
docker-compose logs db

# Test database connection
docker-compose exec db mariadb -u church_user -pchurch_password -e "SELECT 1"
```

### Performance Issues
```bash
# Monitor resource usage
docker stats

# Clean up Docker system
docker system prune -a
docker volume prune
```

## Best Practices

1. **Always use Docker** - Never install dependencies directly on your host machine
2. **Use volumes for persistence** - Database data and uploads are persisted in Docker volumes
3. **Environment-specific configs** - Use different compose files for dev/staging/production
4. **Regular backups** - Backup the database regularly during development
5. **Clean rebuilds** - Use `--no-cache` when rebuilding to ensure clean builds
6. **Monitor logs** - Always check logs when troubleshooting issues

## File Structure
```
├── docker-compose.yml          # Main compose file
├── docker-compose.dev.yml      # Development compose file (if needed)
├── Dockerfile.server           # Server container definition
├── Dockerfile.client           # Client container definition
├── server/                     # Server source code
│   ├── package.json           # Server dependencies
│   └── ...
├── client/                     # Client source code
│   ├── package.json           # Client dependencies
│   └── ...
└── DOCKER_DEVELOPMENT.md      # This file
```

## Security Notes

- **Never commit sensitive data** - Use environment variables for secrets
- **Use .dockerignore** - Exclude unnecessary files from Docker builds
- **Regular updates** - Keep base images and dependencies updated
- **Production hardening** - Use production-specific security configurations

## Next Steps

1. Set up your development environment using Docker
2. Familiarize yourself with the commands above
3. Always use Docker for development work
4. Refer to this guide when adding new dependencies or making changes 