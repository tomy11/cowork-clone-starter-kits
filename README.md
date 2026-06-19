# Cowork Clone — Built from Scratch

> Multi-agent desktop coworker — TypeScript/Node, cross-platform, BYOK LLM

## Stack

- **Runtime:** Node.js 20+ / TypeScript
- **Desktop shell:** Tauri (Rust) + web frontend (React/Vite)
- **LLM:** BYOK — Claude / OpenAI / Gemini / Ollama (ผ่าน OpenAI-compatible API)
- **Agent framework:** เขียนเอง (lightweight) — ใช้ Anthropic Skill spec
- **Sandbox:** Folder ACL + permission dialog (in-process ใน MVP, OS-level ใน v2)
- **Storage:** SQLite (better-sqlite3) + JSON config
- **IPC:** Tauri commands (frontend ↔ Rust ↔ Node sidecar)

## Quick start

```bash
cd cowork-clone-scratch
cp .env.example .env  # แล้วใส่ API key ของ provider ที่เลือก
npm install
npm test
npm run build
npm run tauri:dev
```

## โครงสร้าง

```
src/                 # Frontend (React + TypeScript)
  main.tsx
  App.tsx
  components/
    Chat.tsx
    Sidebar.tsx

src-tauri/           # Rust shell
  src/
    main.rs

core/                # Node sidecar
  agent/
    orchestrator.ts
    subagent.ts
    tools/
  llm/
    provider.ts
    claude.ts
    openai-compatible.ts
  permissions/
    acl.ts
    audit.ts
  skills/
    loader.ts

skills/              # Anthropic Skill spec compatible
  webapp-testing/
  test-master/
```

## LLM Providers ที่รองรับ

- Anthropic Claude (native API)
- OpenAI / OpenAI-compatible (GPT, Gemini, Ollama, GLM, etc.)

กำหนด provider และ API key ใน `cowork-clone-scratch/.env` โดยใช้ `.env.example` เป็นแม่แบบ
