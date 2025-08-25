import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useAuth } from '../contexts/AuthContext';

const WebSocketTestPage: React.FC = () => {
  console.log('🧪 WebSocketTestPage - Component rendered');
  
  const { socket, isConnected, connectionStatus } = useWebSocket();
  const { user } = useAuth();
  const [messages, setMessages] = useState<string[]>([]);
  const [testMessage, setTestMessage] = useState('');
  const [connectionDetails, setConnectionDetails] = useState<any>(null);

  console.log('🧪 WebSocketTestPage - State:', {
    socket: !!socket,
    isConnected,
    connectionStatus,
    user: user?.email,
    messagesCount: messages.length
  });

  useEffect(() => {
    if (!socket) return;

    // Log connection details when socket changes
    const details = {
      connected: socket.connected,
      id: socket.id,
      userId: user?.id,
      userEmail: user?.email,
      timestamp: new Date().toISOString()
    };
    setConnectionDetails(details);
    console.log('🔌 WebSocket Test - Connection Details:', details);

    // Listen for test messages
    const handleTestMessage = (data: any) => {
      const message = `[${new Date().toLocaleTimeString()}] Received: ${JSON.stringify(data)}`;
      console.log('📨 WebSocket Test - Message received:', data);
      console.log('📨 Current browser/tab info:', {
        userAgent: navigator.userAgent.substr(0, 50),
        socketId: socket?.id,
        connected: socket?.connected
      });
      setMessages(prev => [...prev, message]);
    };

    socket.on('test_message', handleTestMessage);
    socket.on('test_echo', handleTestMessage);

    // Listen for connection events
    const handleConnect = () => {
      const msg = `[${new Date().toLocaleTimeString()}] ✅ Connected with socket ID: ${socket.id}`;
      console.log('🔌 WebSocket Test - Connected:', socket.id);
      setMessages(prev => [...prev, msg]);
    };

    const handleDisconnect = (reason: string) => {
      const msg = `[${new Date().toLocaleTimeString()}] ❌ Disconnected: ${reason}`;
      console.log('🔌 WebSocket Test - Disconnected:', reason);
      setMessages(prev => [...prev, msg]);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('test_message', handleTestMessage);
      socket.off('test_echo', handleTestMessage);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, [socket, user]);

  const sendTestMessage = () => {
    if (!socket || !testMessage.trim()) return;

    const messageData = {
      message: testMessage,
      userId: user?.id,
      userEmail: user?.email,
      timestamp: new Date().toISOString(),
      socketId: socket.id
    };

    console.log('📤 WebSocket Test - Sending message:', messageData);
    socket.emit('test_message', messageData);
    
    const sentMsg = `[${new Date().toLocaleTimeString()}] 📤 Sent: ${testMessage}`;
    setMessages(prev => [...prev, sentMsg]);
    setTestMessage('');
  };

  const clearMessages = () => {
    setMessages([]);
  };

  const getConnectionStatusColor = () => {
    if (isConnected) return 'text-green-600';
    if (connectionStatus === 'connecting') return 'text-yellow-600';
    return 'text-red-600';
  };

  const getConnectionStatusText = () => {
    if (isConnected) return '🟢 Connected';
    if (connectionStatus === 'connecting') return '🟡 Connecting...';
    return '🔴 Disconnected';
  };

  // Early return for debugging if user not found
  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-4xl mx-auto px-4">
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h1 className="text-2xl font-bold text-gray-900 mb-6">
              WebSocket Connection Test
            </h1>
            <div className="bg-red-50 rounded-lg p-4">
              <p className="text-red-700">❌ No user found - please log in first</p>
              <p className="text-sm text-red-600 mt-2">
                Navigate to <a href="/attendance" className="underline">/attendance</a> to log in
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-6">
            WebSocket Connection Test
          </h1>

          {/* Connection Status */}
          <div className="bg-gray-100 rounded-lg p-4 mb-6">
            <h2 className="text-lg font-semibold mb-3">Connection Status</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className={`font-medium ${getConnectionStatusColor()}`}>
                  Status: {getConnectionStatusText()}
                </p>
                <p className="text-sm text-gray-600">
                  User: {user?.email} (ID: {user?.id})
                </p>
                <p className="text-sm text-gray-600">
                  Socket ID: {socket?.id || 'Not connected'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">
                  Connection Type: {connectionStatus}
                </p>
                {connectionDetails && (
                  <p className="text-sm text-gray-600">
                    Connected At: {new Date(connectionDetails.timestamp).toLocaleTimeString()}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Test Message Sender */}
          <div className="bg-blue-50 rounded-lg p-4 mb-6">
            <h2 className="text-lg font-semibold mb-3">Send Test Message</h2>
            <div className="flex gap-2">
              <input
                type="text"
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && sendTestMessage()}
                placeholder="Enter test message..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={!isConnected}
              />
              <button
                onClick={sendTestMessage}
                disabled={!isConnected || !testMessage.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
          </div>

          {/* Message Log */}
          <div className="bg-gray-100 rounded-lg p-4">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-lg font-semibold">Message Log</h2>
              <button
                onClick={clearMessages}
                className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
              >
                Clear
              </button>
            </div>
            <div className="bg-white rounded border max-h-96 overflow-y-auto p-3">
              {messages.length === 0 ? (
                <p className="text-gray-500 italic">No messages yet...</p>
              ) : (
                messages.map((message, index) => (
                  <div
                    key={index}
                    className="py-1 px-2 text-sm font-mono border-b border-gray-100 last:border-b-0"
                  >
                    {message}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Debug Info */}
          {connectionDetails && (
            <div className="mt-6 bg-yellow-50 rounded-lg p-4">
              <h3 className="text-sm font-semibold mb-2">Debug Info</h3>
              <pre className="text-xs text-gray-700 overflow-auto">
                {JSON.stringify(connectionDetails, null, 2)}
              </pre>
            </div>
          )}

          {/* Instructions */}
          <div className="mt-6 bg-green-50 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-2">Test Instructions</h3>
            <ol className="text-sm text-gray-700 space-y-1">
              <li>1. Open this page in multiple tabs with the same user</li>
              <li>2. Check if both tabs connect successfully</li>
              <li>3. Send messages from one tab and see if others receive them</li>
              <li>4. Monitor the console for detailed WebSocket logs</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WebSocketTestPage;
