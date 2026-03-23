# 👻 PolterGuide

> **Zero training. Instant proficiency.**
> An agentic AI co-pilot that physically navigates your desktop so your users never have to read a tutorial again.

🎥 **[Watch the Demo](https://youtube.com/watch?si=o2I0cG0U4y-U2UL3&v=hNtSjinxCUk&feature=youtu.be)**

---

## Inspiration

Modern B2B SaaS dashboards look like spaceship control panels, causing companies to bleed up to 30% of new users to onboarding friction. Customer Success Managers burn half their week playing human GPS on Zoom, while static PDFs are ignored. Great software shouldn't come with homework — so we built a solution that actually takes the wheel.

---

## What is PolterGuide?

PolterGuide is a desktop application (built with Electron) that acts as an agentic AI co-pilot, living as a transparent overlay on top of any app on your computer. Instead of forcing new users to read static help docs or sit through Zoom walkthroughs, PolterGuide's **Ghost Cursor** takes the wheel — autonomously navigating the UI and executing actions on the user's behalf, driven by simple voice commands or chat.

Administrators upload existing help documents (PDFs) via the admin dashboard, and PolterGuide's AI instantly parses them into live, deployable onboarding flows. No extra tooling, no re-writing documentation, no manual tutorials.

---

## Features

- 🖱️ **Ghost Cursor** — an AI-controlled cursor that physically navigates the UI and executes actions in real time as a transparent Electron overlay
- 🎙️ **Voice Commands** — users speak naturally; the app listens and acts via the Web Speech API
- 💬 **AI Chat** — users can ask the co-pilot questions mid-task and get contextual, step-by-step guidance in real time
- 📄 **PDF Ingestion** — admins upload existing help docs; the Knowledge Agent parses and vectorizes them into live onboarding workflows instantly
- 🔍 **Vision Agent** — uses Google GenAI to parse the DOM and extract precise UI coordinates to drive cursor movement
- ⚡ **Sub-100ms Streaming** — WebSocket-based real-time step delivery for seamless, low-latency guidance
- 🖥️ **Cross-window Overlay** — Electron renders the Ghost Cursor as a transparent overlay across any application window
- 🗣️ **ElevenLabs TTS** — spoken audio responses via ElevenLabs Sarah voice

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

### Electron
| Technology | Role |
|---|---|
| Electron | Desktop wrapper + cross-window transparent overlay |

### Backend
| Technology | Role |
|---|---|
| Python 3 + FastAPI | API server |
| WebSockets | Sub-100ms real-time step streaming |
| PyPDF + Pillow | PDF parsing and image processing |
| Firebase | State routing and persistence |
| ElevenLabs API | Text-to-speech voice output |

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

1. **Admin setup**: Upload a PDF help document via the admin dashboard at [handoffai.vercel.app](https://handoffai.vercel.app). The Knowledge Agent parses and embeds it into a vector store.
2. **User interaction**: A user speaks a command (e.g. "Show me how to add a team member") or types in the chat panel.
3. **Agent pipeline**: The agents run in parallel — retrieving the relevant workflow, identifying UI targets via vision, and streaming steps back over WebSocket.
4. **Ghost Cursor**: The animated cursor appears as a transparent overlay, navigating to the correct UI elements and executing the required actions automatically.

---

## Project Structure

```
polter-guide/
├── frontend/          # React 19 + Vite — the co-pilot UI panel
├── electron/          # Electron main process + transparent overlay
├── backend/           # Python 3 + FastAPI + Fetch.ai agents
├── demo-site/         # Fake "Acme Corp IT" site used for hackathon demo
├── website/           # Marketing/landing site
└── sop_acme_google_setup.pdf  # Sample SOP used to demo PDF ingestion
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+
- Firebase project (Firestore + Realtime Database)
- Google GenAI API key
- Fetch.ai uAgents environment
- ElevenLabs API key

### 1. Frontend

```bash
cd frontend
npm install
cp .env.example .env   # Add your Firebase config
npm run dev
```

### 2. Electron App

```bash
cd electron
npm install
npm run dev
```

> Run the `frontend` and `electron` dev servers at the same time.

### 3. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # Add your API keys
uvicorn main:app --reload
```

### Environment Variables

**Frontend (`.env`)**
```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_WEBSOCKET_URL=ws://localhost:8000/ws
```

**Backend (`.env`)**
```
GOOGLE_GENAI_API_KEY=
FIREBASE_SERVICE_ACCOUNT_PATH=
ELEVENLABS_API_KEY=
```

---

## Challenges

- **Async/sync bridging**: The Fetch.ai uAgents framework runs asynchronous event loops that needed to be bridged with a synchronous React frontend. This required building a highly resilient WebSocket layer with reconnection logic and message queuing.
- **LLM coordinate accuracy**: Prompting the Vision Agent to consistently map UI elements to precise numerical coordinates required extensive prompt engineering and retry logic to guarantee reliable cursor targeting.

---

## What We Learned

Building agentic software requires shifting from rigid, deterministic state machines to managing probabilistic workflows. We leveled up heavily in WebSocket transport, advanced DOM manipulation, and coordinating Fetch.ai's framework with Google's Generative AI.

---

## What's Next for PolterGuide

- **Proactive intervention** — the Vision Agent detects rage-clicking and automatically offers help before the user even asks
- **OS-level automation** — expand the Electron client to navigate entire desktop environments, not just web UIs
- **Lightweight embeddable SDK** — ship a native SDK that any SaaS product can drop into their app, letting PolterGuide navigate their specific UI without needing a separate desktop install
- **Live AI voice conversation** — real-time back-and-forth voice chat so users can ask follow-up questions mid-task and get spoken answers instantly
- **Analytics dashboard** — surface where users get stuck most often so teams can continuously improve their onboarding flows

---

## Built At

Built at **ProduHacks 2026**.

🎥 **[Watch the full demo on YouTube](https://youtube.com/watch?si=o2I0cG0U4y-U2UL3&v=hNtSjinxCUk&feature=youtu.be)**

---

## License

MIT License — see [LICENSE](LICENSE) for details.
