---
name: document-creator
description: สร้างไฟล์เอกสาร xlsx, docx, pdf, csv โดยตรง — ห้ามเขียน setup script ให้ user รันเอง ต้องสร้างไฟล์จริงใน session นี้เลย
---

# Document Creator

## หลักการสำคัญ (อ่านก่อนทุกครั้ง)

**ห้ามเด็ดขาด:**
- เขียน script แล้วบอกให้ user ไปรันเอง
- สร้าง `setup_and_generate.py`, `install_requirements.sh` หรือไฟล์กลางใดๆ
- บอกว่า "คุณต้องรัน..." หรือ "เปิด Terminal แล้ว..."

**ต้องทำ:**
- สร้างไฟล์ปลายทาง (.xlsx / .docx / .pdf) ด้วย tool โดยตรง
- ถ้าต้องรัน code ให้ใช้ `run_command` ทันที อย่าเขียนไฟล์ script ให้ user รัน
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
  command: "python3 -c \"\nimport sys\ntry:\n    from reportlab.lib.pagesizes import A4\n    from reportlab.pdfgen import canvas\nexcept ImportError:\n    import subprocess\n    subprocess.run([sys.executable, '-m', 'pip', 'install', 'reportlab', '-q'])\n    from reportlab.lib.pagesizes import A4\n    from reportlab.pdfgen import canvas\n\nc = canvas.Canvas('/path/to/output.pdf', pagesize=A4)\nc.setFont('Helvetica', 14)\nc.drawString(72, 750, 'หัวเรื่อง')\nc.save()\nprint('Created /path/to/output.pdf')\n\"",
  cwd: "/workspace/path"
})
```

**pattern สำหรับ PDF ที่ซับซ้อน:**
1. เขียน Python ทั้งหมดเป็น string ใน `command`
2. ใส่ auto-install dependency ไว้ใน script นั้น
3. รัน `run_command` เลย — ไม่ต้องสร้างไฟล์ .py แยก

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

ถ้า Python script ยาวเกินจะใส่ใน `command` inline ได้สะดวก:

1. `write_file` เขียน script ไปที่ `/tmp/gen_doc.py` (หรือ workspace temp)
2. `run_command` รัน `python3 /tmp/gen_doc.py`
3. (optional) ลบไฟล์ temp ด้วย `delete_file`

```
write_file({ path: "/tmp/gen_doc.py", content: "...โค้ด Python ยาวๆ..." })
run_command({ command: "python3 /tmp/gen_doc.py", cwd: "/workspace" })
delete_file({ path: "/tmp/gen_doc.py" })
```

**ยังคงห้าม:** เขียน script ไว้ใน workspace แล้วบอก user ให้รันเอง

---

## ตัวอย่าง workflow ที่ถูกต้อง

User: "แปลง CSV นี้เป็น Excel และ PDF"

**ถูก:**
1. `read_file` อ่าน CSV
2. `create_spreadsheet` สร้าง .xlsx ทันที
3. `run_command` รัน Python สร้าง PDF ทันที
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
