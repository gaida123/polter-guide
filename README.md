# 👻 PolterGuide

> **Zero training. Instant proficiency.**
> An agentic AI co-pilot that physically navigates your desktop so your users never have to read a tutorial again.

---

## What is PolterGuide?

PolterGuide is an Electron desktop application that acts as an embedded AI co-pilot for any software product. Instead of forcing new users to read static help docs or sit through Zoom walkthroughs, PolterGuide's **Ghost Cursor** takes the wheel — autonomously navigating the UI and executing actions on the user's behalf, driven by simple voice commands or chat.

Administrators upload existing help documents (PDFs), and PolterGuide's AI instantly parses them into live, deployable onboarding flows. No extra tooling, no re-writing documentation, no manual tutorials.

---

## Features

- 🖱️ **Ghost Cursor** — an AI-controlled cursor that physically navigates the UI and executes actions in real time
- 🎙️ **Voice Commands** — users speak naturally; the app listens and acts via the Web Speech API
- 💬 **AI Chat** — users can type questions to the co-pilot and get contextual, step-by-step guidance
- 📄 **PDF Ingestion** — admins upload existing help docs; the Knowledge Agent parses and vectorizes them into live workflows instantly
- 🔍 **Vision Agent** — uses Google GenAI to parse the DOM and extract precise UI coordinates to drive cursor movement
- ⚡ **Sub-100ms Streaming** — WebSocket-based real-time step delivery for seamless, low-latency guidance
- 🖥️ **Cross-window Overlay** — the Electron layer renders the Ghost Cursor as a transparent overlay across any application window

---

## Tech Stack

### Frontend
| Technology | Role |
|---|---|
| React 19 + Vite | UI framework and build tooling |
| Tailwind CSS v4 | Styling |
| Framer Motion | Ghost Cursor and UI animations |
| Firebase Web SDK | Real-time event sync |
| Web Speech API | Voice input |
| Electron | Desktop wrapper + cross-window overlay |

### Backend
| Technology | Role |
|---|---|
| Python 3 + FastAPI | API server |
| WebSockets | Sub-100ms real-time step streaming |
| PyPDF + Pillow | PDF parsing and image processing |
| Firebase | State routing and persistence |

### AI & Agents
| Technology | Role |
|---|---|
| Fetch.ai uAgents | Multi-agent orchestration framework |
| Context Agent | Manages session and task state |
| Knowledge Agent | Dense vector embeddings for PDF workflow retrieval |
| Vision Agent | Google GenAI DOM parsing + coordinate extraction |
| Completion Agent | Final step synthesis and response generation |

---

## How It Works

```
User speaks or types a command
        │
        ▼
  Voice / Chat Interface (React + Web Speech API)
        │
        ▼
  FastAPI Backend (WebSocket stream)
        │
        ├──▶ Knowledge Agent  →  retrieves relevant workflow from vectorized PDFs
        ├──▶ Vision Agent     →  parses DOM, extracts target UI coordinates
        ├──▶ Context Agent    →  maintains task state across steps
        └──▶ Completion Agent →  synthesizes final step instructions
        │
        ▼
  Ghost Cursor executes actions on screen
  (Electron overlay + Framer Motion animation)
```

1. **Admin setup**: Upload a PDF help document via the dashboard. The Knowledge Agent parses and embeds it into a vector store.
2. **User interaction**: A user speaks a command ("Show me how to add a team member") or types it in the chat panel.
3. **Agent pipeline**: The agents run in parallel — retrieving the relevant workflow, identifying UI targets via vision, and streaming steps back over WebSocket.
4. **Ghost Cursor**: The animated cursor appears as an overlay, navigating to the correct UI elements and executing the required actions automatically.

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+
- Firebase project (Firestore + Realtime Database)
- Google GenAI API key
- Fetch.ai uAgents environment

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/polterguide.git
cd polterguide
```

#### Frontend (Electron + React)

```bash
cd client
npm install
cp .env.example .env   # Add your Firebase config
npm run dev            # Development mode
npm run build          # Production build
npm run dev            # Launch Electron app
```

#### Backend (FastAPI)

```bash
cd server
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # Add API keys
uvicorn main:app --reload
```

#### Agents (Fetch.ai uAgents)

```bash
cd agents
pip install -r requirements.txt
python run_agents.py
```

### Environment Variables

**Client (`.env`)**
```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_WEBSOCKET_URL=ws://localhost:8000/ws
```

**Server (`.env`)**
```
GOOGLE_GENAI_API_KEY=
FIREBASE_SERVICE_ACCOUNT_PATH=
```

---

## Project Structure

```
polterguide/
├── client/                  # Electron + React frontend
│   ├── src/
│   │   ├── components/      # UI components (GhostCursor, ChatPanel, VoiceInput)
│   │   ├── hooks/           # WebSocket and speech hooks
│   │   └── pages/           # Admin dashboard, onboarding overlay
│   ├── electron/            # Electron main process + overlay setup
│   └── vite.config.ts
│
├── server/                  # FastAPI backend
│   ├── main.py              # App entry point + WebSocket handler
│   ├── routers/             # API routes (upload, session, steps)
│   ├── services/            # PDF parsing, Firebase sync
│   └── requirements.txt
│
└── agents/                  # Fetch.ai uAgents
    ├── context_agent.py
    ├── knowledge_agent.py
    ├── vision_agent.py
    ├── completion_agent.py
    └── run_agents.py
```

---

## Challenges

- **Async/sync bridging**: The Fetch.ai uAgents framework runs asynchronous event loops that needed to be bridged with a synchronous React frontend. This required building a highly resilient WebSocket layer with reconnection logic and message queuing.
- **LLM coordinate accuracy**: Prompting the Vision Agent to consistently map UI elements to precise numerical coordinates required extensive prompt engineering and retry logic to guarantee reliable cursor targeting.

---

## Roadmap

- [ ] **Proactive intervention** — Vision Agent detects rage-clicking patterns and automatically offers help before the user asks
- [ ] **OS-level automation** — Expand the Electron client to navigate entire desktop environments, not just web UIs
- [ ] **Analytics dashboard** — Track where users get stuck most often to improve onboarding flows over time
- [ ] **Multi-language voice support** — Extend Web Speech API integration to support non-English commands
- [ ] **SaaS embedding mode** — Web SDK version for products that don't use Electron

---

## Built At

This project was built at **[Hackathon Name]** in **2025**.

---

## License

MIT License — see [LICENSE](LICENSE) for details.
