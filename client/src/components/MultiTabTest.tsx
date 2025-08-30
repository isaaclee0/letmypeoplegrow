import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useAuth } from '../contexts/AuthContext';

const MultiTabTest: React.FC = () => {
  const { socket, isConnected, connectionStatus, activeUsers } = useWebSocket();
  const { user } = useAuth();
  const [testMessage, setTestMessage] = useState('');
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    if (!socket) return;

    const handleTestMessage = (data: any) => {
      const message = `[${new Date().toLocaleTimeString()}] ${data.message} (from ${data.userEmail})`;
      setMessages(prev => [...prev, message]);
    };

    socket.on('test_message', handleTestMessage);

    return () => {
      socket.off('test_message', handleTestMessage);
    };
  }, [socket]);

  const sendTestMessage = () => {
    if (!socket || !isConnected) {
      alert('WebSocket not connected');
      return;
    }

    socket.emit('send_test_message', {
      message: testMessage,
      timestamp: Date.now()
    });
    setTestMessage('');
  };

  const joinTestRoom = () => {
    if (!socket || !isConnected) {
      alert('WebSocket not connected');
      return;
    }

    socket.emit('join_test_room', {
      userId: user?.id,
      userEmail: user?.email
    });
  };

  return (
    <div className="bg-white p-4 rounded-lg shadow border">
      <h3 className="text-lg font-medium mb-4">Multi-Tab WebSocket Test</h3>
      
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <strong>Connection Status:</strong> {connectionStatus}
          </div>
          <div>
            <strong>Connected:</strong> {isConnected ? 'Yes' : 'No'}
          </div>
          <div>
            <strong>Socket ID:</strong> {socket?.id || 'None'}
          </div>
          <div>
            <strong>Active Users:</strong> {activeUsers.length}
          </div>
        </div>

        <div className="space-y-2">
          <button
            onClick={joinTestRoom}
            disabled={!isConnected}
            className="px-3 py-1 bg-blue-500 text-white rounded text-sm disabled:opacity-50"
          >
            Join Test Room
          </button>
        </div>

        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder="Enter test message..."
              className="flex-1 px-2 py-1 border rounded text-sm"
            />
            <button
              onClick={sendTestMessage}
              disabled={!isConnected || !testMessage.trim()}
              className="px-3 py-1 bg-green-500 text-white rounded text-sm disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>

        <div className="border rounded p-2 h-32 overflow-y-auto">
          <div className="text-xs text-gray-600 mb-2">Messages:</div>
          {messages.length === 0 ? (
            <div className="text-gray-400 text-xs">No messages yet</div>
          ) : (
            <div className="space-y-1">
              {messages.map((msg, index) => (
                <div key={index} className="text-xs bg-gray-50 p-1 rounded">
                  {msg}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="text-xs text-gray-500">
          <strong>Instructions:</strong>
          <ul className="list-disc list-inside mt-1 space-y-1">
            <li>Open this page in multiple tabs</li>
            <li>Click "Join Test Room" in each tab</li>
            <li>Send messages from any tab</li>
            <li>Messages should appear in all tabs</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default MultiTabTest;
