# Cowork Clone — Fork OpenWork

> เอา OpenWork + OpenCode + เพิ่ม multi-agent layer เข้าไป

## แนวคิด

**อย่าเขียนเอง** — เอาของที่มีคนทำแล้วมา extend

| Layer | ใช้ของอะไร | เราเพิ่มอะไร |
|---|---|---|
| Desktop shell | **OpenWork** (Electron app) | ปรับ UI + branding |
| Agent runtime | **OpenCode** (open-source harness) | เพิ่ม multi-agent dispatcher |
| Skills | anthropics/skills spec | ติดตั้ง webapp-testing, test-master, etc. |
| Permission | ของเดิม OpenWork | เพิ่ม policy สำหรับ production |
| MCP | ของเดิม | ต่อ Playwright MCP, GitHub MCP ฯลฯ |

## ทำไม fork OpenWork แทน Eigent

- OpenWork เป็น clone Cowork ตรงๆ (intuitive UX)
- ใช้ OpenCode = inherit ทุกอย่างของ Claude Code (skill, tool, MCP)
- โครงสร้างไม่ซับซ้อน แก้ง่ายกว่า Eigent
- Permission UI ดีกว่า (เหมาะกับ destructive action)

## ทำไมไม่ใช้ของ Eigent

- Eigent เน้น multi-agent ตั้งแต่ต้น แต่ architecture ซับซ้อนกว่า
- OpenCode-based (OpenWork) เรียนรู้ง่ายกว่า CAMEL-based (Eigent)
- ถ้าต้องการ multi-agent เพิ่มเติมภายหลัง → เพิ่มเองใน OpenWork ได้

## Quick start (2 สัปดาห์)

### Week 1: Setup + extend

```bash
# 1. Clone OpenWork
git clone https://github.com/different-ai/openwork.git
cd openwork
pnpm install

# 2. ตั้ง environment
cp .env.example .env
# ใส่ LLM_API_KEY (BYOK)

# 3. รัน dev mode
pnpm dev
```

### Week 2: Add multi-agent + testing skills

```bash
# 1. ติดตั้ง testing skills
mkdir -p .opencode/skills
git clone https://github.com/anthropics/skills .opencode/skills/anthropics
cp -r .opencode/skills/anthropics/skills/webapp-testing .opencode/skills/
cp -r .opencode/skills/anthropics/skills/frontend-design .opencode/skills/

# 2. เพิ่ม multi-agent dispatcher
# ดูรายละเอียดใน MULTI_AGENT.md
```

## ไฟล์ที่จะแก้

```
openwork/
├── src/                          # Electron renderer
│   ├── App.tsx                   # main UI
│   ├── components/
│   │   ├── ChatPanel.tsx         # ✅ เพิ่ม agent list view
│   │   ├── FileTree.tsx          # (ไม่แก้)
│   │   └── AgentOrchestrator.tsx # ✅ ใหม่ — sub-agent UI
│   └── lib/
│       └── orchestrator.ts       # ✅ ใหม่ — multi-agent client
│
├── electron/                     # Main process
│   ├── main.ts                   # ✅ เพิ่ม IPC handler สำหรับ multi-agent
│   └── preload.ts                # ✅ expose API
│
├── .opencode/
│   ├── config.json               # ✅ BYOK config
│   ├── skills/                   # ✅ Anthropic skills
│   │   ├── webapp-testing/
│   │   ├── test-master/
│   │   ├── frontend-design/
│   │   └── custom/
│   └── mcp.json                  # ✅ MCP servers
│
└── MULTI_AGENT.md                # ดูไฟล์แนบ
```

## Multi-agent extension

ดูรายละเอียดใน [MULTI_AGENT.md](./MULTI_AGENT.md) — เพิ่ม layer ที่:
1. รับ task จาก chat
2. เรียก OpenCode agent หลายตัวขนานกัน
3. รวมผลลัพธ์กลับมา
4. แสดง progress ใน UI

## Skills ที่ติดตั้งแนะนำ

จาก anthropics/skills + community:

| Skill | ใช้ทำอะไร |
|---|---|
| `webapp-testing` | Playwright E2E test |
| `test-master` | เขียน test case + coverage analysis |
| `frontend-design` | สร้าง UI สวยๆ หลีกเลี่ยง "AI slop" |
| `docx`, `pptx`, `xlsx`, `pdf` | Office docs |
| `mcp-builder` | สร้าง MCP server ใหม่ |
| `web-testing` | Web app testing (Playwright) |
| `systematic-debugging` | Root cause analysis |
| `tdd-workflow` | TDD discipline |

## License

Inherits MIT from OpenWork. เพิ่มของเราเองก็เอา MIT ได้
