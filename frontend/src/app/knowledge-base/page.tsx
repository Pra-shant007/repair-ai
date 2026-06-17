'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, BookOpen, Wrench, Shield, ArrowRight, X, Sparkles } from 'lucide-react';
import { knowledgeBaseData, IKnowledgeItem, demoScenarios } from '@/utils/repairGuides';

export default function KnowledgeBase() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<IKnowledgeItem | null>(null);

  // Categories list matching data
  const categories = [
    'Laptop Repairs',
    'Mobile Repairs',
    'PC Repairs',
    'Printer Repairs',
    'Router Repairs'
  ];

  // Filter guides based on search query and category
  const filteredData = knowledgeBaseData.filter(item => {
    const matchesSearch = 
      item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.symptoms.some(s => s.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesCategory = !selectedCategory || item.deviceType === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  // Autocomplete search suggestions mapping
  const searchSuggestions = [
    'SMC Reset',
    'RAM Upgrade',
    'Charging Port',
    'Corrosion Clean',
    'Capacitor blown'
  ].filter(s => s.toLowerCase().includes(searchQuery.toLowerCase()) && searchQuery.length > 1);

  // Helper to map guide to demo scenario for direct launcher link
  const getDemoScenarioLink = (title: string): string | null => {
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes('ram')) return 'laptop_ram_upgrade';
    if (lowerTitle.includes('opening') || lowerTitle.includes('macbook')) return 'laptop_ram_upgrade';
    if (lowerTitle.includes('corrosion') || lowerTitle.includes('battery')) return 'broken_charging_port';
    if (lowerTitle.includes('capacitor') || lowerTitle.includes('motherboard')) return 'ssd_installation';
    if (lowerTitle.includes('router') || lowerTitle.includes('volts')) return 'wifi_adapter_issue';
    return null;
  };

  const handleLaunchRepair = (title: string) => {
    const scId = getDemoScenarioLink(title);
    if (scId) {
      router.push(`/diagnose?scenario=${scId}`);
    } else {
      router.push('/diagnose');
    }
  };

  return (
    <div className="flex flex-col gap-8 md:gap-10 animate-in fade-in duration-200">
      {/* Title */}
      <div>
        <h1 className="font-outfit text-3xl md:text-4xl font-extrabold text-white flex items-center gap-3">
          <BookOpen className="w-8 h-8 text-primary" />
          Repair Knowledge Base
        </h1>
        <p className="text-sm text-gray-400 mt-1">
          Search our database of hardware manuals, troubleshooting steps, and AI suggestions.
        </p>
      </div>

      {/* Search Header Container */}
      <div className="glass-panel rounded-2xl p-6 border border-white/5 shadow-md flex flex-col gap-4 relative">
        <div className="relative">
          <Search className="absolute left-4 top-3.5 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search diagnostics (e.g. RAM, SMC Reset, Charging Port)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-12 pr-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-primary/50 text-white placeholder-gray-500 text-sm outline-none transition-colors"
          />
        </div>

        {/* Search Suggestions */}
        {searchSuggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <span className="text-xs text-gray-500 font-mono">Suggestions:</span>
            {searchSuggestions.map((s, idx) => (
              <button
                key={idx}
                onClick={() => setSearchQuery(s)}
                className="px-2 py-0.5 rounded bg-white/5 hover:bg-primary/20 hover:text-primary text-[10px] text-gray-400 font-mono font-bold transition-colors cursor-pointer"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main Grid: Categories list on left, articles on right */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
        {/* Categories Sidebar */}
        <div className="lg:col-span-1 flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-3 mb-2">Categories</h3>
          <button
            onClick={() => setSelectedCategory(null)}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer ${
              selectedCategory === null
                ? 'bg-primary/15 text-primary border border-primary/20 shadow-md'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            All Categories
          </button>
          {categories.map((cat, idx) => (
            <button
              key={idx}
              onClick={() => setSelectedCategory(cat)}
              className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer ${
                selectedCategory === cat
                  ? 'bg-primary/15 text-primary border border-primary/20 shadow-md'
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Article Cards Grid */}
        <div className="lg:col-span-3 grid md:grid-cols-2 gap-6">
          {filteredData.length > 0 ? (
            filteredData.map((item, idx) => (
              <div
                key={idx}
                className="glass-panel glass-panel-hover rounded-2xl p-6 flex flex-col gap-4 relative overflow-hidden group cursor-pointer"
                onClick={() => setActiveItem(item)}
              >
                <div className="flex items-center justify-between">
                  <span className="px-2.5 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] text-gray-400 font-semibold">
                    {item.deviceType}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    item.difficulty === 'Expert' ? 'bg-red-500/20 text-red-400' :
                    item.difficulty === 'Intermediate' ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-green-500/20 text-green-400'
                  }`}>
                    {item.difficulty}
                  </span>
                </div>

                <h3 className="font-outfit text-lg font-bold text-white group-hover:text-primary transition-colors">
                  {item.title}
                </h3>
                <p className="text-sm text-gray-400 line-clamp-3 leading-relaxed">
                  {item.summary}
                </p>

                <div className="flex items-center gap-1.5 text-xs font-bold text-primary mt-auto group-hover:gap-3 transition-all duration-200">
                  Read details <ArrowRight className="w-3.5 h-3.5" />
                </div>
              </div>
            ))
          ) : (
            <div className="col-span-2 glass-panel rounded-2xl p-12 text-center text-gray-500">
              No matching guides found. Try tweaking your search filters or selected category.
            </div>
          )}
        </div>
      </div>

      {/* Guide Details Modal Popup */}
      {activeItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/85 backdrop-blur-md">
          <div className="w-full max-w-lg glass-panel rounded-2xl p-6 border border-white/15 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 flex flex-col gap-6 max-h-[85vh] overflow-y-auto">
            <button
              onClick={() => setActiveItem(null)}
              className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-gray-400 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <div>
              <span className="px-2.5 py-0.5 rounded bg-primary/20 text-xs font-semibold text-primary font-mono">
                {activeItem.deviceType}
              </span>
              <h2 className="font-outfit text-2xl font-extrabold text-white mt-2 leading-snug">
                {activeItem.title}
              </h2>
            </div>

            <p className="text-sm text-gray-300 leading-relaxed">
              {activeItem.summary}
            </p>

            {/* Symptoms and Tools Grid */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5 text-primary" /> Symptoms
                </span>
                <ul className="flex flex-col gap-1 text-xs text-gray-400 list-disc pl-4">
                  {activeItem.symptoms.map((s, idx) => (
                    <li key={idx}>{s}</li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1">
                  <Wrench className="w-3.5 h-3.5 text-primary" /> Tools Required
                </span>
                <ul className="flex flex-col gap-1 text-xs text-gray-400 list-disc pl-4">
                  {activeItem.toolsNeeded.map((t, idx) => (
                    <li key={idx}>{t}</li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Launch Copilot Call to Action */}
            <div className="p-4 rounded-xl bg-gradient-to-r from-primary/10 to-accent/10 border border-primary/20 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-white">
                <Sparkles className="w-4 h-4 text-primary" /> Run with AI Camera Overlay
              </div>
              <p className="text-xs text-gray-400">
                You can troubleshoot this issue using RepairAI Copilot. The AI will overlay bounding boxes and instructions directly onto your camera feed.
              </p>
              <button
                onClick={() => {
                  handleLaunchRepair(activeItem.title);
                  setActiveItem(null);
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-black bg-primary hover:bg-primary/95 transition-all duration-200 cursor-pointer shadow-lg shadow-primary/15"
              >
                Launch AI Live Repair
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
