'use client';

import React, { useEffect, useRef } from 'react';

interface Point {
  x: number;
  y: number;
}

interface Path {
  points: Point[];
  progress: number;
  speed: number;
  color: string;
}

export default function CircuitBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    // Track window resize
    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    // Fixed static circuit lines to draw under the active pulses
    const staticLines: Point[][] = [];
    const numLines = 25;

    // Generate random circuit-like paths (straight lines with 45/90 degree bends)
    for (let i = 0; i < numLines; i++) {
      const startX = Math.random() * width;
      const startY = Math.random() * height;
      const points: Point[] = [{ x: startX, y: startY }];

      let currX = startX;
      let currY = startY;
      const segments = 3 + Math.floor(Math.random() * 3);

      for (let j = 0; j < segments; j++) {
        const length = 50 + Math.random() * 150;
        const dir = Math.floor(Math.random() * 4); // 0: Right, 1: Down, 2: Left, 3: Up

        if (dir === 0) currX += length;
        else if (dir === 1) currY += length;
        else if (dir === 2) currX -= length;
        else currY -= length;

        // Force diagonal/angled circuit bends
        if (Math.random() > 0.5) {
          currX += (Math.random() > 0.5 ? 20 : -20);
          currY += (Math.random() > 0.5 ? 20 : -20);
        }

        points.push({ x: currX, y: currY });
      }
      staticLines.push(points);
    }

    // Active electrical data pulses running down paths
    let activePaths: Path[] = [];

    const spawnPath = () => {
      if (activePaths.length > 15) return;
      const sourceLine = staticLines[Math.floor(Math.random() * staticLines.length)];
      if (!sourceLine || sourceLine.length < 2) return;

      activePaths.push({
        points: [...sourceLine],
        progress: 0,
        speed: 0.005 + Math.random() * 0.01,
        color: Math.random() > 0.4 ? '#00f0ff' : '#8a2be2'
      });
    };

    // Spawn initial paths
    for (let i = 0; i < 8; i++) spawnPath();

    // Spawn interval
    const spawnInterval = setInterval(spawnPath, 1500);

    // Draw grid node circles
    const drawNodes = () => {
      if (!ctx) return;
      ctx.fillStyle = 'rgba(0, 240, 255, 0.04)';
      const step = 80;
      for (let x = 0; x < width; x += step) {
        for (let y = 0; y < height; y += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    // Main animation loop
    const animate = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);

      // 1. Draw grid background nodes
      drawNodes();

      // 2. Draw static circuit tracks (dim lines)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
      ctx.lineWidth = 1;
      staticLines.forEach((line) => {
        ctx.beginPath();
        ctx.moveTo(line[0].x, line[0].y);
        for (let k = 1; k < line.length; k++) {
          ctx.lineTo(line[k].x, line[k].y);
        }
        ctx.stroke();
        
        // Draw connector circles at nodes
        ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
        line.forEach((p) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        });
      });

      // 3. Draw moving glow paths
      activePaths.forEach((path, pathIdx) => {
        const pts = path.points;
        const totalSegments = pts.length - 1;
        const currentSegmentProgress = path.progress * totalSegments;
        const segmentIdx = Math.floor(currentSegmentProgress);
        const segmentPercent = currentSegmentProgress - segmentIdx;

        if (segmentIdx >= totalSegments) {
          activePaths.splice(pathIdx, 1);
          return;
        }

        const p1 = pts[segmentIdx];
        const p2 = pts[segmentIdx + 1];

        // Interpolated position of the pulse
        const currX = p1.x + (p2.x - p1.x) * segmentPercent;
        const currY = p1.y + (p2.y - p1.y) * segmentPercent;

        // Draw electrical pulse tail (line from segment start to current)
        ctx.strokeStyle = path.color;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = path.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        for (let m = 1; m <= segmentIdx; m++) {
          ctx.lineTo(pts[m].x, pts[m].y);
        }
        ctx.lineTo(currX, currY);
        ctx.stroke();
        ctx.shadowBlur = 0; // Reset shadow

        // Draw pulsing head circle
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = path.color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(currX, currY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        path.progress += path.speed;
      });

      animationId = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      cancelAnimationFrame(animationId);
      clearInterval(spawnInterval);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed top-0 left-0 w-full h-full -z-10 pointer-events-none" />;
}
