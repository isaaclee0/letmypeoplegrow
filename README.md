# Let My People Grow

A comprehensive church attendance and member management system designed to help churches track attendance, manage members, and grow their communities.

## Features

### 🏠 **Member Management**
- Add and manage individual members and families
- Track family relationships and groupings
- Import members via CSV upload
- Duplicate detection and management

### 📊 **Attendance Tracking**
- Record attendance for gatherings and services
- Track visitor information
- Family-based attendance views
- Historical attendance data

### 👥 **Gathering Management**
- Create and manage different types of gatherings (Sunday Service, Bible Study, etc.)
- Assign members to specific gatherings
- Track gathering schedules and details

### 🔐 **User Management & Authentication**
- Role-based access control (Admin, Coordinator, Attendance Taker)
- Secure authentication with JWT tokens
- User invitation system via email/SMS
- First-time login setup

### 📈 **Reporting & Analytics**
- Dashboard with attendance trends
- Member engagement reports
- Family attendance patterns
- Export capabilities

### 📱 **Modern Web Interface**
- Responsive React frontend
- Real-time updates
- Intuitive user interface
- Mobile-friendly design

## Tech Stack

### Frontend
- **React 18** with TypeScript
- **Tailwind CSS** for styling
- **Heroicons** for icons
- **Axios** for API communication

### Backend
- **Node.js** with Express
- **MariaDB** database
- **JWT** authentication
- **Docker** containerization

### External Services
- **Brevo** for email notifications
- **Twilio** for SMS notifications
- **Docker Compose** for development environment

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
   
   **Required API Keys:**
   - **Brevo API Key**: For email notifications
   - **Twilio Account SID**: For SMS notifications
   - **Twilio Auth Token**: For SMS notifications  
   - **Twilio Phone Number**: For SMS notifications
   
   **Note**: The `.env` file is excluded from git for security. Never commit your actual API keys.

3. **Start the development environment**
   ```bash
   docker-compose -f docker-compose.dev.yml up -d
   ```

4. **Access the application**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3002
   - Database: localhost:3307

4. **Initial setup**
   - Navigate to http://localhost:3000
   - Complete the onboarding process
   - Create your first admin user

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
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/     # Reusable UI components
│   │   ├── contexts/       # React contexts
│   │   ├── pages/          # Page components
│   │   ├── services/       # API services
│   │   └── types/          # TypeScript types
│   └── public/             # Static assets
├── server/                 # Node.js backend
│   ├── config/             # Configuration files
│   ├── middleware/         # Express middleware
│   ├── routes/             # API routes
│   ├── scripts/            # Database scripts
│   └── utils/              # Utility functions
├── docker-compose.yml      # Production Docker setup
├── docker-compose.dev.yml  # Development Docker setup
└── README.md              # This file
```

## API Documentation

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `POST /api/auth/verify-otc` - Verify OTC code

### Members
- `GET /api/individuals` - Get all members
- `POST /api/individuals` - Create new member
- `PUT /api/individuals/:id` - Update member
- `DELETE /api/individuals/:id` - Delete member

### Attendance
- `GET /api/attendance/:gatheringId/:date` - Get attendance for date
- `POST /api/attendance/:gatheringId/:date` - Record attendance

### Gatherings
- `GET /api/gatherings` - Get all gatherings
- `POST /api/gatherings` - Create gathering
- `PUT /api/gatherings/:id` - Update gathering
- `DELETE /api/gatherings/:id` - Delete gathering

## Environment Variables

### Required Environment Variables
```env
# Database
DB_HOST=localhost
DB_PORT=3306
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=church_password

# JWT
JWT_SECRET=your_secure_jwt_secret
JWT_EXPIRE=30d

# Email (Brevo)
BREVO_API_KEY=your_brevo_api_key
EMAIL_FROM=noreply@yourchurch.org

# SMS (Twilio)
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=+1234567890
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support and questions, please open an issue on GitHub or contact the development team.

## Version History

### v0.1.0 (Current)
- Initial release
- Core member management functionality
- Attendance tracking system
- User authentication and authorization
- Gathering management
- Basic reporting features
- Docker containerization
- Development and production environments

---

**Let My People Grow** - Empowering churches to grow their communities through better member management and attendance tracking. 