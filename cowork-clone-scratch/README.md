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

## เป้าหมาย MVP (2 สัปดาห์)

- [ ] Folder access + permission scope
- [ ] Chat UI + LLM streaming
- [ ] Single agent + tool use
- [ ] File read/write tool
- [ ] Sub-agent dispatcher (parallel)
- [ ] Skills loader (Anthropic spec)
- [ ] MCP support (basic)
- [ ] Audit log + confirm dialog
- [ ] Cross-platform build (Mac/Win/Linux)

## Quick start

```bash
pnpm install
pnpm dev          # รัน Tauri dev mode
pnpm build        # build production
```

## โครงสร้าง

```
src/                 # Frontend (React + TS)
  app.tsx
  components/
    Chat.tsx
    FileTree.tsx
    PermissionDialog.tsx
    AgentList.tsx

src-tauri/           # Rust shell
  src/
    main.rs
    commands/

core/                # Node sidecar (pure TS, ไม่ผูก Tauri)
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
    anthropic-spec.ts
  storage/
    sqlite.ts

skills/              # Anthropic Skill spec compatible
  webapp-testing/
  docx/
  pptx/
  ...
```

## LLM Providers ที่รองรับ

- Anthropic Claude (native API)
- OpenAI / OpenAI-compatible (GPT, Gemini, Ollama, GLM, etc.)

ใส่ API key ใน Settings → เก็บใน OS keychain ผ่าน Tauri
