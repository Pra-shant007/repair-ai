'use client';

import React, { useRef, useEffect, useState } from 'react';
import { Camera, CameraOff, Maximize2, Minimize2, Cpu, RefreshCw } from 'lucide-react';
import { IComponent } from '@/utils/repairGuides';

interface CameraFeedProps {
  scenarioId: string;
  components: IComponent[];
  activeComponentNames: string[]; // Components related to current step to highlight
  onFrameCapture?: (base64Image: string) => void;
}

export default function CameraFeed({
  scenarioId,
  components,
  activeComponentNames,
  onFrameCapture,
}: CameraFeedProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hasCamera, setHasCamera] = useState<boolean | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanPulse, setScanPulse] = useState(0);

  // Start webcam
  const startCamera = async () => {
    setCameraError(null);
    try {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });

      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setHasCamera(true);
    } catch (err) {
      console.warn('Webcam access failed or not available, falling back to simulator:', err);
      setHasCamera(false);
      setCameraError('Webcam not accessible. Running in simulation mode.');
    }
  };

  useEffect(() => {
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Periodic scanline/radar animation pulse
  useEffect(() => {
    const interval = setInterval(() => {
      setScanPulse((prev) => (prev + 1) % 360);
    }, 50);
    return () => clearInterval(interval);
  }, []);

  // Capture frame helper for backend verification simulation
  useEffect(() => {
    if (!onFrameCapture) return;

    const interval = setInterval(() => {
      if (hasCamera && videoRef.current) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            onFrameCapture(dataUrl);
          }
        } catch (e) {
          console.error('Frame capture error:', e);
        }
      } else {
        // Mock base64 frame representation
        onFrameCapture('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
      }
    }, 3000); // Send frame every 3s

    return () => clearInterval(interval);
  }, [hasCamera, onFrameCapture]);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch((err) => {
        console.error('Fullscreen request failed:', err);
      });
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative rounded-2xl overflow-hidden border border-white/10 shadow-2xl bg-black flex flex-col items-center justify-center transition-all duration-300 ${
        isFullscreen ? 'w-screen h-screen rounded-none border-none z-50' : 'aspect-video w-full'
      }`}
    >
      {/* Top Floating Controls */}
      <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/70 backdrop-blur-md border border-white/10 text-[10px] text-gray-300 font-mono font-bold">
            <span className={`w-2 h-2 rounded-full ${hasCamera ? 'bg-primary animate-pulse' : 'bg-purple-500'}`} />
            {hasCamera ? 'LIVE WEBCAM' : 'SIMULATION FEED'}
          </span>
          {hasCamera && (
            <button
              onClick={startCamera}
              className="pointer-events-auto w-7 h-7 rounded-lg bg-black/70 hover:bg-black/90 border border-white/10 flex items-center justify-center text-gray-400 hover:text-white transition-colors cursor-pointer"
              title="Restart Camera"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <button
          onClick={toggleFullscreen}
          className="pointer-events-auto flex items-center justify-center w-8 h-8 rounded-lg bg-black/70 backdrop-blur-md border border-white/10 text-gray-300 hover:text-white hover:bg-black/90 transition-all cursor-pointer"
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>

      {/* Video stream element */}
      {hasCamera ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover select-none"
        />
      ) : (
        /* Tech HUD Simulator Fallback when webcam is unavailable */
        <div className="absolute inset-0 w-full h-full bg-[#030308] flex flex-col items-center justify-center overflow-hidden">
          {/* Cybergrid background */}
          <div className="absolute inset-0 opacity-20 pointer-events-none" 
            style={{
              backgroundImage: 'radial-gradient(circle, rgba(0, 240, 255, 0.1) 1px, transparent 1px)',
              backgroundSize: '20px 20px'
            }} 
          />
          
          {/* Futuristic technical radar layout */}
          <div className="relative w-80 h-80 rounded-full border border-primary/20 flex items-center justify-center opacity-30 pointer-events-none scale-90 sm:scale-100">
            <div className="absolute w-64 h-64 rounded-full border border-dashed border-accent/25 animate-spin-slow" />
            <div className="absolute w-48 h-48 rounded-full border border-primary/30" />
            <div className="absolute w-32 h-32 rounded-full border border-dashed border-primary/40 animate-reverse-spin" />
            <div className="absolute w-2 h-2 rounded-full bg-primary" />
            {/* Pulsing crosshairs */}
            <div className="absolute w-full h-[0.5px] bg-primary/20" />
            <div className="absolute h-full w-[0.5px] bg-primary/20" />
          </div>

          <div className="z-10 flex flex-col items-center gap-3 text-center px-6">
            <Cpu className="w-12 h-12 text-primary animate-pulse" />
            <div className="text-base font-outfit font-extrabold text-white tracking-wide uppercase">
              Simulating Machine Vision
            </div>
            <p className="text-xs text-gray-500 max-w-xs leading-relaxed">
              Real-time feed simulator rendering digital overlays. Align your device within the scanning field.
            </p>
          </div>
        </div>
      )}

      {/* AR HUD Scanning Line Animation overlay */}
      <div 
        className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-40 pointer-events-none" 
        style={{
          top: `${Math.sin((scanPulse * Math.PI) / 180) * 50 + 50}%`
        }}
      />

      {/* AR HUD Bounding Box Overlay graphics */}
      <div className="absolute inset-0 pointer-events-none select-none z-10 w-full h-full">
        {components.map((comp, idx) => {
          const isActive = activeComponentNames.includes(comp.name);
          // Coordinates in db are based on a 600x450 grid template.
          // We render absolute positions as percentages so they are fluid.
          const xPercent = (comp.bbox[0] / 600) * 100;
          const yPercent = (comp.bbox[1] / 450) * 100;
          const wPercent = (comp.bbox[2] / 600) * 100;
          const hPercent = (comp.bbox[3] / 450) * 100;

          return (
            <div
              key={idx}
              className={`absolute border-2 rounded transition-all duration-300 flex flex-col justify-start p-1 ${
                isActive
                  ? 'border-primary bg-primary/15 shadow-lg shadow-primary/20 scale-[1.01] z-20'
                  : 'border-white/20 bg-white/2'
              }`}
              style={{
                left: `${xPercent}%`,
                top: `${yPercent}%`,
                width: `${wPercent}%`,
                height: `${hPercent}%`,
              }}
            >
              {/* Box Corner Accents */}
              <span className={`absolute -top-1 -left-1 w-2.5 h-2.5 border-t-2 border-l-2 ${isActive ? 'border-primary' : 'border-white/40'}`} />
              <span className={`absolute -top-1 -right-1 w-2.5 h-2.5 border-t-2 border-r-2 ${isActive ? 'border-primary' : 'border-white/40'}`} />
              <span className={`absolute -bottom-1 -left-1 w-2.5 h-2.5 border-b-2 border-l-2 ${isActive ? 'border-primary' : 'border-white/40'}`} />
              <span className={`absolute -bottom-1 -right-1 w-2.5 h-2.5 border-b-2 border-r-2 ${isActive ? 'border-primary' : 'border-white/40'}`} />

              {/* Tag Name Banner */}
              <div className="flex items-center gap-1.5 w-max">
                <span
                  className={`text-[8px] sm:text-[10px] font-mono font-black px-1 rounded uppercase tracking-wider text-black ${
                    isActive ? 'bg-primary animate-pulse' : 'bg-white/40 text-white'
                  }`}
                >
                  {comp.name}
                </span>
                <span className={`text-[7px] sm:text-[9px] font-mono font-bold ${isActive ? 'text-primary' : 'text-gray-400'}`}>
                  {(comp.confidence * 100).toFixed(0)}%
                </span>
              </div>

              {/* Targets and guidelines for Active Component */}
              {isActive && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-6 h-6 rounded-full border border-primary/40 animate-ping absolute" />
                  {/* Dynamic target crosshair points */}
                  <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-glow" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
