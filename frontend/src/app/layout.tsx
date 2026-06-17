import type { Metadata } from 'next';
import { Inter, Outfit } from 'next/font/google';
import './globals.css';
import Navbar from '@/components/Navbar';
import CircuitBackground from '@/components/CircuitBackground';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const outfit = Outfit({
  variable: '--font-outfit',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'RepairAI Copilot - AI-Powered Live Device Repair Assistant',
  description: 'Get real-time AI guidance for diagnosing and repairing electronics through your camera. Verify steps, identify components, and troubleshoot with a persistent chat copilot.',
  viewport: 'width=device-width, initial-scale=1.0',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${outfit.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col relative text-gray-200">
        {/* Animated circuit background behind all pages */}
        <CircuitBackground />
        
        {/* Global sticky header navbar */}
        <Navbar />
        
        {/* Main page content area */}
        <main className="flex-1 w-full max-w-7xl mx-auto px-6 py-6 md:py-10 z-10">
          {children}
        </main>
      </body>
    </html>
  );
}
