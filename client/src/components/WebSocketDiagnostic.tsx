import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { getWebSocketMode } from '../utils/constants';

interface WebSocketDiagnosticProps {
  showDetails?: boolean;
}

const WebSocketDiagnostic: React.FC<WebSocketDiagnosticProps> = ({ showDetails = false }) => {
  const { socket, isConnected, connectionStatus, getConnectionStats } = useWebSocket();
  const [stats, setStats] = useState<any>(null);
  const webSocketMode = getWebSocketMode();

  useEffect(() => {
    if (socket) {
      const updateStats = () => {
        setStats(getConnectionStats());
      };
      
      updateStats();
      const interval = setInterval(updateStats, 2000);
      return () => clearInterval(interval);
    }
  }, [socket, getConnectionStats]);

  if (!showDetails) {
    return (
      <div className="text-xs text-gray-500">
        WS: {connectionStatus} {isConnected ? '✅' : '❌'}
      </div>
    );
  }

  return (
    <div className="bg-gray-50 p-3 rounded border text-xs">
      <h4 className="font-medium mb-2">WebSocket Diagnostic</h4>
      <div className="space-y-1">
        <div>Status: <span className={isConnected ? 'text-green-600' : 'text-red-600'}>{connectionStatus}</span></div>
        <div>Connected: {isConnected ? 'Yes' : 'No'}</div>
        <div>Mode: {webSocketMode.enabled ? (webSocketMode.fallbackAllowed ? 'WebSocket+Fallback' : 'WebSocket Only') : 'API Only'}</div>
        {stats && (
          <>
            <div>Socket ID: {stats.socketId || 'None'}</div>
            <div>Room: {stats.room || 'None'}</div>
          </>
        )}
        {socket && (
          <>
            <div>Transport: {socket.io?.engine?.transport?.name || 'Unknown'}</div>
            <div>Upgraded: {socket.io?.engine?.upgraded ? 'Yes' : 'No'}</div>
          </>
        )}
      </div>
    </div>
  );
};

export default WebSocketDiagnostic;
