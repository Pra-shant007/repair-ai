'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, MessageSquare, AlertTriangle, ShieldCheck } from 'lucide-react';

interface Message {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: Date;
}

interface ChatbotProps {
  scenarioId: string;
}

export default function Chatbot({ scenarioId }: ChatbotProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Initialize with welcome message
  useEffect(() => {
    setMessages([
      {
        id: 'welcome',
        sender: 'ai',
        text: "👋 Hello! I am your RepairAI Copilot. I'm monitoring your camera feed and can help with diagnostics. Ask me about tools, safety instructions, or how to perform any of the checklist items!",
        timestamp: new Date(),
      },
    ]);
  }, [scenarioId]);

  // Scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const userMessageText = inputValue;
    const userMsg: Message = {
      id: `msg-${Date.now()}-user`,
      sender: 'user',
      text: userMessageText,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputValue('');
    setIsTyping(true);

    try {
      const token = localStorage.getItem('token') || '';
      const response = await fetch('https://repair-ai.onrender.com/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({
          message: userMessageText,
          scenarioId: scenarioId,
          history: messages.map((m) => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.text })),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const aiMsg: Message = {
          id: `msg-${Date.now()}-ai`,
          sender: 'ai',
          text: data.reply || 'No response returned.',
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, aiMsg]);
      } else {
        throw new Error('API server error');
      }
    } catch (error) {
      console.warn('Backend offline, using client-side chatbot fallback response:', error);
      
      // Client-side simulation fallback mapping to match backend aiController.ts
      setTimeout(() => {
        let reply = '';
        const query = userMessageText.toLowerCase();

        if (query.includes('static') || query.includes('safety') || query.includes('shock')) {
          reply = '⚠️ SAFETY TIP: Static electricity can damage microcircuits! Ground yourself by touching metal, wear an anti-static strap, and avoid touching copper/gold contact pads directly.';
        } else if (query.includes('tool') || query.includes('screwdriver')) {
          reply = '🔧 TOOLS SUGGESTION: For electronics, grab a Precision Screwdriver kit (Phillips #00, Torx T5, Pentalobe for Mac/iPhone) alongside plastic spudgers, tweezers, and prying tools.';
        } else if (query.includes('battery') || query.includes('power')) {
          reply = '🔌 POWER WARNING: Never work on devices plugged in! Disconnect the battery connector first. Dropping screws on live motherboards causes irreversible shorts.';
        } else {
          reply = `🤖 RepairAI Copilot: I am analyzing your video feed. Feel free to ask about static grounding, required tools, battery handling, or specific steps.`;
        }

        const aiMsg: Message = {
          id: `msg-${Date.now()}-ai`,
          sender: 'ai',
          text: reply,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, aiMsg]);
      }, 1000);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-black/45 backdrop-blur-md rounded-2xl border border-white/10 overflow-hidden shadow-xl">
      {/* Header */}
      <div className="p-4 border-b border-white/5 bg-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-primary" />
          <span className="text-sm font-bold text-white font-outfit">AI Repair Assistant</span>
        </div>
        <span className="px-2 py-0.5 rounded-full bg-primary/20 text-[9px] text-primary font-mono font-bold animate-pulse">
          COPILOT ONLINE
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-[250px] scrollbar-thin scrollbar-thumb-white/10">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col max-w-[85%] ${
              msg.sender === 'user' ? 'self-end items-end' : 'self-start items-start'
            }`}
          >
            <div
              className={`p-3 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                msg.sender === 'user'
                  ? 'bg-gradient-to-r from-primary to-accent text-black font-semibold rounded-tr-none'
                  : 'bg-white/5 border border-white/10 text-gray-200 rounded-tl-none'
              }`}
            >
              {msg.text}
            </div>
            <span className="text-[9px] text-gray-500 font-mono mt-1 px-1">
              {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}

        {isTyping && (
          <div className="flex flex-col max-w-[85%] self-start items-start">
            <div className="p-3 rounded-2xl rounded-tl-none bg-white/5 border border-white/10 text-gray-400 text-xs flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-primary animate-spin" />
              <span>Analyzing scenario...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <form onSubmit={handleSendMessage} className="p-3 border-t border-white/5 bg-white/5 flex gap-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Ask a question (e.g. static, tools)..."
          className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 text-xs sm:text-sm focus:border-primary/50 outline-none transition-colors"
        />
        <button
          type="submit"
          disabled={!inputValue.trim()}
          className="p-2 rounded-xl bg-primary text-black disabled:opacity-40 disabled:hover:scale-100 hover:scale-105 transition-all flex items-center justify-center cursor-pointer"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}
