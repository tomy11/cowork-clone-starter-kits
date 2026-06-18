---
name: webapp-testing
description: ใช้ Playwright ทดสอบ web application แบบ end-to-end — รัน browser จริง, capture screenshot, verify UI
---

# Web App Testing

## เมื่อไหร่ใช้

User ขอ "test", "ทดสอบ", "verify", "QA", "เช็คว่า" + web app / URL / frontend feature

## ต้องการ

- URL หรือ path ของ app (local dev server เช่น http://localhost:3000)
- คำอธิบาย test scenario (อาจ derive จาก requirement)
- **ต้องติดตั้ง Playwright MCP server** ใน `~/.cowork-clone/mcp.json`

## Workflow

1. เช็ค Playwright MCP พร้อมใช้ไหม → ถ้าไม่ บอก user ให้ติดตั้ง
2. Generate Playwright test script ตาม scenario
3. รัน script → capture screenshot ทุก step
4. วิเคราะห์ผล → สรุป pass/fail พร้อม screenshot paths
5. ถ้า fail → ดู DOM + console log → suggest fix

## Output format

```
## Test Result: <scenario>

**Status:** ✅ Pass / ❌ Fail
**Duration:** Xs
**Screenshots:** ./screenshots/<scenario>-{1,2,3}.png

### Steps
1. ✅ Navigate to /login
2. ✅ Fill credentials
3. ❌ Submit form — got error "Invalid email"

### Suggestion
ตรวจ email format validation ที่ client side...
```

## Best practices

- ใช้ `data-testid` เป็น selector หลัก ถ้ามี
- รอ network idle ก่อน assert
- Capture screenshot ก่อน-หลัง action สำคัญ
- ตั้ง viewport เป็น 1280x720 เป็น default
