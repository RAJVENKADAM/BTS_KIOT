# Bus Tracking System (BTS)

A comprehensive Bus Tracking System with Node.js backend and React Native frontend.

## Project Structure

```
BTS/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   └── db.js
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── routes/
│   │   ├── services/
│   │   └── app.js
│   ├── server.js
│   ├── .env
│   ├── .gitignore
│   └── package.json
└── frontend/
    ├── src/
    │   ├── api/
    │   │   └── api.js
    │   ├── auth/
    │   ├── components/
    │   ├── context/
    │   ├── navigation/
    │   ├── screens/
    │   │   └── SplashScreen.js
    │   ├── services/
    │   └── utils/
    ├── App.js
    ├── app.json
    ├── babel.config.js
    ├── .gitignore
    └── package.json
```

## Features Implemented

### Backend (Node.js + Express)
- Health check API endpoint (`GET /health`)
- Database configuration with MySQL
- CORS support
- Environment variable configuration
- Proper folder structure for scalability

### Frontend (React Native)
- Splash screen displaying "BTS App"
- Basic project structure for future development
- API service setup for backend communication
- Expo configuration for cross-platform development

## Setup Instructions

### Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Update database credentials and other settings

4. Start the server:
   ```bash
   npm start
   ```
   or for development with auto-reload:
   ```bash
   npm run dev
   ```

5. Test the health check API:
   ```bash
   curl http://localhost:5000/health
   ```

### Frontend Setup

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Install web dependencies (if developing for web):
   ```bash
   npx expo install react-native-web react-dom @expo/metro-runtime
   ```

4. Start the development server:
   ```bash
   npx expo start
   ```

5. For web development:
   ```bash
   npx expo start --web
   ```

6. For mobile development:
   - Install Expo Go app on your device
   - Scan the QR code from the terminal

## API Endpoints

### Health Check
- **Endpoint**: `GET /health`
- **Response**: 
  ```json
  {
    "status": "OK",
    "message": "BTS Backend is running"
  }
  ```

## Home Page with Google Maps

### Interactive Map Interface

- **Full-screen Google Maps**: Real-time map display with bus tracking
- **Fixed Destination Marker**: Static marker at coordinates 11.55, 78.02
- **Bus Search**: Search functionality to locate specific buses
- **Visual Indicators**: Online buses show animated green markers, offline buses show red markers at last known location
- **Interactive Features**: Bottom sheet with bus details and plan selection

### Map Elements

- **Online Buses**: Animated green markers showing real-time location
- **Offline Buses**: Red markers showing last known location
- **Destination Marker**: Fixed red marker at 11.55, 78.02
- **Route Visualization**: Shows planned routes when a plan is selected

### Bottom Sheet Details

- **Bus Information**: Bus number, status (online/offline), driver name
- **Performance Metrics**: Speed, distance to destination, estimated time of arrival
- **Plan Selection**: Click current plan to view and select different route plans
- **Stop Display**: Shows stops for selected plan when clicked

### API Endpoints

- `GET /api/bus/location/:busNo`: Get live location for specific bus (permission-based)
- `GET /api/bus/route/:busNo/:planName`: Get route stops for specific bus and plan

### Frontend Components

- **Home Screen**: Search bar and map interface
- **Map Component**: Google Maps integration with animated markers
- **Bottom Sheet**: Detailed bus information panel

### Security Features

- Role-based access control for bus location viewing
- Permission validation for route information
- Secure JWT authentication for all endpoints

## TrackMe Page

### Live Bus Tracking

- **Start/Stop Tracking**: Primary Admins can toggle tracking on/off
- **Background Location**: Uses device GPS for continuous location tracking
- **Real-time Updates**: Emits live location via Socket.IO to appropriate rooms
- **Database Integration**: Updates bus_live_location table with current coordinates
- **Online/Offline Handling**: Tracks and displays bus availability status

### API Endpoints

- `PUT /api/track/location`: Update user's live location (Primary Admin only)
- `GET /api/track/location/:busNo`: Get live location for specific bus (permission-based)
- `POST /api/track/toggle-tracking`: Toggle tracking status (Primary Admin only)

### Frontend Interface

- **TrackMe Screen**: Mobile-optimized tracking interface
- **Location Service**: Background location tracking with permission handling
- **Real-time Status**: Shows online/offline status and last known location
- **Bus Assignment**: Respects user's assigned bus for tracking

### Security Features

- Role-based access control for tracking features
- Permission validation for location viewing
- Secure JWT authentication for all endpoints

## Messaging System

### Real-time Communication

- **Real-time Messages**: Uses Socket.IO for instant message delivery
- **Role-based Visibility**: Superadmins see all messages, primary admins see own bus messages
- **Message Types**: General (plan changes), All, and My Bus tabs
- **Message Storage**: All messages stored in database for persistence

### API Endpoints

- `GET /api/messages/`: Get messages based on user role
- `GET /api/messages/general`: Get general messages (plan changes, etc.)
- `GET /api/messages/my-bus`: Get messages for user's bus
- `POST /api/messages/`: Send message (restricted by role)

### Frontend Interface

- **Messages Screen**: Tabbed interface (General, All, My Bus)
- **Message Card Component**: Displays messages with metadata
- **Role-based Actions**: Only admins can send messages
- **Real-time Updates**: Instant message delivery via Socket.IO

### Security Features

- Role-based message visibility
- Permission checks for sending messages
- Proper authentication required for all endpoints

## Plan Change and Auto Message

### Superadmin API

- **Plan Change Endpoint**: `PUT /api/bus/change-plan/:busNo` (Superadmin only)
- **Current Plan Endpoint**: `GET /api/bus/current-plan/:busNo` (All authenticated users)
- **Auto Message Creation**: Automatically generates message "Today bus <bus_no> is operated in <plan>"
- **Message Storage**: Saves messages in database with user reference

### Database Schema

- **messages table**: Stores auto-generated and manual messages
- **bus_routes table**: Updated with current_plan field to track active plan

### Frontend Interface

- **Plan Selection Modal**: Modal interface in BusCard for plan selection
- **Change Plan Button**: Dedicated button for plan change operation
- **Real-time Updates**: Reflects current plan status

### Security Features

- Superadmin role required for plan changes
- All authenticated users can view current plan
- Proper input validation and sanitization

## Bus Creation and Routes Management

### Superadmin API

- **Upload Endpoint**: `POST /api/bus/upload-bus-routes` (Superadmin only)
- **Delete Endpoint**: `DELETE /api/bus/delete-bus/:busNo` (Superadmin only)
- **File Format**: Excel (.xlsx) with columns: BusNo and Plan A, Plan B, etc.
- **Authentication**: JWT token with Superadmin role required

### Processing Logic

1. **Excel Format**: Must contain BusNo column and at least one Plan column (Plan A, Plan B, etc.)
2. **Bus Creation/Update**:
   - If bus exists → Updates routes
   - If new → Creates bus with routes
3. **Route Plans**: Supports multiple route plans per bus (e.g., Plan A, Plan B)
4. **Stops Organization**: Each row represents a stop in sequence order

### Database Schema

- **bus_routes table**: Stores route information with foreign key to users(bus_no)
- **Fields**: id, bus_no, plan_name, stop_name, stop_order, timestamps

### Frontend Interface

- **AddBusesScreen**: Superadmin-only screen for bus management
- **BusCard Component**: Displays bus information and actions
- **ExcelUpload Component**: Reused from user management for consistency

### Security Features

- Superadmin role required for access
- Proper foreign key constraints
- Input validation and sanitization

## Excel Upload – User Management

### Superadmin API

- **Upload Endpoint**: `POST /api/organize/upload-excel-users` (Superadmin only)
- **File Format**: Excel (.xlsx) with columns: name, email, busno, role
- **Authentication**: JWT token with Superadmin role required

### Processing Logic

1. **Email Validation**: Checks for valid email format
2. **Duplicate Prevention**: Validates for duplicate emails within Excel file
3. **User Creation/Update**:
   - If email exists → Updates user information
   - If new → Creates user with temporary password
4. **User Deactivation**: Sets `is_active = false` for users not in Excel
5. **Role Normalization**: Converts role values to valid options (USER, PRIMARY_ADMIN, SUPERADMIN)

### Email Notifications

- **New Users**: Receive temporary password via email
- **Updated Users**: Receive account update notification

### Excel Format Requirements

The Excel file must contain these columns:
- `name` - User's full name
- `email` - Valid email address (used as unique identifier)
- `busno` - Assigned bus number (optional)
- `role` - User role (USER, PRIMARY_ADMIN, SUPERADMIN)

### Frontend Interface

- **AddUsersScreen**: Superadmin-only screen for Excel uploads
- **ExcelUpload Component**: Handles file selection and upload
- **Validation**: Shows processing instructions and validation requirements

### Security Features

- Superadmin role required for access
- Duplicate email prevention
- Input validation and sanitization
- Secure temporary password generation

## Force Password Change for Temporary Passwords

### Password Policy

When a user account is created with a temporary password (`temp_password = true`), the system enforces a mandatory password change before allowing access to protected features.

### Backend API

- **Change Password Endpoint**: `PUT /api/auth/change-password` (protected)
- **Requires Authentication**: JWT token in Authorization header
- **Request Body**:
  ```json
  {
    "currentPassword": "current_temp_password",
    "newPassword": "new_secure_password"
  }
  ```
- **Response**:
  ```json
  {
    "message": "Password changed successfully"
  }
  ```

### Frontend Behavior

- **Automatic Redirect**: Users with `temp_password = true` are redirected to ChangePasswordScreen upon login
- **Mandatory Change**: Users cannot access other app features until password is changed
- **Status Update**: After successful change, `temp_password` is set to `false`

### Security Features

- Password strength validation (minimum 6 characters)
- Current password verification
- Secure password hashing (bcrypt with 12 salt rounds)
- Proper error handling and validation

## Authentication System

### Backend Authentication

The authentication system uses JWT tokens with bcrypt password hashing:

- **Login Endpoint**: `POST /api/auth/login`
- **Profile Endpoint**: `GET /api/auth/profile` (protected)
- **Logout Endpoint**: `POST /api/auth/logout` (protected)

#### Login Request
```json
{
  "email": "rajvenkadam@gmail.com",
  "password": "Raj@210"
}
```

#### Login Response
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "name": "Raj Venkadam",
    "email": "rajvenkadam@gmail.com",
    "role": "SUPERADMIN",
    "bus_no": null,
    "temp_password": true
  }
}
```

### Frontend Authentication

The frontend implements:

- **AuthContext**: Global authentication state management
- **LoginScreen**: User authentication interface
- **Protected Routes**: Automatic token validation
- **Persistent Storage**: AsyncStorage for token persistence

#### Auth Context Features
- Automatic token loading on app start
- Login/logout functionality
- User data persistence
- Loading state management

### Security Features

- Passwords hashed with bcrypt (12 salt rounds)
- JWT tokens with 24-hour expiration
- Role-based access control
- Account activation checks
- Temporary password flags

### Testing Authentication

Use the following credentials for testing:

**SUPERADMIN User**
- Email: rajvenkadam@gmail.com
- Password: Raj@210
- Role: SUPERADMIN
- Status: Active with temporary password

## Database Setup

### Prerequisites
1. Install MySQL Server (version 8.0 or higher)
2. Ensure MySQL service is running
3. Have MySQL root password ready

### Database Configuration

1. Update `.env` file with your MySQL credentials:
   ```
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=your_mysql_root_password
   DB_NAME=bts_db
   ```

2. Create the database and tables:
   ```bash
   cd backend
   npm run db:setup
   ```

3. Verify the setup:
   ```bash
   npm run db:test
   ```

### Manual Database Setup (Alternative)

If the automated setup fails, you can manually create the database:

1. Connect to MySQL:
   ```bash
   mysql -u root -p
   ```

2. Run the SQL script:
   ```sql
   SOURCE backend/src/config/db.sql;
   ```

### SUPERADMIN User Credentials

The database setup automatically creates a SUPERADMIN user:

- **Email**: rajvenkadam@gmail.com
- **Password**: Raj@210
- **Role**: SUPERADMIN
- **Status**: Active with temporary password

### Database Schema

The `users` table includes the following fields:
- `id`: Primary key, auto-incrementing integer
- `name`: User's full name (VARCHAR 100)
- `email`: Unique email address (VARCHAR 150)
- `password_hash`: BCrypt hashed password (VARCHAR 255)
- `role`: User role (ENUM: USER, PRIMARY_ADMIN, SUPERADMIN)
- `bus_no`: Assigned bus number (VARCHAR 50, optional)
- `is_active`: Account status (BOOLEAN, default TRUE)
- `temp_password`: Indicates if password needs to be changed (BOOLEAN, default TRUE)
- `created_at`: Timestamp of record creation
- `updated_at`: Timestamp of last update

### Database Management Scripts

The backend includes several helpful scripts:

- `npm run db:setup` - Creates database and tables, seeds SUPERADMIN user
- `npm run db:test` - Verifies database connection and SUPERADMIN user
- `npm run db:hash` - Generates bcrypt hash for passwords

### Troubleshooting

**Common Database Issues:**

1. **Access denied for user**
   - Verify MySQL service is running
   - Check username and password in `.env`
   - Ensure user has proper privileges

2. **Database connection failed**
   - Confirm MySQL server is accessible
   - Check firewall settings
   - Verify port 3306 is open

3. **Table already exists**
   - The setup script handles this automatically
   - Existing data will be preserved

4. **Hash verification failed**
   - Regenerate hash using `npm run db:hash`
   - Update the SQL script with new hash

### Backend (.env)
```
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=bts_db
JWT_SECRET=your_jwt_secret_key_here
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password_here
```

## Dependencies

### Backend
- express: Web framework
- cors: Cross-origin resource sharing
- dotenv: Environment variable management
- mysql2: MySQL database client
- bcryptjs: Password hashing
- jsonwebtoken: JWT token generation

### Frontend
- react: Core library
- react-native: Mobile development framework
- expo: Development platform
- @react-native-async-storage/async-storage: Persistent storage

## Development

### Backend Development
- Uses nodemon for automatic restarts during development
- Follows MVC pattern with separate folders for controllers, services, etc.
- Environment-based configuration

### Frontend Development
- Expo managed workflow
- Component-based architecture
- Ready for navigation implementation

## Testing

### Backend Testing
The health check API can be tested with:
```bash
curl http://localhost:5000/health
```

Expected response:
```json
{"status":"OK","message":"BTS Backend is running"}
```

### Frontend Testing
- Splash screen displays "BTS App" and "Bus Tracking System"
- Loading indicator animation
- Responsive design for different screen sizes

## Future Enhancements

### Backend
- User authentication and authorization
- Bus route management APIs
- Real-time tracking with WebSocket
- Admin dashboard APIs
- Data analytics endpoints

### Frontend
- User authentication screens
- Map integration for bus tracking
- Route selection interface
- Real-time location updates
- Push notifications

## Troubleshooting

### Common Issues

1. **Port already in use**
   - Change PORT in `.env` file
   - Or kill the process using the port

2. **Database connection failed**
   - Verify MySQL server is running
   - Check database credentials in `.env`
   - Ensure database exists

3. **Frontend not connecting to backend**
   - Verify backend is running
   - Check API_BASE_URL in frontend configuration
   - Ensure CORS is properly configured

4. **Expo development server issues**
   - Clear cache: `npx expo start -c`
   - Update Expo CLI: `npm install -g expo-cli`
   - Check firewall settings

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details.