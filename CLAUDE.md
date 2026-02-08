# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Let My People Grow is a church attendance tracking and member management system with a React/TypeScript frontend, Node.js/Express backend, and MariaDB database. The application is fully containerized using Docker.

## Development Commands

### Running the Application

**Development mode (with hot reload):**
```bash
# Start all services
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f [service-name]

# Stop services
docker-compose -f docker-compose.dev.yml down
```

**Production mode:**
```bash
docker-compose up -d
docker-compose logs -f
docker-compose down
```

### Testing and Building

**Client:**
```bash
cd client
npm start          # Start Vite dev server
npm run build      # Build for production (generates service worker + builds)
npm test           # Run tests
npm run preview    # Preview production build
```

**Server:**
```bash
cd server
npm run dev        # Start with nodemon (auto-reload)
npm start          # Start production server
npm run admin      # Start admin panel (port 7777)
```

### Database Operations

**Schema management:**
```bash
cd server
npm run init-db                  # Initialize database schema
npm run schema:baseline          # Record current schema as baseline
npm run schema:plan              # Generate migration plan from baseline
```

**Database access:**
```bash
# Via Docker
docker-compose -f docker-compose.dev.yml exec db mariadb -u church_user -pchurch_password church_attendance

# Via phpMyAdmin (dev only)
# http://localhost:8080
```

### Adding Dependencies

**ALWAYS rebuild containers after adding dependencies:**
```bash
# Server dependencies
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server

# Client dependencies
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
```

## Architecture

### Multi-Tenancy and Church Isolation

**Critical Security Feature**: The application uses a church isolation system to ensure data separation between different churches.

- **Church ID System**: Each church has a unique `church_id` stored in JWT tokens
  - Development: Simple IDs (e.g., `devch1`, `redcc1`)
  - Production: Secure IDs (e.g., `dev_abc123def456`) with format `{base}_{random_hex}`
- **Middleware Enforcement**: `churchIsolation.js` middleware ensures users only access their church's data
- **Database Filtering**: All queries automatically filter by `church_id`
- **Token-Based**: Church context is embedded in JWT tokens and validated on every request

**IMPORTANT**: When adding new database tables or queries, ALWAYS include `church_id` filtering. See `server/middleware/churchIsolation.js` for the isolation logic.

### Authentication Flow

The application uses a passwordless authentication system:

1. **Request Code**: User enters email/mobile number → server sends OTC (One-Time Code) via Brevo (email) or Crazytel (SMS)
2. **Verify Code**: User enters code → server validates and returns JWT token in HTTP-only cookie
3. **Token Management**: JWT tokens include `userId` and `churchId`, stored in cookies with `httpOnly: true`
4. **Token Refresh**: Automatic refresh via `/api/auth/refresh` endpoint before expiration
5. **Church Isolation**: Middleware validates church_id on every authenticated request

**Key files:**
- `server/routes/auth.js` - Authentication endpoints
- `server/middleware/auth.js` - Token verification and role-based access control
- `client/src/services/api.ts` - API client with automatic token refresh interceptor

### Frontend Architecture

**React 19 + TypeScript + Vite:**
- **Routing**: React Router v7 for navigation
- **State Management**: React Context (AuthContext, KioskContext, PWAUpdateContext)
- **API Client**: Axios with interceptors for token refresh and church isolation
- **UI**: Tailwind CSS + Headless UI components
- **Forms**: React Hook Form + Yup validation
- **Charts**: Chart.js for attendance visualization
- **Real-time**: Socket.io for live attendance updates

**Key patterns:**
- Cache-first loading: Show cached data immediately, then refresh in background
- Optimistic updates: Update UI immediately, rollback on error
- WebSocket updates: Broadcast attendance changes to all connected clients
- PWA support: Service worker for offline functionality and update notifications

### Backend Architecture

**Express + MariaDB:**
- **Database**: MariaDB with connection pooling via `server/config/database.js`
- **Routes**: RESTful API organized by domain (`server/routes/`)
- **Middleware**: Authentication, church isolation, security (Helmet, rate limiting)
- **WebSocket**: Socket.io service for real-time updates (`server/services/websocket.js`)
- **Logging**: Winston for structured logging to files and console

**Route organization:**
- `/api/auth` - Authentication (login, logout, token refresh)
- `/api/users` - User management
- `/api/gatherings` - Service/gathering management
- `/api/attendance` - Attendance tracking (standard + headcount modes)
- `/api/individuals` - Member management
- `/api/families` - Family grouping
- `/api/reports` - Dashboard and analytics
- `/api/settings` - Church configuration
- `/api/integrations` - External integrations (Elvanto)
- `/api/ai` - AI insights (optional feature)

### Database Schema

**Core tables:**
- `users` - User accounts with role-based permissions (admin, coordinator, attendance_taker)
- `gathering_types` - Services/gatherings with scheduling info, supports `attendance_type` ('standard' | 'headcount')
- `individuals` - Church members and visitors with `people_type` ('regular' | 'local_visitor' | 'traveller_visitor')
- `families` - Family groupings
- `attendance_sessions` - Attendance records per gathering per date
- `attendance_records` - Individual attendance (present/absent) for standard mode
- `headcount_records` - Headcount data for headcount mode gatherings
- `visitor_config` - Church-specific visitor thresholds

**ALL tables include `church_id` for multi-tenancy isolation.**

### Attendance System

The application supports two attendance tracking modes:

1. **Standard Mode**: Individual check-ins with present/absent status
   - Family-grouped display
   - Visitor tracking with family grouping
   - Tri-state attendance: present, absent, not-tracking
   - Quick add for regulars and visitors

2. **Headcount Mode**: Simple headcount entry
   - Multiple attendance takers can submit counts independently
   - Supports three aggregation modes:
     - `separate` - Show individual counts
     - `combined` - Sum all counts
     - `averaged` - Average all counts
   - Real-time updates via WebSocket

**Key files:**
- `client/src/pages/AttendancePage.tsx` - Main attendance UI
- `server/routes/attendance.js` - Attendance endpoints
- `server/services/websocket.js` - Real-time updates

### PWA and Service Worker

The application is a Progressive Web App:
- **Service Worker**: Generated at build time with unique cache names
- **Offline Support**: Static resources cached, API requests require network
- **Update Notifications**: Automatic detection and user prompts for new versions
- **Install Prompt**: Can be installed to home screen on mobile/desktop

**Build process:** `npm run build` in client directory runs `generate-sw.js` before Vite build.

### WebSocket Implementation

Real-time updates for attendance tracking:
- Server: `server/services/websocket.js` manages Socket.io connections
- Client: Auto-connects on attendance page, receives live updates
- Events: `attendance:update`, `visitor:update`, `headcount:update`
- Church isolation: Rooms are scoped by `church_id` and `gathering_id`

## Important Patterns and Conventions

### Error Handling

- Backend: Comprehensive error handling with specific error codes
- Frontend: User-friendly error messages, retry logic for network errors
- Authentication: Automatic token refresh, graceful fallback to login
- Database: Transaction support for multi-step operations

### Security Practices

1. **Input Validation**: All inputs sanitized via `server/middleware/security.js`
2. **SQL Injection Protection**: Prepared statements for all queries
3. **Rate Limiting**: Global and endpoint-specific rate limits
4. **CORS**: Configured for frontend-backend communication
5. **HTTP-Only Cookies**: Tokens stored securely, not accessible via JavaScript
6. **Church Isolation**: Enforced at middleware and database levels

### Naming Conventions

- **Database**: snake_case (e.g., `church_id`, `gathering_type_id`)
- **API Routes**: kebab-case (e.g., `/api/gathering-types`, `/api/advanced-migrations`)
- **TypeScript/React**: camelCase for variables, PascalCase for components
- **Files**: PascalCase for React components, camelCase for utilities

### Version Management

- Version stored in `VERSION` file at project root
- Synchronized across client and server package.json files
- Displayed in UI for troubleshooting
- Built into Docker images at build time

## External Services

**Email (Brevo):**
- Required for email-based authentication
- Configure: `BREVO_API_KEY` in `server/.env`

**SMS (Crazytel):**
- Optional for SMS-based authentication
- Configure: `CRAZYTEL_API_KEY` and `CRAZYTEL_FROM_NUMBER` in `server/.env`

**AI Insights (Optional):**
- Supports OpenAI or Anthropic
- Configure via Settings page in UI
- Not required for core functionality

**Elvanto Integration (Optional):**
- Import members and gatherings from Elvanto
- API key-based authentication
- Configure via Integrations page

## Database Migrations

The system uses a custom migration framework:

1. **Baseline**: Record current schema state (`npm run schema:baseline`)
2. **Plan**: Generate SQL migration from baseline (`npm run schema:plan`)
3. **Review**: Review generated SQL in `server/scripts/migrations/`
4. **Apply**: Manually apply SQL or use migration endpoints

**Important**: Always test migrations on development database first. See `docs/DATABASE_MIGRATION_GUIDE_SIMPLIFIED.md` for details.

## Docker Configuration

**Services:**
- `client` - React frontend (port 3000)
- `server` - Node.js backend (port 3001)
- `nginx` - Reverse proxy (port 80) - routes `/api` to server, `/` to client
- `db` - MariaDB database (port 3307 mapped to 3306)
- `phpmyadmin` - Database admin (port 8080, dev only)
- `admin` - Internal admin panel (port 7777, localhost only)

**Environment files:**
- `server/.env` - Server configuration (API keys, database credentials)
- `docker-compose.dev.yml` - Development configuration
- `docker-compose.yml` - Production configuration

**Data persistence:**
- Database: `db_data_dev` volume
- Uploads: `server/uploads` directory mounted

## Admin Panel

Internal admin panel accessible at `http://localhost:7777` (dev only):
- Direct database access for troubleshooting
- Church management
- System health checks
- Accessible only from localhost for security

## Common Gotchas

1. **Church ID Required**: When adding new database tables, ALWAYS include `church_id` column and filtering
2. **Docker Rebuilds**: After adding npm dependencies, rebuild the Docker container
3. **Token Cookies**: Authentication uses HTTP-only cookies, not localStorage or Authorization headers
4. **WebSocket Rooms**: Always scope WebSocket events by church_id to prevent cross-church leaks
5. **PWA Caching**: Static assets are cached; clear service worker cache when debugging frontend issues
6. **Rate Limiting**: Be aware of rate limits when testing authentication flows
7. **Service Worker**: Must be regenerated on build - run `npm run build`, not just `vite build`

## Documentation Reference

Key documentation files in `docs/`:
- `SECURITY_MODEL.md` - Church isolation and security architecture
- `DOCKER_DEVELOPMENT.md` - Docker development workflow
- `PWA_UPDATE_SYSTEM.md` - Service worker and PWA update flow
- `DATABASE_MIGRATION_GUIDE_SIMPLIFIED.md` - Database schema updates
- `WEBSOCKET_IMPLEMENTATION.md` - Real-time update system
- `DEPLOYMENT.md` - Production deployment guide

## Useful Ports

- 3000 - Client (frontend)
- 3001 - Server (backend API)
- 3002 - Server (alternate port in some configs)
- 3307 - Database (MariaDB)
- 7777 - Admin panel (localhost only)
- 8080 - phpMyAdmin (dev only)
- 80 - Nginx (reverse proxy)
