'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Wrench, Eye, ShieldAlert, Cpu, Sparkles, MessageSquare, Play, Video, BarChart2 } from 'lucide-react';
import { demoScenarios } from '@/utils/repairGuides';

export default function Home() {
  const [selectedDemo, setSelectedDemo] = useState('laptop_ram_upgrade');
  const [showDemoVideo, setShowDemoVideo] = useState(false);
  
  // Stats count animations simulation
  const [diagnosedCount, setDiagnosedCount] = useState(45000);
  const [repairsCount, setRepairsCount] = useState(8500);

  useEffect(() => {
    const diagInterval = setInterval(() => {
      setDiagnosedCount((prev) => (prev < 50000 ? prev + 120 : 50240));
    }, 50);

    const repairInterval = setInterval(() => {
      setRepairsCount((prev) => (prev < 10000 ? prev + 40 : 10120));
    }, 50);

    return () => {
      clearInterval(diagInterval);
      clearInterval(repairInterval);
    };
  }, []);

  const stats = [
    { number: `${diagnosedCount.toLocaleString()}+`, label: 'Devices Diagnosed' },
    { number: '95%', label: 'Detection Accuracy' },
    { number: `${repairsCount.toLocaleString()}+`, label: 'Repairs Completed' },
    { number: '24/7', label: 'AI Assistance' },
  ];

  const features = [
    {
      title: 'Live Device Analysis',
      desc: 'Connect your device camera to continuously observe components and automatically identify motherboard layouts.',
      icon: Eye,
      color: 'from-blue-500 to-cyan-500',
    },
    {
      title: 'Safety Mode Engine',
      desc: 'Alerts you of critical warnings (like static risks or power lines) and locks progress until safety checks are verified.',
      icon: ShieldAlert,
      color: 'from-red-500 to-orange-500',
    },
    {
      title: 'AR Guided Overlays',
      desc: 'Shows bounding box coordinates, highlighted arrows, and target lines directly over detected components.',
      icon: Cpu,
      color: 'from-purple-500 to-pink-500',
    },
    {
      title: 'Hands-Free Voice control',
      desc: 'Speaks instructions out loud and listens for commands like "Next" or "Repeat" so you can keep both hands on the tools.',
      icon: Sparkles,
      color: 'from-green-500 to-emerald-500',
    },
    {
      title: 'Persistent Chat Copilot',
      desc: 'Ask our sidebar assistant questions about specific steps, tool requirements, or troubleshooting prompts anytime.',
      icon: MessageSquare,
      color: 'from-yellow-500 to-amber-500',
    },
    {
      title: 'Smart Export Reports',
      desc: 'Generates detailed diagnostic PDF summaries including component conditions, steps completed, and safety compliance logs.',
      icon: BarChart2,
      color: 'from-indigo-500 to-purple-500',
    },
  ];

  return (
    <div className="flex flex-col gap-16 md:gap-24 w-full">
      {/* Hero Section */}
      <section className="relative flex flex-col lg:flex-row items-center gap-12 pt-8 md:pt-16">
        <div className="flex-1 flex flex-col items-start text-left gap-6 z-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-xs font-semibold text-primary">
            <Sparkles className="w-3.5 h-3.5" />
            Hackathon Showcase Edition
          </div>
          
          <h1 className="font-outfit text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1] text-white">
            Fix Devices Like a Pro with <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">AI Copilot</span>
          </h1>
          
          <p className="text-lg text-gray-400 max-w-xl">
            Get real-time AI guidance for diagnosing and repairing electronics through your camera. 
            Connect your feed, analyze layouts, and follow safe step-by-step instructions.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
            <Link
              href="/diagnose"
              className="flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold text-black bg-primary hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/30 transition-all duration-200"
            >
              <Wrench className="w-5 h-5" />
              Start Live Repair
            </Link>
            <button
              onClick={() => setShowDemoVideo(true)}
              className="flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold text-white bg-white/5 border border-white/10 hover:bg-white/10 transition-all duration-200 cursor-pointer"
            >
              <Play className="w-4 h-4" />
              Watch Demo
            </button>
          </div>
        </div>

        {/* Hero Interactive UI Preview */}
        <div className="flex-1 w-full max-w-lg lg:max-w-none z-10">
          <div className="glass-panel rounded-2xl p-4 md:p-6 shadow-2xl relative border border-white/10">
            {/* Window header */}
            <div className="flex items-center justify-between pb-4 border-b border-white/5 mb-4">
              <div className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-full bg-red-500/80" />
                <span className="w-3.5 h-3.5 rounded-full bg-yellow-500/80" />
                <span className="w-3.5 h-3.5 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 font-mono ml-2">Webcam Feed Analysis</span>
              </div>
              <span className="px-2 py-0.5 rounded bg-primary/20 text-[10px] text-primary font-mono font-bold animate-pulse">
                OBSERVING FEED
              </span>
            </div>

            {/* Simulated camera view */}
            <div className="relative aspect-video rounded-xl bg-black/60 overflow-hidden flex items-center justify-center border border-white/5">
              <div className="absolute inset-0 bg-cover bg-center filter brightness-90 saturate-50 opacity-40" style={{ backgroundImage: `url('/api/placeholder/600/350')` }} />
              
              {/* Overlay grid */}
              <div className="absolute inset-0 grid grid-cols-6 grid-rows-4 opacity-15 pointer-events-none">
                {Array.from({ length: 24 }).map((_, i) => (
                  <div key={i} className="border-[0.5px] border-white/30" />
                ))}
              </div>

              {/* Bounding box graphics */}
              {demoScenarios[selectedDemo]?.components.map((comp, idx) => (
                <div
                  key={idx}
                  className="absolute border-2 border-primary/80 bg-primary/10 rounded-sm font-mono text-[9px] font-bold text-white px-1.5 py-0.5 shadow-md flex flex-col justify-start"
                  style={{
                    left: `${comp.bbox[0] / 1.3}%`,
                    top: `${comp.bbox[1] / 1.3}%`,
                    width: `${comp.bbox[2] / 1.3}%`,
                    height: `${comp.bbox[3] / 1.3}%`,
                  }}
                >
                  <span className="bg-primary/95 text-black px-1 rounded-sm w-max mb-1">
                    {comp.name}
                  </span>
                  <span>{(comp.confidence * 100).toFixed(0)}% Match</span>
                </div>
              ))}

              <div className="z-10 text-center flex flex-col items-center gap-2 p-6">
                <Cpu className="w-10 h-10 text-primary animate-spin-slow" />
                <div className="text-sm font-bold text-white">
                  Device Identified: <span className="text-primary">{demoScenarios[selectedDemo]?.deviceName}</span>
                </div>
                <div className="text-xs text-gray-400">
                  Confidence Rating: {demoScenarios[selectedDemo]?.confidenceScore}%
                </div>
              </div>
            </div>

            {/* Scenario Toggles */}
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              {Object.keys(demoScenarios).map((scKey) => (
                <button
                  key={scKey}
                  onClick={() => setSelectedDemo(scKey)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 cursor-pointer ${
                    selectedDemo === scKey
                      ? 'bg-primary/20 text-primary border border-primary/30'
                      : 'bg-white/5 text-gray-400 border border-white/5 hover:text-white'
                  }`}
                >
                  {demoScenarios[scKey].deviceName} Demo
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Statistics Section */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
        {stats.map((stat, idx) => (
          <div key={idx} className="glass-panel rounded-2xl p-6 text-center shadow-lg border border-white/5">
            <div className="font-outfit text-3xl md:text-4xl font-extrabold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent mb-1">
              {stat.number}
            </div>
            <div className="text-sm text-gray-400 font-medium">{stat.label}</div>
          </div>
        ))}
      </section>

      {/* Features Grid Section */}
      <section className="flex flex-col gap-12">
        <div className="text-center max-w-2xl mx-auto flex flex-col gap-3">
          <h2 className="font-outfit text-3xl md:text-4xl font-extrabold text-white">
            Designed for Speed and Safety
          </h2>
          <p className="text-gray-400 text-sm md:text-base">
            RepairAI Copilot provides full-spectrum hardware guides and visual checks, keeping safety warnings front and center.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
          {features.map((feat, idx) => {
            const Icon = feat.icon;
            return (
              <div
                key={idx}
                className="glass-panel glass-panel-hover rounded-2xl p-6 flex flex-col gap-4 relative group overflow-hidden"
              >
                {/* Background glow hover index */}
                <div className={`absolute -right-10 -bottom-10 w-24 h-24 rounded-full bg-gradient-to-br ${feat.color} opacity-0 group-hover:opacity-10 blur-xl transition-all duration-300`} />
                
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${feat.color} flex items-center justify-center shadow-lg`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-bold text-white group-hover:text-primary transition-colors">
                  {feat.title}
                </h3>
                <p className="text-sm text-gray-400 leading-relaxed">
                  {feat.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Video Demo Modal popup */}
      {showDemoVideo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-3xl glass-panel rounded-2xl overflow-hidden border border-white/15 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200">
            <button
              onClick={() => setShowDemoVideo(false)}
              className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-black/60 border border-white/10 flex items-center justify-center font-bold text-white hover:bg-black/90 cursor-pointer"
            >
              ✕
            </button>
            <div className="aspect-video bg-black flex flex-col items-center justify-center p-12 text-center gap-4">
              <Video className="w-16 h-16 text-primary animate-pulse" />
              <h3 className="text-xl font-bold text-white">RepairAI Copilot Video Walkthrough</h3>
              <p className="text-sm text-gray-400 max-w-md">
                Demonstrating Live HP Laptop RAM Upgrade simulation with webcam computer vision detection overlays, Safety warning toggles, and voice guidance.
              </p>
              <button
                onClick={() => setShowDemoVideo(false)}
                className="mt-4 px-6 py-2 rounded-xl bg-primary text-black font-semibold hover:bg-primary/90 cursor-pointer"
              >
                Close Demo Preview
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
