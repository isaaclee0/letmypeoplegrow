# Let My People Grow

A comprehensive church attendance and member management system designed to help churches track attendance, manage members, and grow their communities. Built with a modern tech stack and designed for multi-tenancy, the application supports multiple churches with complete data isolation and security.

## Features

### 🏠 **Member Management**
- Add and manage individual members and families
- Track family relationships and groupings
- Import members via CSV/TSV upload with automatic field mapping
- Bulk edit and merge capabilities
- Member archiving and restoration
- Duplicate detection and management
- Visitor tracking (local and traveller categories)
- Smart visitor timeout (2 weeks for travellers, 6 weeks for locals)
- Elvanto integration for member imports

### 📊 **Attendance Tracking**
- **Standard Mode**: Individual check-ins with present/absent status
  - Family-grouped display
  - Quick add for regulars and visitors
  - Tri-state attendance (present, absent, not-tracking)
- **Headcount Mode**: Simple headcount entry for large gatherings
  - Multiple attendance takers with independent counts
  - Flexible aggregation (separate, combined, or averaged)
- Real-time attendance updates via WebSocket
- Historical attendance data with trend analysis
- Attendance statistics per gathering

### 👥 **Gathering Management**
- Create and manage different types of gatherings (Sunday Service, Bible Study, etc.)
- Flexible scheduling with day of week and frequency
- Start and end time configuration (with auto-calculated defaults)
- Assign members to specific gatherings
- Support for both standard and headcount attendance modes
- Member count and recent visitor statistics per gathering
- Gather links feature for easy sharing

### 🖥️ **Kiosk Mode**
- Self-service check-in interface
- Automatic timeout after configurable end time
- Customizable welcome messages
- Touch-optimized for tablets and mobile devices
- Perfect for lobby or entrance check-in stations

### 🔐 **User Management & Authentication**
- Passwordless authentication (email or SMS one-time codes)
- Role-based access control (Admin, Coordinator, Attendance Taker)
- HTTP-only cookies for secure token storage
- Automatic token refresh
- User invitation system via email/SMS
- First-time login setup
- Multi-church isolation with secure church IDs

### 📈 **Reporting & Analytics**
- Dashboard with attendance trends and growth metrics
- Member engagement reports
- Family attendance patterns
- Visitor conversion tracking
- Export capabilities
- AI-powered insights (optional, requires OpenAI or Anthropic API)
- Chat-based analysis of attendance data

### 📱 **Progressive Web App (PWA)**
- Installable on mobile and desktop
- Offline support with service worker caching
- Automatic update notifications
- Mobile-optimized interface with responsive design
- Touch-friendly controls
- Version tracking and display

### 🔗 **Integrations**
- **Elvanto**: Import members and gatherings
- **Brevo**: Email-based authentication and notifications
- **Crazytel**: SMS-based authentication (replaces Twilio)
- **OpenAI/Anthropic**: AI insights (optional)

### 🛡️ **Security & Multi-Tenancy**
- Complete church data isolation
- Secure church ID system (production uses random hex suffixes)
- All database queries automatically filtered by church_id
- Input validation and sanitization
- SQL injection protection via prepared statements
- Rate limiting (global and per-endpoint)
- CORS configuration for frontend-backend communication

## Tech Stack

### Frontend
- **React 19** with TypeScript
- **Vite** for build tooling
- **React Router v7** for navigation
- **Tailwind CSS** for styling
- **Headless UI** for accessible components
- **Heroicons** for icons
- **Axios** for API communication with interceptors
- **Socket.io Client** for real-time updates
- **React Hook Form + Yup** for form validation
- **Chart.js** for attendance visualization
- **Workbox** for service worker and PWA support

### Backend
- **Node.js** with Express
- **MariaDB 10.6** database with connection pooling
- **JWT** authentication with HTTP-only cookies
- **Socket.io** for WebSocket real-time updates
- **Winston** for structured logging
- **Helmet** for security headers
- **Express Rate Limit** for API protection
- **Docker** containerization

### Infrastructure
- **Docker Compose** for orchestration
- **Nginx** for reverse proxy and routing
- **phpMyAdmin** for database management (dev only)
- **Internal Admin Panel** for troubleshooting (localhost only)

### External Services
- **Brevo** for email notifications (authentication and invitations)
- **Crazytel** for SMS notifications (authentication)
- **OpenAI** or **Anthropic** for AI insights (optional)
- **Elvanto** API for member/gathering imports (optional)
- **Cloudflare Tunnel** for mobile testing (development)

## Quick Start

### Prerequisites
- Docker and Docker Compose
- Node.js 18+ (for local development)
- Git

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/isaaclee0/letmypeoplegrow.git
   cd letmypeoplegrow
   ```

2. **Set up environment variables**
   ```bash
   # Copy the example environment file
   cp server/.env.example server/.env

   # Edit the .env file with your actual API keys
   nano server/.env
   ```

   **Required for Authentication:**
   - **Brevo API Key**: For email-based authentication
   - **Crazytel API Key** (optional): For SMS-based authentication
   - **Crazytel From Number** (optional): Your SMS sender number

   **Optional Integrations:**
   - **OpenAI API Key** or **Anthropic API Key**: For AI insights feature
   - **Elvanto API Key**: For member/gathering imports

   **Note**: The `.env` file is excluded from git for security. Never commit your actual API keys.

3. **Start the development environment**
   ```bash
   docker-compose -f docker-compose.dev.yml up -d
   ```

   This will start all services:
   - React client (port 3000)
   - Node.js server (port 3001)
   - MariaDB database (port 3307 → 3306)
   - Nginx reverse proxy (port 80)
   - phpMyAdmin (port 8080)
   - Admin panel (port 7777, localhost only)

4. **Access the application**
   - **Frontend**: http://localhost:3000 or http://localhost (via Nginx)
   - **Backend API**: http://localhost:3001 (or http://localhost/api via Nginx)
   - **Database**: localhost:3307
   - **phpMyAdmin**: http://localhost:8080
   - **Admin Panel**: http://localhost:7777 (localhost only)

5. **Initial setup**
   - Navigate to http://localhost:3000
   - Complete the onboarding process
   - Create your first admin user
   - Configure church settings

6. **View logs**
   ```bash
   # All services
   docker-compose -f docker-compose.dev.yml logs -f

   # Specific service
   docker-compose -f docker-compose.dev.yml logs -f client
   docker-compose -f docker-compose.dev.yml logs -f server
   ```

### Mobile Testing

To test the application on mobile devices during development:

1. **Install Cloudflare Tunnel** (cloudflared)
   ```bash
   # macOS
   brew install cloudflare/cloudflare/cloudflared

   # Linux
   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
   ```

2. **Start a quick tunnel**
   ```bash
   cloudflared tunnel --url http://localhost:80
   ```

   This will generate a temporary public URL (e.g., `https://xyz.trycloudflare.com`) that you can access from your mobile device.

3. **Alternative: Local network access**
   - Find your computer's local IP address (`ipconfig` on Windows, `ifconfig` on Mac/Linux)
   - Access the app at `http://YOUR_LOCAL_IP:3000` from devices on the same network

### Production Deployment

1. **Build the production images**
   ```bash
   docker-compose build
   ```

2. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your production values
   ```

3. **Start the production environment**
   ```bash
   docker-compose up -d
   ```

## Project Structure

```
letmypeoplegrow/
├── client/                      # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/          # Reusable UI components
│   │   │   ├── people/          # Member management components
│   │   │   └── attendance/      # Attendance components
│   │   ├── contexts/            # React contexts (Auth, Kiosk, PWA)
│   │   ├── hooks/               # Custom React hooks
│   │   ├── pages/               # Page components (routing)
│   │   │   ├── PeoplePage.tsx   # Member management (4,557 lines)
│   │   │   ├── AttendancePage.tsx # Attendance tracking (4,272 lines)
│   │   │   ├── KioskPage.tsx    # Kiosk mode interface
│   │   │   └── AiInsightsPage.tsx # AI chat interface
│   │   ├── services/            # API client services
│   │   │   └── api.ts           # Axios client with interceptors
│   │   └── types/               # TypeScript type definitions
│   ├── public/                  # Static assets
│   └── generate-sw.js           # Service worker generator
├── server/                      # Node.js backend (Express)
│   ├── admin/                   # Internal admin panel
│   ├── config/                  # Configuration files
│   │   └── database.js          # MariaDB connection pool
│   ├── middleware/              # Express middleware
│   │   ├── auth.js              # JWT verification and role checks
│   │   ├── churchIsolation.js   # Multi-tenancy enforcement
│   │   └── security.js          # Input sanitization
│   ├── routes/                  # API routes (RESTful)
│   │   ├── auth.js              # Authentication endpoints
│   │   ├── attendance.js        # Attendance tracking (2,491 lines)
│   │   ├── gatherings.js        # Gathering management
│   │   ├── individuals.js       # Member management
│   │   ├── families.js          # Family management
│   │   ├── reports.js           # Analytics and reports
│   │   └── integrations.js      # External integrations
│   ├── services/                # Business logic services
│   │   └── websocket.js         # Socket.io service
│   ├── scripts/                 # Database and utility scripts
│   │   ├── init.sql             # Database schema
│   │   └── migrations/          # Schema migrations
│   └── utils/                   # Utility functions
│       ├── websocketBroadcast.js # Real-time update broadcasting
│       └── logger.js            # Winston logger setup
├── docs/                        # Documentation
│   ├── SECURITY_MODEL.md        # Church isolation architecture
│   ├── DOCKER_DEVELOPMENT.md    # Docker workflow
│   ├── PWA_UPDATE_SYSTEM.md     # Service worker and PWA
│   └── WEBSOCKET_IMPLEMENTATION.md # Real-time updates
├── nginx-dev.conf               # Nginx config for development
├── docker-compose.yml           # Production Docker setup
├── docker-compose.dev.yml       # Development Docker setup
├── Dockerfile.client            # Client production image
├── Dockerfile.client.dev        # Client development image
├── Dockerfile.server.dev        # Server development image
├── VERSION                      # Version file (synced across app)
├── CLAUDE.md                    # AI assistant project guide
└── README.md                    # This file
```

## API Documentation

All API endpoints require authentication (except `/api/auth/request-code` and `/api/auth/verify-code`) and automatically enforce church isolation.

### Authentication
- `POST /api/auth/request-code` - Request one-time code (email or SMS)
- `POST /api/auth/verify-code` - Verify OTC and receive JWT token
- `POST /api/auth/refresh` - Refresh JWT token
- `POST /api/auth/logout` - Logout and clear token
- `GET /api/auth/me` - Get current user info

### Users
- `GET /api/users` - Get all users for church
- `POST /api/users` - Create/invite new user
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user
- `POST /api/users/:id/resend-invitation` - Resend invitation

### Members (Individuals)
- `GET /api/individuals` - Get all members (supports filtering)
- `GET /api/individuals/:id` - Get single member
- `POST /api/individuals` - Create new member
- `POST /api/individuals/bulk` - Bulk create members (CSV/TSV import)
- `PUT /api/individuals/:id` - Update member
- `DELETE /api/individuals/:id` - Delete member
- `POST /api/individuals/merge` - Merge duplicate members
- `POST /api/individuals/mass-edit` - Bulk edit members

### Families
- `GET /api/families` - Get all families
- `POST /api/families` - Create family
- `PUT /api/families/:id` - Update family
- `DELETE /api/families/:id` - Delete family

### Gatherings
- `GET /api/gatherings` - Get all gatherings
- `GET /api/gatherings/:id` - Get single gathering
- `POST /api/gatherings` - Create gathering
- `PUT /api/gatherings/:id` - Update gathering (includes member counts and stats)
- `DELETE /api/gatherings/:id` - Delete gathering
- `GET /api/gatherings/:id/roster` - Get member roster for gathering
- `POST /api/gatherings/:id/roster` - Update member roster

### Attendance (Standard Mode)
- `GET /api/attendance/:gatheringId/:date` - Get attendance for date
- `POST /api/attendance/toggle/:gatheringId/:date/:individualId` - Toggle attendance
- `POST /api/attendance/visitors` - Add visitor
- `PUT /api/attendance/visitors/:id` - Update visitor
- `DELETE /api/attendance/visitors/:id` - Remove visitor

### Attendance (Headcount Mode)
- `GET /api/attendance/headcount/:gatheringId/:date` - Get headcount for date
- `POST /api/attendance/headcount/:gatheringId/:date` - Submit headcount
- `PUT /api/attendance/headcount/:id` - Update headcount entry
- `DELETE /api/attendance/headcount/:id` - Delete headcount entry

### Reports & Analytics
- `GET /api/reports/dashboard` - Dashboard summary data
- `GET /api/reports/attendance-trends` - Attendance trends over time
- `GET /api/reports/member-engagement` - Member engagement metrics
- `GET /api/reports/visitor-trends` - Visitor conversion metrics

### Settings
- `GET /api/settings` - Get church settings
- `PUT /api/settings` - Update church settings
- `GET /api/settings/visitor-config` - Get visitor thresholds
- `PUT /api/settings/visitor-config` - Update visitor thresholds

### Integrations
- `POST /api/integrations/elvanto/test` - Test Elvanto connection
- `POST /api/integrations/elvanto/import-people` - Import members from Elvanto
- `POST /api/integrations/elvanto/import-gatherings` - Import gatherings from Elvanto

### AI Insights (Optional)
- `POST /api/ai/chat` - Send chat message for AI analysis
- `GET /api/ai/chat-history` - Get chat history
- `DELETE /api/ai/chat-history` - Clear chat history

### WebSocket Events (Real-time)
- `attendance:update` - Attendance record changed
- `visitor:update` - Visitor added/updated/removed
- `headcount:update` - Headcount entry changed
- `roster:update` - Gathering roster changed

## Environment Variables

### Server Environment Variables (server/.env)

```env
# Node Environment
NODE_ENV=development                    # or 'production'
PORT=3001                                # Server port
CLIENT_URL=http://localhost:3000         # Frontend URL for CORS
BASE_URL=http://localhost                # Base URL for links

# Database
DB_HOST=db                               # Use 'db' for Docker, 'localhost' for local
DB_PORT=3306
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=church_password

# JWT Authentication
JWT_SECRET=your_secure_jwt_secret_change_this_in_production
JWT_EXPIRE=30d                           # Token expiration
OTC_EXPIRE_MINUTES=10                    # One-time code expiration
OTC_RESEND_COOLDOWN_SECONDS=60          # Resend cooldown

# Email Service (Brevo) - REQUIRED for authentication
BREVO_API_KEY=your_brevo_api_key
EMAIL_FROM=hello@yourchurch.org

# SMS Service (Crazytel) - OPTIONAL for SMS authentication
CRAZYTEL_API_KEY=your_crazytel_api_key
CRAZYTEL_FROM_NUMBER=+61412345678

# AI Insights - OPTIONAL (choose one)
OPENAI_API_KEY=your_openai_api_key      # For OpenAI GPT models
ANTHROPIC_API_KEY=your_anthropic_api_key # For Claude models

# Elvanto Integration - OPTIONAL
ELVANTO_API_KEY=your_elvanto_api_key

# Logging (Optional - defaults shown)
LOG_LEVEL=info                           # debug, info, warn, error
CONSOLE_LOG_LEVEL=debug                  # Console logging level
HTTP_LOG_MIN_STATUS=400                  # Log HTTP requests >= this status
HTTP_LOG_SLOW_MS=500                     # Log slow requests (milliseconds)
LOG_HTTP_START=false                     # Log HTTP request start

# Development Only
AUTH_DEV_BYPASS=false                    # WARNING: Bypass auth in dev only
```

### Client Environment Variables

These are built into the client at build time:

```env
VITE_APP_VERSION=1.5.3                   # App version (from VERSION file)
PORT=3000                                # Dev server port
CHOKIDAR_USEPOLLING=true                 # File watching in Docker
WATCHPACK_POLLING=true                   # Webpack polling
FAST_REFRESH=false                       # React Fast Refresh
```

### Docker Compose Environment Variables

Set these in your shell before running `docker-compose`:

```bash
VERSION=1.5.3                            # App version (optional, defaults to VERSION file)
```

## Architecture & Key Concepts

### Multi-Tenancy and Church Isolation

The application uses a robust church isolation system to ensure complete data separation between churches:

- **Church ID System**: Each church has a unique `church_id`
  - Development: Simple IDs (e.g., `devch1`, `redcc1`)
  - Production: Secure IDs with format `{base}_{random_hex}` (e.g., `dev_abc123def456`)
- **Middleware Enforcement**: `churchIsolation.js` validates church context on every request
- **Database Filtering**: ALL queries automatically include `WHERE church_id = ?`
- **Token-Based**: Church ID is embedded in JWT tokens and validated server-side

**Critical**: When adding new database tables or queries, ALWAYS include `church_id` filtering.

### Authentication Flow

Passwordless authentication system:

1. User enters email/mobile → Server sends one-time code (OTC) via Brevo/Crazytel
2. User enters code → Server validates and returns JWT token in HTTP-only cookie
3. Client stores nothing (tokens in secure cookies only)
4. Automatic token refresh before expiration
5. All requests include church_id validation

### Real-time Updates

WebSocket-based synchronization for attendance tracking:

- Server broadcasts changes to all connected clients in the same church
- Rooms scoped by `church_id` and `gathering_id`
- Automatic reconnection on disconnect
- Events: `attendance:update`, `visitor:update`, `headcount:update`

### PWA and Service Worker

Progressive Web App features:

- Service worker generated at build time with unique cache names (version + timestamp)
- Offline support for static resources
- Automatic update detection and user notifications
- Install prompts for mobile and desktop
- Version display in UI for troubleshooting

**Build process**: `npm run build` in client directory runs `generate-sw.js` then Vite build.

### Database Schema Highlights

All tables include `church_id` for multi-tenancy:

- **users**: Accounts with role-based permissions (admin, coordinator, attendance_taker)
- **gathering_types**: Services with scheduling, supports attendance_type ('standard' | 'headcount')
- **individuals**: Members and visitors with people_type ('regular' | 'local_visitor' | 'traveller_visitor')
- **families**: Family groupings
- **attendance_sessions**: Session records per gathering per date
- **attendance_records**: Individual check-ins (standard mode)
- **headcount_records**: Headcount entries (headcount mode)
- **visitor_config**: Church-specific visitor timeout thresholds

### Known Large Files (Refactoring Planned)

The codebase has three large files that are functional but could benefit from refactoring:

- `client/src/pages/PeoplePage.tsx` (4,557 lines) - Member management
- `client/src/pages/AttendancePage.tsx` (4,272 lines) - Attendance tracking
- `server/routes/attendance.js` (2,491 lines) - Attendance endpoints

See the refactoring plan in `/Users/isaaclee/.claude/plans/sorted-discovering-swan.md` for details on compartmentalization strategy.

## Documentation

Detailed documentation is available in the `docs/` directory:

- **SECURITY_MODEL.md**: Church isolation and security architecture
- **DOCKER_DEVELOPMENT.md**: Docker development workflow
- **PWA_UPDATE_SYSTEM.md**: Service worker and PWA update flow
- **DATABASE_MIGRATION_GUIDE_SIMPLIFIED.md**: Database schema updates
- **WEBSOCKET_IMPLEMENTATION.md**: Real-time update system
- **DEPLOYMENT.md**: Production deployment guide
- **CLAUDE.md**: AI assistant project guide

## Common Issues and Troubleshooting

### Version Not Updating
If the PWA shows an old version:
1. Check `VERSION` file at project root
2. Verify `VITE_APP_VERSION` is set in docker-compose.dev.yml
3. Rebuild client container: `docker-compose -f docker-compose.dev.yml build client`
4. Clear browser cache and service worker

### Dependencies Not Installing
After adding npm dependencies:
```bash
# Rebuild the affected container
docker-compose -f docker-compose.dev.yml build [client|server]
docker-compose -f docker-compose.dev.yml up -d [client|server]
```

### Database Connection Issues
Check database health:
```bash
docker-compose -f docker-compose.dev.yml exec db mariadb -u church_user -pchurch_password church_attendance
```

### WebSocket Not Connecting
- Verify server is running: `docker-compose -f docker-compose.dev.yml logs -f server`
- Check browser console for connection errors
- Ensure client URL is correctly configured in server/.env

### Church Isolation Not Working
All database queries must include `church_id` filtering. Check:
- Middleware is applied to route
- JWT token includes valid church_id
- Query includes `WHERE church_id = ?` with parameterized value

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

### Getting Help

- **Bug Reports**: Open an issue on GitHub with detailed reproduction steps
- **Feature Requests**: Open an issue with the "enhancement" label
- **Security Issues**: Report privately to the development team
- **General Questions**: Check documentation in `docs/` directory first

### Useful Commands

```bash
# View all logs
docker-compose -f docker-compose.dev.yml logs -f

# Restart a service
docker-compose -f docker-compose.dev.yml restart [service-name]

# Rebuild and restart after code changes
docker-compose -f docker-compose.dev.yml build [service-name]
docker-compose -f docker-compose.dev.yml up -d [service-name]

# Access database directly
docker-compose -f docker-compose.dev.yml exec db mariadb -u church_user -pchurch_password church_attendance

# Run database migrations
cd server && npm run schema:plan

# Access admin panel (localhost only)
http://localhost:7777
```

### Performance Tips

- Use headcount mode for large gatherings (500+ attendees)
- Enable database query caching in production
- Monitor service worker cache size
- Regular database maintenance and indexing

## Version History

### v1.5.3 (Current)
- **Performance Optimization**: Improved database query efficiency
- **Kiosk Enhancements**: End time auto-calculation and better UX
- **Bug Fixes**:
  - Fixed PWA update system and version synchronization
  - Corrected member count to show only active regulars
  - Fixed recent visitor count to match attendance view logic (2 weeks for travellers, 6 weeks for locals)
  - Fixed mobile UI z-index issues for modals
- **Mobile Improvements**:
  - Mobile-optimized AI Insights page with better input and layout
  - Improved responsive design across all pages
- **Features**: Added end time functionality to gatherings with auto-calculation

### v1.5.0
- **Kiosk Mode**: Self-service check-in interface with configurable timeouts
- **PWA Support**: Progressive Web App with offline capabilities and update notifications
- **AI Insights**: Optional AI-powered attendance analysis and chat interface
- **WebSocket Real-time Updates**: Live attendance synchronization across clients
- **Headcount Mode**: Alternative attendance tracking for large gatherings
- **Enhanced Security**: Multi-tenancy with church isolation middleware

### v1.0.0
- **Core Features**:
  - Member and family management with CSV/TSV import
  - Standard attendance tracking with family grouping
  - Visitor management (local and traveller categories)
  - Gathering management with scheduling
  - Role-based user access control
  - Passwordless authentication (email/SMS)
  - Dashboard with attendance trends
- **Integrations**: Elvanto import support
- **Infrastructure**: Full Docker containerization with development and production modes

### v0.1.0
- Initial development release
- Basic member management
- Simple attendance tracking
- User authentication prototype

---

**Let My People Grow** - Empowering churches to grow their communities through better member management and attendance tracking. 