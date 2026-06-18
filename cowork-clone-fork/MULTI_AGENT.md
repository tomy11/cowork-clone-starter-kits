# Multi-Agent Extension for OpenWork

> เพิ่ม multi-agent capability ให้ OpenWork (ซึ่งใช้ OpenCode engine)

## ทำไมต้องเพิ่ม

OpenWork ดีอยู่แล้ว แต่ทำทีละ task
ถ้าอยากได้แบบ Cowork ที่แตก sub-task ขนานได้ → ต้องเพิ่ม orchestrator

## Architecture

```
┌──────────────────────────────────────────┐
│  OpenWork UI (Electron)                  │
│  - chat + file tree + agent list view    │
└──────────────┬───────────────────────────┘
               │ IPC
┌──────────────▼───────────────────────────┐
│  Electron Main Process                   │
│  - IPC handlers                          │
│  - Multi-agent dispatcher (เพิ่มใหม่)    │
└──────────────┬───────────────────────────┘
               │ HTTP / stdio
┌──────────────▼───────────────────────────┐
│  OpenCode Engine                         │
│  - agent runtime + tools + skills + MCP  │
└──────────────────────────────────────────┘
```

## เพิ่มอะไรบ้าง

### 1. Orchestrator (TypeScript)

ไฟล์: `electron/orchestrator.ts`

```typescript
// Pseudo-code — copy จาก project 1 มา adapt
import { OpenCodeClient } from './opencode-client';

export class MultiAgentOrchestrator {
  constructor(private client: OpenCodeClient) {}

  async run(task: string, onEvent: (e: any) => void) {
    // 1. Plan
    onEvent({ kind: 'thinking', content: 'Planning...' });
    const plan = await this.plan(task);

    // 2. Execute parallel
    const results = await Promise.all(
      plan.steps.map((step) => this.runSubAgent(step, onEvent))
    );

    // 3. Synthesize
    return this.synthesize(task, results);
  }
}
```

### 2. IPC API

ไฟล์: `electron/main.ts` (extend)

```typescript
ipcMain.handle('multi_agent_run', async (event, { message, history }) => {
  const orch = new MultiAgentOrchestrator(opencodeClient);
  return await orch.run(message, (e) => {
    event.sender.send('multi_agent_event', e);
  });
});
```

### 3. UI Component

ไฟล์: `src/components/AgentOrchestrator.tsx`

```tsx
export function AgentOrchestrator() {
  const [agents, setAgents] = useState<Agent[]>([]);

  // Listen to events from main process
  useEffect(() => {
    window.api.onMultiAgentEvent((e) => {
      // update agent list, progress, etc.
    });
  }, []);

  return (
    <div>
      <h3>Active Agents</h3>
      {agents.map(a => <AgentCard key={a.id} agent={a} />)}
    </div>
  );
}
```

### 4. Config (BYOK)

ไฟล์: `.opencode/config.json`

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "models": ["claude-sonnet-4-5", "claude-opus-4-5"]
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "baseURL": "${OPENAI_BASE_URL}",
      "models": ["gpt-4o"]
    }
  },
  "defaultProvider": "anthropic",
  "maxConcurrentAgents": 4
}
```

### 5. MCP Setup

ไฟล์: `.opencode/mcp.json`

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-playwright"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${GRANTED_FOLDER}"]
    }
  }
}
```

## Step-by-step ทำ

### Day 1-2: Setup OpenWork

```bash
git clone https://github.com/different-ai/openwork.git
cd openwork
pnpm install
cp .env.example .env
# ใส่ API key
pnpm dev
```

### Day 3-4: ติดตั้ง testing skills

```bash
mkdir -p .opencode/skills
cd .opencode/skills

# Pull from anthropics/skills
git clone --depth 1 https://github.com/anthropics/skills.git anthropics

# เลือกที่ใช้
cp -r anthropics/skills/webapp-testing ./
cp -r anthropics/skills/frontend-design ./

# เพิ่ม custom skills
mkdir test-master
# (copy SKILL.md จาก project 1)
```

### Day 5-7: Multi-agent layer

```bash
# สร้างไฟล์
touch electron/orchestrator.ts
touch src/components/AgentOrchestrator.tsx

# Wire up
# - electron/main.ts: add IPC handler
# - electron/preload.ts: expose API
# - src/App.tsx: render new component
```

### Day 8-10: Test + polish

```bash
# Test workflows
pnpm test
pnpm e2e

# Test cases:
# 1. Single agent + file read/write
# 2. Multi-agent parallel (3 sub-agents)
# 3. Permission confirm dialog
# 4. Skill activation (webapp-testing)
# 5. MCP server (playwright)
```

## เปรียบเทียบกับ Project 1

| | Project 1 (from scratch) | Project 2 (fork) |
|---|---|---|
| ได้ multi-agent | เต็มรูปแบบ (เขียนเอง) | เต็มรูปแบบ (เพิ่ม orchestrator) |
| ได้ Cowork UX | ต้องทำเอง | ได้จาก OpenWork เลย |
| ได้ Skills | เขียน loader เอง | ได้จาก OpenCode |
| ได้ MCP | ต้องเขียน client | ได้จาก OpenCode |
| Permission | เขียนเอง (มีพร้อม) | ได้จาก OpenWork + extend |
| **Time to MVP** | **2 สัปดาห์** (full features) | **1 สัปดาห์** (working) |

## สรุป

**ถ้าอยากใช้เร็ว → Project 2 (fork)**
**ถ้าอยากเรียน architecture → Project 1 (scratch)**

หรือทำทั้งคู่ขนานกัน — ใช้ Project 2 เป็น "production" และ Project 1 เป็น "lab" ที่ experiment features ใหม่ๆ
