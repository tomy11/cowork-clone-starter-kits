---
name: document-creator
description: สร้างไฟล์เอกสาร xlsx, docx, pdf, csv โดยตรง — ห้ามเขียน setup script ให้ user รันเอง ต้องสร้างไฟล์จริงใน session นี้เลย
---

# Document Creator

## หลักการสำคัญ (อ่านก่อนทุกครั้ง)

**ห้ามเด็ดขาด:**
- เขียน script แล้วบอกให้ user ไปรันเอง
- สร้าง `setup_and_generate.py`, `install_requirements.sh` หรือไฟล์กลางใดๆ
- สร้าง `run.sh`, `generate.py`, `gen_doc.py` หรือ helper script ชั่วคราวไว้ใน workspace
- บอกว่า "คุณต้องรัน..." หรือ "เปิด Terminal แล้ว..."
- ทิ้งไฟล์ที่ไม่ใช่ output ที่ user ขอไว้ในรายการ Files

**ต้องทำ:**
- สร้างไฟล์ปลายทาง (.xlsx / .docx / .pdf) ด้วย tool โดยตรง
- ถ้าต้องรัน code ให้ใช้ `run_command` แบบ inline ทันที อย่าเขียนไฟล์ script แยก
- รายงานผลว่าสร้างไฟล์อะไร ที่ path ไหน

---

## เลือก tool ให้ถูกต้อง

### สร้าง Excel (.xlsx)

ใช้ tool `create_spreadsheet` เสมอ:

```
create_spreadsheet({
  path: "/absolute/path/to/output.xlsx",
  sheets: [
    {
      name: "Sheet1",
      headers: ["ID", "ชื่อ", "สถานะ", "Priority"],
      rows: [
        ["TC-001", "Login ปกติ", "Pass", "P0"],
        ["TC-002", "Password ผิด", "Pass", "P1"]
      ]
    }
  ]
})
```

ถ้าต้องการ format พิเศษ (สี, conditional formatting) ที่ tool ทำไม่ได้ → ใช้ `run_command` รัน Python inline (ดูด้านล่าง)

### สร้าง Word (.docx)

ใช้ tool `create_document` เสมอ:

```
create_document({
  path: "/absolute/path/to/output.docx",
  title: "รายงานสรุป",
  sections: [
    { type: "heading", level: 1, text: "บทนำ" },
    { type: "paragraph", text: "เนื้อหา..." },
    { type: "table", headers: ["หัวข้อ", "รายละเอียด"], rows: [["A", "B"]] },
    { type: "bullets", items: ["ข้อ 1", "ข้อ 2"] }
  ]
})
```

### สร้าง PDF

PDF ต้องใช้ `run_command` รัน Python inline:

```
run_command({
  command: "python3 -c \"\nimport sys\ntry:\n    from reportlab.lib.pagesizes import A4\n    from reportlab.pdfgen import canvas\nexcept ImportError:\n    import subprocess\n    subprocess.run([sys.executable, '-m', 'pip', 'install', 'reportlab', '-q'])\n    from reportlab.lib.pagesizes import A4\n    from reportlab.pdfgen import canvas\n\nc = canvas.Canvas('/workspace/output.pdf', pagesize=A4)\nc.setFont('Helvetica', 14)\nc.drawString(72, 750, 'หัวเรื่อง')\nc.save()\nprint('Created /workspace/output.pdf')\n\"",
  cwd: "/workspace",
  write: true,
  outputs: ["/workspace/output.pdf"]
})
```

**pattern สำหรับ PDF ที่ซับซ้อน:**
1. เขียน Python ทั้งหมดเป็น string ใน `command`
2. ใส่ auto-install dependency ไว้ใน script นั้น ถ้าจำเป็นต้องใช้ network ให้ขออนุญาตด้วย `network: "bridge"`
3. รัน `run_command` พร้อม `write: true`, `outputs: [...]` และสร้าง output ใต้ `/workspace` เลย — ไม่ต้องสร้างไฟล์ .py แยก

### สร้าง CSV

ใช้ `write_file` ธรรมดา — CSV เป็น text:

```
write_file({
  path: "/path/to/output.csv",
  content: "ID,Name,Status\nTC-001,Login,Pass\nTC-002,Logout,Pass"
})
```

---

## กรณี Python ต้องซับซ้อน (หลายสิบบรรทัด)

ยังคงต้องใช้ `run_command` แบบ inline เท่านั้น:

1. ส่ง code ผ่าน `python3 -c "..."` หรือ shell heredoc ใน `command`
2. ให้ code สร้างเฉพาะไฟล์ output ที่ user ขอ
3. ห้ามใช้ `write_file` เพื่อสร้าง script ชั่วคราวใน workspace

ถ้า inline command ยาวเกินกว่าจะทำได้อย่างมั่นใจ ให้ลด scope, ใช้ built-in document tools, หรือบอก user อย่างตรงไปตรงมาว่าต้องการ feature เพิ่มเติม แทนการทิ้ง helper script ไว้ใน workspace

---

## ตัวอย่าง workflow ที่ถูกต้อง

User: "แปลง CSV นี้เป็น Excel และ PDF"

**ถูก:**
1. `read_file` อ่าน CSV
2. `create_spreadsheet` สร้าง .xlsx ทันที
3. `run_command` รัน Python สร้าง PDF ทันที พร้อมระบุ `outputs`
4. รายงาน: "สร้างแล้ว:\n- output.xlsx\n- output.pdf"

**ผิด:**
1. เขียน `setup_and_generate.py`
2. บอก user ว่า "รัน `python3 setup_and_generate.py`"

---

## library Python ที่แนะนำ

| ไฟล์ | Library | install |
|------|---------|---------|
| PDF (simple) | reportlab | `pip install reportlab` |
| PDF (HTML→PDF) | weasyprint | `pip install weasyprint` |
| Excel (advanced) | openpyxl | `pip install openpyxl` |
| Word (alternative) | python-docx | `pip install python-docx` |

Auto-install ใน script เสมอ — อย่า assume ว่า user มี library อยู่แล้ว
