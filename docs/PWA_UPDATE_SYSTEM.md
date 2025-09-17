# PWA Update System - Let My People Grow

## Overview
This document explains the Progressive Web App (PWA) update notification system implemented in Let My People Grow. The system automatically detects when updates are available and notifies users to refresh their app.

## 🎯 How It Works

### 1. **Service Worker Registration**
- The app registers a service worker on load
- Service worker caches app resources for offline use
- When a new version is deployed, the service worker detects the change

### 2. **Update Detection**
- Service worker compares cached resources with new server resources
- When differences are found, it triggers an update notification
- The app shows a notification banner to users

### 3. **User Notification**
- Users see a notification in the bottom-right corner
- They can choose to "Refresh Now" or "Later"
- Refreshing activates the new service worker and loads updated content

## 📁 Files Added/Modified

### New Files
- `client/src/serviceWorker.ts` - Service worker registration logic
- `client/src/contexts/PWAUpdateContext.tsx` - React context for PWA updates
- `client/src/components/PWAUpdateNotification.tsx` - Update notification UI
- `client/src/components/PWAUpdateTest.tsx` - Testing component (development only)
- `client/public/sw.js` - Service worker file
- `client/scripts/generate-sw.js` - Service worker generation script

### Modified Files
- `client/src/App.tsx` - Added PWA update provider and notification
- `client/package.json` - Added build script for service worker generation
- `client/vite.config.ts` - Updated build configuration

## 🔧 Configuration

### Service Worker Generation
The service worker is automatically generated during the build process with a unique cache name to ensure updates are detected:

```bash
npm run build  # This runs: node scripts/generate-sw.js && vite build
```

### Cache Strategy
- **Static Resources**: Cached for offline use (HTML, CSS, JS, images)
- **API Requests**: Never cached (always fetch fresh data)
- **Cache Cleanup**: Old caches are automatically deleted on activation

## 🚀 Usage

### For Users
1. **Automatic Detection**: Updates are detected automatically when the app loads
2. **Notification**: Users see a notification when updates are available
3. **One-Click Update**: Click "Refresh Now" to apply updates immediately
4. **Dismiss**: Click "Later" to dismiss the notification

### For Developers
1. **Build Process**: Service worker is generated automatically during build
2. **Testing**: Use the PWAUpdateTest component in development
3. **Manual Trigger**: Call `performUpdate()` from the PWA context

## 🧪 Testing

### Development Testing
```tsx
import PWAUpdateTest from './components/PWAUpdateTest';

// Add to any page for testing
<PWAUpdateTest />
```

### Manual Testing
1. Deploy a new version
2. Open the app in a browser
3. The update notification should appear
4. Click "Refresh Now" to test the update process

## 🔍 Troubleshooting

### Common Issues

#### Update Not Detected
- Check that the service worker is registered in browser dev tools
- Verify the cache name changes between builds
- Ensure the service worker file is being served correctly

#### Notification Not Showing
- Check that the PWAUpdateProvider is wrapping the app
- Verify the service worker is calling the onUpdate callback
- Check browser console for any errors

#### Cache Issues
- Clear browser cache and service worker storage
- Check that old caches are being cleaned up properly
- Verify the cache strategy is working as expected

### Debug Commands
```bash
# Generate service worker manually
npm run generate-sw

# Check service worker registration
# Open browser dev tools > Application > Service Workers
```

## 📱 PWA Features

### Offline Support
- App resources are cached for offline use
- API requests still require internet connection
- Basic app functionality works without network

### Install Prompt
- Users can install the app to their home screen
- Works on both mobile and desktop devices
- Provides native app-like experience

### Update Management
- Automatic update detection
- User-friendly update notifications
- Seamless update process

## 🔒 Security Considerations

### Service Worker Scope
- Service worker only handles GET requests
- API requests are never cached
- Sensitive data is not stored in cache

### Cache Validation
- Only valid responses are cached
- Failed requests are not cached
- Cache is cleaned up regularly

## 📈 Performance Impact

### Benefits
- Faster app loading from cache
- Reduced server load
- Better offline experience

### Considerations
- Initial cache population on first load
- Service worker registration overhead
- Cache storage usage

## 🎨 Customization

### Notification Styling
The update notification can be customized by modifying `PWAUpdateNotification.tsx`:

```tsx
// Change position
<div className="fixed bottom-4 right-4 z-50">

// Change colors
<button className="bg-primary-600 hover:bg-primary-700">

// Change text
<h3 className="text-sm font-medium text-gray-900">
  Update Available
</h3>
```

### Service Worker Behavior
Modify `sw.js` to change caching behavior:

```javascript
// Change cache strategy
const CACHE_NAME = 'let-my-people-grow-v1';

// Add more resources to cache
const urlsToCache = [
  '/',
  '/manifest.json',
  // Add more URLs here
];
```

## 🔄 Update Flow

1. **Deploy**: New version is deployed to server
2. **Detection**: Service worker detects new resources
3. **Notification**: App shows update notification
4. **User Action**: User clicks "Refresh Now"
5. **Activation**: New service worker activates
6. **Reload**: Page reloads with updated content

This system ensures users always have the latest version of the app while providing a smooth update experience.
