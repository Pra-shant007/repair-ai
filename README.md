# RepairAI Copilot - AI-Powered Live Device Repair Assistant

RepairAI Copilot is a premium, startup-grade web platform designed for a national-level hackathon showcase. It serves as an AI technician standing beside the user, continuously monitoring the repair process via a camera feed, verifying step completions, and guiding users safely.

---

## 🎨 Theme & Architecture
- **Design Inspiration**: Apple, OpenAI, Tesla, Stripe, Linear.
- **Tech Stack**: Next.js (App Router), React, TypeScript, Tailwind CSS, Framer Motion, Express (TypeScript), MongoDB/Mongoose.
- **Database Fallback**: Automatically activates a local mock memory datastore if no MongoDB connection string is provided.
- **Hands-Free Operation**: Uses the Web Speech API for Text-to-Speech (reading directions aloud) and Speech-to-Text (processing voice navigation commands).
- **Step Verification**: Runs a background loop that takes webcam frames every 3 seconds to verify step completion.
- **Safety Mode**: Visual warning banner and progression lock for high-risk steps.
- **AI Chat Assistant**: Persistent chatbot sidebar assisting with troubleshooting.

---

## 📂 Repository Structure
```
repair-ai/
├── package.json                   # Root package & workspace manager
├── database/
│   └── mongo-schemas.json         # MongoDB schemas documentation
├── backend/
│   ├── package.json               # Backend setup
│   ├── tsconfig.json              # TypeScript compilation setup
│   └── src/
│       ├── index.ts               # Express Server Entrypoint
│       ├── config/db.ts           # Mongoose DB connection & mock database fallback
│       ├── models/                # User, Diagnostic, Repair, and Report schemas
│       ├── routes/                # Auth, AI, and Repair routes
│       └── controllers/           # API handlers for auth, step verification, and chat
└── frontend/
    ├── package.json               # Next.js setup
    └── src/
        ├── app/                   # App Router pages (Landing, Diagnose, Dashboard)
        ├── components/            # UI components (CircuitCanvas, CameraFeed, Chatbot)
        └── utils/                 # PDF generator & Guide scenarios
```

---

## 🚀 Getting Started

### 1. Prerequisite Installations
Ensure you have **Node.js (v18+)** and **npm** installed.

### 2. Install Dependencies
Run this command from the root folder to install packages for both services:
```bash
npm run install:all
```

### 3. Run the Applications
Start both the Express API backend and Next.js frontend concurrently in developer mode:
```bash
npm run dev
```
- **Backend API**: `http://localhost:5000`
- **Frontend Client**: `http://localhost:3000`

---

## 🛠️ Demo Scenarios Available
Select any of these high-fidelity mock paths in the Live Repair page to see full bounding boxes, safety instructions, and step verification:
1. **RAM Upgrade** (HP Pavilion 15)
2. **SSD Installation** (Dell Inspiron Desktop)
3. **Laptop Not Booting** (MacBook Air 13")
4. **Charging Port Issue** (Samsung Galaxy S21)
5. **WiFi Adapter Issue** (Linksys AC1900 Router)
