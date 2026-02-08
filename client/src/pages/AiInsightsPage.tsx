import React, { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { aiAPI } from '../services/api';
import {
  PaperAirplaneIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: Date;
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

  // Check AI status on mount
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await aiAPI.getStatus();
        setAiConfigured(response.data.configured);
        setProvider(response.data.provider);
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
      const response = await aiAPI.ask(text);
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.data.answer,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (error: any) {
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'error',
        content: error.response?.data?.error || error.response?.data?.details || 'Failed to get a response. Please try again.',
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
    <div className="max-w-4xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 10rem)' }}>
      {/* Header */}
      <div className="bg-white shadow rounded-t-lg px-6 py-4 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
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
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="text-sm text-gray-500 hover:text-gray-700 flex items-center"
            >
              Clear chat
            </button>
          )}
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
                    ? 'bg-red-50 border border-red-200 text-red-700'
                    : 'bg-white border border-gray-200 text-gray-800 shadow-sm'
                }`}
              >
                {msg.role === 'error' && (
                  <div className="flex items-center mb-1">
                    <ExclamationTriangleIcon className="w-4 h-4 mr-1 text-red-500" />
                    <span className="text-xs font-medium text-red-600">Error</span>
                  </div>
                )}
                {msg.role === 'assistant' ? (
                  <div
                    className="text-sm leading-relaxed prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                  />
                ) : (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                )}
                <p className={`text-xs mt-1 ${
                  msg.role === 'user' ? 'text-purple-200' : 'text-gray-400'
                }`}>
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))
        )}

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-lg px-4 py-3 shadow-sm">
              <div className="flex items-center space-x-2">
                <div className="flex space-x-1">
                  <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-sm text-gray-500">Thinking...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="bg-white border-t border-gray-200 rounded-b-lg px-4 py-3 flex-shrink-0">
        <div className="flex items-end space-x-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your attendance data..."
            rows={1}
            className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:ring-purple-500 focus:outline-none"
            disabled={isLoading}
          />
          <button
            onClick={() => sendMessage()}
            disabled={!input.trim() || isLoading}
            className="flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <ArrowPathIcon className="w-5 h-5 animate-spin" />
            ) : (
              <PaperAirplaneIcon className="w-5 h-5" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
};

export default AiInsightsPage;
