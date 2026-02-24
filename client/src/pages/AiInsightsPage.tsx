import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { aiAPI } from '../services/api';
import {
  PaperAirplaneIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
  Cog6ToothIcon,
  PlusIcon,
  TrashIcon,
  ChatBubbleLeftRightIcon,
  Bars3Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: Date;
  errorType?: string;
}

interface Conversation {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

const SUGGESTED_QUESTIONS = [
  'Who has missed the last 3 weeks?',
  'What are the attendance trends over the past month?',
  'Which families have been most consistent?',
  'Are there any visitors who have been coming regularly?',
  'Give me a summary of last Sunday\'s attendance.',
  'Who are the new people added recently?',
];

const AiInsightsPage: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Chat history state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<number | null>(null);
  const [showSidebar, setShowSidebar] = useState(false); // Default to false for mobile-first
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; title: string } | null>(null);
  const [showHistoryMobile, setShowHistoryMobile] = useState(false);

  // Check AI status on mount
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await aiAPI.getStatus();
        setAiConfigured(response.data.configured);
        setProvider(response.data.provider);

        // Load conversations if AI is configured
        if (response.data.configured) {
          loadConversations(true); // Auto-load latest conversation on page load
        }
      } catch {
        setAiConfigured(false);
      }
    };
    checkStatus();
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load all conversations
  const loadConversations = async (autoLoadLatest = false) => {
    try {
      const response = await aiAPI.getConversations();
      const convos = response.data.conversations || [];
      setConversations(convos);

      // Auto-load the most recent conversation on page load if there are any
      if (autoLoadLatest && convos.length > 0 && !currentConversationId) {
        loadConversation(convos[0].id);
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  };

  // Load a specific conversation
  const loadConversation = async (conversationId: number) => {
    try {
      const response = await aiAPI.getMessages(conversationId);
      const loadedMessages: Message[] = response.data.messages.map((msg: any) => ({
        id: msg.id.toString(),
        role: msg.role,
        content: msg.content,
        timestamp: new Date(msg.timestamp),
      }));
      setMessages(loadedMessages);
      setCurrentConversationId(conversationId);
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  };

  // Create new conversation
  const createNewChat = async () => {
    setMessages([]);
    setCurrentConversationId(null);
    inputRef.current?.focus();
  };

  // Open delete confirmation modal
  const openDeleteModal = (conversationId: number, title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget({ id: conversationId, title });
    setShowDeleteModal(true);
  };

  // Delete conversation (called from modal)
  const confirmDeleteConversation = async () => {
    if (!deleteTarget) return;

    try {
      await aiAPI.deleteConversation(deleteTarget.id);

      // If deleting current conversation, clear it
      if (deleteTarget.id === currentConversationId) {
        setMessages([]);
        setCurrentConversationId(null);
      }

      // Reload conversations
      loadConversations();
      setShowDeleteModal(false);
      setDeleteTarget(null);
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  };

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
  };

  const sendMessage = async (question?: string) => {
    const text = (question || input).trim();
    if (!text || isLoading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    try {
      // Create conversation if this is the first message
      let conversationId = currentConversationId;
      if (!conversationId) {
        const convResponse = await aiAPI.createConversation(text.substring(0, 50));
        conversationId = convResponse.data.conversation.id;
        setCurrentConversationId(conversationId);
      }

      // Get AI response (pass conversationId so server can include chat history for follow-up context)
      const response = await aiAPI.ask(text, conversationId);
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.data.answer,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMsg]);

      // Save both messages to database
      if (conversationId) {
        await aiAPI.saveMessage(conversationId, 'user', text);
        await aiAPI.saveMessage(conversationId, 'assistant', response.data.answer);

        // Reload conversations to update the list
        loadConversations();
      }
    } catch (error: any) {
      const errorType = error.response?.data?.errorType;
      const serverMessage = error.response?.data?.error;

      let content: string;
      if (errorType === 'quota_exceeded') {
        content = serverMessage || 'Your AI provider has run out of credits. Please top up your account and try again.';
      } else if (errorType === 'rate_limited') {
        content = serverMessage || 'The AI provider is temporarily rate-limited. Please wait a minute and try again.';
      } else if (errorType === 'invalid_key') {
        content = serverMessage || 'Your AI API key is invalid. Please update it in Settings → Integrations.';
      } else {
        content = serverMessage || error.response?.data?.details || 'Failed to get a response. Please try again.';
      }

      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'error',
        content,
        errorType,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      // Focus back on input
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Simple markdown-to-HTML renderer for bold, lists, etc.
  const renderMarkdown = (text: string) => {
    // Process markdown-ish formatting
    let html = text
      // Bold
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      // Inline code
      .replace(/`(.*?)`/g, '<code class="bg-gray-100 text-purple-700 px-1 py-0.5 rounded text-sm">$1</code>')
      // Line breaks
      .replace(/\n/g, '<br/>');

    // Convert bullet lists
    html = html.replace(/((?:^|\<br\/\>)\s*[-•]\s+.+(?:\<br\/\>\s*[-•]\s+.+)*)/g, (match) => {
      const items = match
        .split('<br/>')
        .filter(line => line.trim().match(/^[-•]\s+/))
        .map(line => `<li class="ml-4">${line.trim().replace(/^[-•]\s+/, '')}</li>`)
        .join('');
      return `<ul class="list-disc list-inside space-y-1 my-2">${items}</ul>`;
    });

    // Convert numbered lists
    html = html.replace(/((?:^|\<br\/\>)\s*\d+[\.\)]\s+.+(?:\<br\/\>\s*\d+[\.\)]\s+.+)*)/g, (match) => {
      const items = match
        .split('<br/>')
        .filter(line => line.trim().match(/^\d+[\.\)]\s+/))
        .map(line => `<li class="ml-4">${line.trim().replace(/^\d+[\.\)]\s+/, '')}</li>`)
        .join('');
      return `<ol class="list-decimal list-inside space-y-1 my-2">${items}</ol>`;
    });

    return html;
  };

  // Not configured state
  if (aiConfigured === false) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-white shadow rounded-lg p-8 text-center">
          <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <SparklesIcon className="w-8 h-8 text-purple-600" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">AI Insights</h2>
          <p className="text-gray-600 mb-6">
            Ask questions about your church's attendance data in plain language. To get started, an admin needs to connect an AI provider.
          </p>
          <Link
            to="/app/settings?tab=integrations"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700"
          >
            <Cog6ToothIcon className="h-4 w-4 mr-2" />
            Go to Settings
          </Link>
        </div>
      </div>
    );
  }

  // Loading status
  if (aiConfigured === null) {
    return (
      <div className="flex items-center justify-center h-64">
        <ArrowPathIcon className="w-8 h-8 animate-spin text-purple-500" />
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row h-full" style={{ height: 'calc(100vh - 10rem)' }}>
      {/* Sidebar - Desktop only */}
      {showSidebar && (
        <div className="hidden lg:flex w-64 bg-white border-r border-gray-200 flex-col">
          {/* Sidebar Header */}
          <div className="p-4 border-b border-gray-200">
            <button
              onClick={createNewChat}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors"
            >
              <PlusIcon className="w-4 h-4" />
              <span className="text-sm font-medium">New Chat</span>
            </button>
          </div>

          {/* Conversations List */}
          <div className="flex-1 overflow-y-auto p-2">
            {conversations.length === 0 ? (
              <div className="text-center py-8 text-sm text-gray-500">
                <ChatBubbleLeftRightIcon className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                No conversations yet
              </div>
            ) : (
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => loadConversation(conv.id)}
                  className={`group relative p-3 mb-1 rounded-md cursor-pointer transition-colors ${
                    currentConversationId === conv.id
                      ? 'bg-purple-50 border border-purple-200'
                      : 'hover:bg-gray-50 border border-transparent'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {conv.title}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        {conv.message_count} messages
                      </p>
                    </div>
                    <button
                      onClick={(e) => openDeleteModal(conv.id, conv.title, e)}
                      className="opacity-0 group-hover:opacity-100 ml-2 p-1 text-gray-400 hover:text-red-600 transition-opacity"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="bg-white shadow rounded-t-lg px-4 lg:px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 lg:space-x-3">
              {/* Desktop: Toggle sidebar button */}
              <button
                onClick={() => setShowSidebar(!showSidebar)}
                className="hidden lg:block p-2 hover:bg-gray-100 rounded-md"
                title="Toggle history sidebar"
              >
                <Bars3Icon className="w-5 h-5 text-gray-600" />
              </button>
              {/* Mobile: New chat button */}
              <button
                onClick={createNewChat}
                className="lg:hidden p-2 hover:bg-gray-100 rounded-md"
                title="New chat"
              >
                <PlusIcon className="w-5 h-5 text-gray-600" />
              </button>
              <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                <SparklesIcon className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">AI Insights</h1>
                <p className="text-xs text-gray-500">
                  Powered by {provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : 'AI'}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto bg-gray-50 px-4 py-6 space-y-4">
          {messages.length === 0 ? (
            <div className="text-center py-8">
              <SparklesIcon className="w-12 h-12 text-purple-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-700 mb-2">
                Ask me anything about your church data
              </h3>
              <p className="text-sm text-gray-500 mb-6 max-w-md mx-auto">
                I can help you understand attendance patterns, identify trends, and spot people who may need follow-up.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg mx-auto">
                {SUGGESTED_QUESTIONS.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(q)}
                    className="text-left text-sm px-3 py-2 rounded-lg border border-purple-200 bg-white text-purple-700 hover:bg-purple-50 hover:border-purple-300 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-purple-600 text-white'
                      : msg.role === 'error'
                      ? msg.errorType === 'quota_exceeded' || msg.errorType === 'rate_limited'
                        ? 'bg-amber-50 border border-amber-200 text-amber-800'
                        : 'bg-red-50 border border-red-200 text-red-700'
                      : 'bg-white border border-gray-200 text-gray-800 shadow-sm'
                  }`}
                >
                  {msg.role === 'error' && (
                    <div className="flex items-center mb-1">
                      <ExclamationTriangleIcon className="w-4 h-4 mr-2" />
                      <span className="font-medium text-sm">
                        {msg.errorType === 'quota_exceeded' ? 'Out of Credits' :
                         msg.errorType === 'rate_limited' ? 'Rate Limited' :
                         msg.errorType === 'invalid_key' ? 'API Key Issue' :
                         'Error'}
                      </span>
                    </div>
                  )}
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                  />
                </div>
              </div>
            ))
          )}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-white border border-gray-200 rounded-lg px-4 py-3 shadow-sm">
                <div className="flex items-center space-x-2">
                  <ArrowPathIcon className="w-4 h-4 animate-spin text-purple-500" />
                  <span className="text-sm text-gray-600">Thinking...</span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="bg-white border-t border-gray-200 px-4 py-4 flex-shrink-0">
          <div className="flex items-end space-x-2">
            <div className="flex-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question about your church data..."
                className="w-full px-4 py-3 text-base border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                rows={2}
                style={{ minHeight: '80px', maxHeight: '200px' }}
              />
            </div>
            <button
              onClick={() => sendMessage()}
              disabled={isLoading || !input.trim()}
              className="px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              <PaperAirplaneIcon className="w-5 h-5" />
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2 text-center">
            Press Enter to send, Shift+Enter for new line
          </p>
        </div>

        {/* Mobile Chat History - Collapsible section at bottom */}
        <div className="lg:hidden bg-white border-t border-gray-200 flex-shrink-0">
          <button
            onClick={() => setShowHistoryMobile(!showHistoryMobile)}
            className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <span>Chat History ({conversations.length})</span>
            <svg
              className={`w-5 h-5 transform transition-transform ${showHistoryMobile ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showHistoryMobile && (
            <div className="max-h-64 overflow-y-auto p-2 border-t border-gray-200">
              {conversations.length === 0 ? (
                <div className="text-center py-4 text-sm text-gray-500">
                  No conversations yet
                </div>
              ) : (
                conversations.map((conv) => (
                  <div
                    key={conv.id}
                    onClick={() => {
                      loadConversation(conv.id);
                      setShowHistoryMobile(false);
                    }}
                    className={`group relative p-3 mb-1 rounded-md cursor-pointer transition-colors ${
                      currentConversationId === conv.id
                        ? 'bg-purple-50 border border-purple-200'
                        : 'hover:bg-gray-50 border border-transparent'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {conv.title}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          {conv.message_count} messages
                        </p>
                      </div>
                      <button
                        onClick={(e) => openDeleteModal(conv.id, conv.title, e)}
                        className="opacity-0 group-hover:opacity-100 ml-2 p-1 text-gray-400 hover:text-red-600 transition-opacity"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && deleteTarget && createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Confirm Deletion
                </h3>
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>

              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                <TrashIcon className="h-6 w-6 text-red-600" />
              </div>

              <div className="text-center mb-6">
                <p className="text-sm text-gray-500">
                  Are you sure you want to delete <strong>{deleteTarget.title}</strong>? This action cannot be undone.
                </p>
              </div>

              <div className="flex space-x-3">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteConversation}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Delete Conversation
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default AiInsightsPage;
