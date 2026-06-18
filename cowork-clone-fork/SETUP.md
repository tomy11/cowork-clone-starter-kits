# Setup Guide — Project 2 (Fork OpenWork)

## ขั้นตอนเต็ม 2 สัปดาห์

### Day 1 (จันทร์): Setup + explore

```bash
# 1. Install prerequisites
# - Node.js 20+
# - pnpm: npm i -g pnpm
# - Rust (สำหรับ Tauri/Electron native modules)

# 2. Clone OpenWork
git clone https://github.com/different-ai/openwork.git
cd openwork
pnpm install

# 3. ทำความเข้าใจ codebase
# อ่าน README + src/ structure
# ลอง pnpm dev เล่นดู
```

### Day 2-3 (อังคาร-พุธ): Skills + MCP

```bash
# 1. ติดตั้ง testing skills
mkdir -p .opencode/skills
cd .opencode/skills

# Pull Anthropic official skills
git clone --depth 1 https://github.com/anthropics/skills.git

# Copy ที่ต้องใช้
cp -r anthropics/skills/webapp-testing ./
cp -r anthropics/skills/frontend-design ./
cp -r anthropics/skills/mcp-builder ./

# 2. ติดตั้ง MCP servers
# (ทำใน .opencode/mcp.json)
```

### Day 4-5 (พฤหัส-ศุกร์): Multi-agent layer

```bash
# 1. สร้าง orchestrator
# ไฟล์: electron/orchestrator.ts
# Logic: plan → parallel dispatch → synthesize

# 2. Wire up IPC
# ไฟล์: electron/main.ts (เพิ่ม handler)
# ไฟล์: electron/preload.ts (expose API)

# 3. UI
# ไฟล์: src/components/AgentOrchestrator.tsx
# แสดง active agents + progress
```

### Day 6-7 (เสาร์-อาทิตย์): Test + iterate

```bash
# Test scenarios:
# 1. Single agent read/write file
# 2. Multi-agent (3 tasks ขนาน)
# 3. Permission confirm dialog
# 4. Skill activation: webapp-testing
# 5. MCP: playwright
# 6. Error handling
```

### Day 8-10 (จันทร์-พุธ): Polish + docs

```bash
# 1. เพิ่ม custom testing skill
# 2. ปรับ UI
# 3. เขียน README + screenshots
# 4. Test กับ 2-3 คน
```

## Configuration files

### .opencode/config.json
```json
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "models": ["claude-sonnet-4-5"]
    }
  },
  "defaultProvider": "anthropic",
  "maxConcurrentAgents": 4
}
```

### .opencode/mcp.json
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${GRANTED_FOLDER}"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-playwright"]
    }
  }
}
```

## Testing checklist

- [ ] Folder access permission works
- [ ] Read file
- [ ] Write file (with confirm)
- [ ] Delete file (with confirm)
- [ ] List directory
- [ ] Search files
- [ ] Multi-agent parallel (3+ agents)
- [ ] Skill: webapp-testing activates
- [ ] MCP: playwright works
- [ ] Audit log records actions
- [ ] Cross-platform: Mac/Win/Linux

## Known issues & workarounds

### Issue: Tauri build fail บน Windows
**Fix:** ติดตั้ง Visual Studio Build Tools + WebView2

### Issue: OpenCode crashes on large file
**Fix:** เพิ่ม file size limit ใน orchestrator config

### Issue: Permission bypassed
**Fix:** ตรวจ ACL pattern ให้ตรงกันทุก tool
