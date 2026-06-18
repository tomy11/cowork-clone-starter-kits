# Cowork Clone — Project Direction

## Current decision

แยกแนวทาง OpenWork fork ออกจาก starter-kit repository นี้แล้ว โดยใช้ checkout แยกที่:

```text
../cowork-clone-openwork
```

Repository นี้จึงเก็บเฉพาะ `cowork-clone-scratch/` สำหรับทดลอง architecture และศึกษา agent runtime ที่เขียนเอง

รายละเอียดการย้ายและเหตุผลอยู่ใน [FORK_MIGRATION.md](./FORK_MIGRATION.md)

## เปรียบเทียบแนวทาง

| แนวทาง | ตำแหน่ง | บทบาท |
|---|---|---|
| OpenWork | `../cowork-clone-openwork` | ฐานสำหรับผลิตภัณฑ์และการพัฒนาต่อจริง |
| From scratch | `cowork-clone-scratch/` | Lab สำหรับศึกษา orchestrator, LLM adapters, permissions และ skills |

## คำแนะนำ

พัฒนาฟีเจอร์ใช้งานจริงบน OpenWork ก่อน เพราะมี desktop shell, OpenCode integration, skills, permissions, server/runtime และ UI ที่พร้อมกว่า ส่วน scratch project ควรใช้เพื่อทดลองแนวคิดที่แยกขอบเขตชัดเจน แล้วค่อยย้ายเฉพาะสิ่งที่พิสูจน์แล้วไปยัง OpenWork

