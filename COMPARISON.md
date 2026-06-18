# เปรียบเทียบ 2 แนวทาง + Roadmap

## TL;DR

ผม scaffold ทั้ง **2 projects** ไว้ใน `/workspace`:

| Project | Path | เวลา | ได้อะไร |
|---|---|---|---|
| **1. From scratch** | `cowork-clone-scratch/` | 2 สัปดาห์ (full features) | Custom multi-agent orchestrator, full control |
| **2. Fork OpenWork** | `cowork-clone-fork/` | 1 สัปดาห์ (working) | Production-grade UI + extend multi-agent |

**คำแนะนำ:** ทำ Project 2 ก่อน (ได้ใช้ไว + เรียนรู้ OpenWork) แล้วค่อยทำ Project 1 เป็น "lab"

---

## โครงสร้างไฟล์

```
/workspace/
├── COMPARISON.md          ← ไฟล์นี้
├── cowork-clone-scratch/  ← Project 1: from scratch
│   ├── README.md
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   ├── core/
│   │   ├── index.ts                  # stdio JSON-RPC entry
│   │   ├── agent/
│   │   │   ├── orchestrator.ts       # Plan → parallel dispatch → synthesize
│   │   │   ├── subagent.ts           # Single agent + tool use
│   │   │   └── tools/
│   │   │       ├── registry.ts
│   │   │       └── file-tools.ts     # read/write/list/move/delete/search
│   │   ├── llm/
│   │   │   ├── provider.ts           # Interface
│   │   │   ├── claude.ts             # Claude adapter
│   │   │   └── openai-compatible.ts  # GPT/Gemini/Ollama/GLM
│   │   ├── permissions/
│   │   │   ├── acl.ts                # Folder ACL
│   │   │   └── audit.ts              # Audit log (SQLite)
│   │   └── skills/
│   │       └── loader.ts             # Anthropic skill spec
│   ├── skills/
│   │   ├── webapp-testing/SKILL.md
│   │   └── test-master/SKILL.md
│   ├── src/                          # React frontend
│   │   ├── App.tsx
│   │   └── components/
│   │       ├── Chat.tsx
│   │       └── Sidebar.tsx
│   └── src-tauri/                    # Rust shell
│       ├── Cargo.toml
│       ├── build.rs
│       ├── tauri.conf.json
│       └── src/main.rs
│
└── cowork-clone-fork/    ← Project 2: fork OpenWork
    ├── README.md
    ├── SETUP.md          ← step-by-step 2 weeks
    ├── MULTI_AGENT.md    ← how to add orchestrator
    └── .env.example
```

---

## ตารางเปรียบเทียบ

| มิติ | Project 1 (scratch) | Project 2 (fork) |
|---|---|---|
| **เวลา** | 2 สัปดาห์ (full) | 1 สัปดาห์ (working) |
| **ความยาก** | สูง | กลาง |
| **Customization** | 100% (เขียนเองหมด) | 70% (extend ของเดิม) |
| **Risk** | ต้อง test เองทั้งหมด | Risk น้อยกว่า (ใช้ของ proven) |
| **เรียนรู้** | เข้าใจ architecture ลึก | เรียนรู้ OpenCode/OpenWork |
| **Maintenance** | ทำเองตลอด | ได้อัปเดตจาก upstream |
| **Production-ready** | ต้อง harden เอง | เกือบจะใช้ได้เลย |
| **Cross-platform** | Tauri (Mac/Win/Linux) | Electron (Mac/Win/Linux) |

---

## แผน 2 สัปดาห์

### Week 1: Project 2 (fork OpenWork) — เน้น quick win

| วัน | ทำอะไร |
|---|---|
| จันทร์ | Clone OpenWork + explore + setup BYOK |
| อังคาร | ติดตั้ง testing skills (webapp-testing, test-master) |
| พุธ | ติดตั้ง MCP servers (filesystem, playwright) |
| พฤหัส | เริ่มเพิ่ม orchestrator (electron/orchestrator.ts) |
| ศุกร์ | Wire up IPC + UI agent list |
| เสาร์ | Test single-agent workflows |
| อาทิตย์ | Test multi-agent parallel + permission flows |

### Week 2: Project 1 (scratch) — เน้น architecture

| วัน | ทำอะไร |
|---|---|
| จันทร์ | Setup Tauri + scaffold |
| อังคาร | Implement LLM providers (Claude + OpenAI-compat) |
| พุธ | Permission ACL + audit log |
| พฤหัส | Orchestrator + sub-agent (logic หลัก) |
| ศุกร์ | File tools + skills loader |
| เสาร์ | React UI (chat + sidebar) |
| อาทิตย์ | Test + integration + build |

---

## แนวทางเลือก (ทางเลือกที่ 3)

ถ้าเวลาน้อยมาก หรืออยากได้ production-ready ก่อน:

1. ใช้ **Eigent** (open source multi-agent) — เอามาใช้ได้เลย ไม่ต้อง build
2. ใช้ **OpenWork** — clone 1:1 ของ Cowork ใช้ได้เลย
3. ใช้ **Claude Code CLI** + Skills — ถ้า CLI ก็พอ

แต่ถ้าอยาก **เรียนรู้ + customize ได้** → ทำตามแผน Week 1+2 ข้างบน

---

## ถามที่อาจติด

**Q: ต้อง Rust ไหม?**
A: Project 1 (Tauri) ใช่, Project 2 (OpenWork = Electron) ไม่ต้อง

**Q: ใช้ local LLM ได้ไหม?**
A: ได้ — ใส่ baseURL เป็น Ollama หรือ LM Studio (OpenAI-compatible)

**Q: จะเผยแพร่ให้คนอื่นใช้ได้ไหม?**
A: ได้ แต่ BYOK = คนใช้ต้องมี API key เอง

**Q: แพ็กเกจ .dmg / .exe / .AppImage ได้ไหม?**
A: ได้ทั้งคู่ (Tauri/Electron มี bundler)

**Q: ทำไมไม่ใช้ Eigent เลย?**
A: Eigent เป็น multi-agent ตั้งแต่ต้น architecture ซับซ้อนกว่า fork OpenWork ถ้าเริ่มใหม่และอยากเรียนรู้ — fork ตรงกว่า แต่ถ้าอยากได้ทันที Eigent ใช้ได้เลย
