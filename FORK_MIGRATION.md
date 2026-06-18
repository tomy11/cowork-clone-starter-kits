# OpenWork Fork Migration

วันที่ย้าย: 18 มิถุนายน 2026

## สิ่งที่เปลี่ยน

นำ OpenWork ออกจาก `cowork-clone-starter-kits/cowork-clone-fork/` และสร้างเป็น Git repository แยกที่:

```text
../cowork-clone-openwork
```

checkout ใหม่ใช้ branch `dev`, ติดตาม upstream และ push งานของเราไปยัง fork:

```text
origin   https://github.com/tomy11/openwork.git
upstream https://github.com/different-ai/openwork.git
```

## เหตุผลที่แยก repository

1. โฟลเดอร์ `cowork-clone-fork/` เดิมมีเพียงเอกสารและ pseudo-code ไม่มี OpenWork source code จริง
2. เอกสารเดิมอ้าง path ระดับ root เช่น `electron/main.ts` และ `src/components/` ซึ่งไม่ตรงกับ OpenWork ปัจจุบัน
3. OpenWork ปัจจุบันเป็น pnpm monorepo รองรับ desktop bridge/packaging ภายใต้ `apps/desktop` และแยกส่วนหลักไว้ใน `apps/app`, `apps/desktop` และ `apps/orchestrator`
4. การเก็บ OpenWork เป็น repository แยกช่วยให้ sync upstream, ดู diff และส่ง contribution กลับ upstream ได้โดยไม่ปะปนกับ scratch lab
5. หลีกเลี่ยง nested Git repository และลดโอกาส commit source หรือ history ของ upstream เข้า starter-kit โดยไม่ตั้งใจ

## สถานะ checkout ใหม่

- Branch: `dev`
- Tracking branch: `upstream/dev`
- Default push remote: `origin`
- Package manager ตาม `package.json`: `pnpm@11.4.0`
- Bun: `1.3.9`
- โครงสร้างที่ตรวจพบ: `apps/app`, `apps/desktop`, `apps/orchestrator`
- ติดตั้ง dependencies ด้วย `pnpm install --frozen-lockfile` สำเร็จแล้ว
- `pnpm typecheck` ผ่าน
- `pnpm build` ผ่าน (มีเพียง deprecation และ bundle-size warnings จาก upstream)
- GitHub fork: <https://github.com/tomy11/openwork>

## Remote configuration

```text
origin   https://github.com/tomy11/openwork.git
upstream https://github.com/different-ai/openwork.git
```

## Workflow สำหรับพัฒนาต่อ

```bash
cd ../cowork-clone-openwork
git checkout dev
git pull --ff-only upstream dev
git checkout -b feat/multi-agent
pnpm install --frozen-lockfile
pnpm dev
```

ควรเริ่มจากทำ baseline ให้ `pnpm typecheck`, `pnpm build` และ test ที่เกี่ยวข้องผ่านก่อน แล้วค่อยเพิ่ม multi-agent ที่ runtime/server layer พร้อมแสดง progress ผ่าน UI แทนการเพิ่ม Electron IPC ตามเอกสารเก่า
