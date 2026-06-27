/**
 * Document Generation Tools
 *
 * create_spreadsheet — สร้าง .xlsx จาก rows/headers
 * create_document    — สร้าง .docx จาก content (markdown-like)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolImpl } from "./registry.js";

// ---------- create_spreadsheet ----------
const createSpreadsheet: ToolImpl = {
  name: "create_spreadsheet",
  description:
    "สร้างไฟล์ Excel (.xlsx) จาก headers และ rows ที่กำหนด รองรับหลาย sheet",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path ของไฟล์ที่จะสร้าง ต้องลงท้ายด้วย .xlsx",
      },
      sheets: {
        type: "array",
        description: "รายการ sheet แต่ละ sheet มี name, headers, rows",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "ชื่อ sheet" },
            headers: {
              type: "array",
              items: { type: "string" },
              description: "ชื่อ column",
            },
            rows: {
              type: "array",
              items: { type: "array" },
              description: "แถวข้อมูล แต่ละแถวเป็น array ของค่า",
            },
          },
          required: ["name", "headers", "rows"],
        },
      },
    },
    required: ["path", "sheets"],
  },
  async execute(args, ctx) {
    const target = String(args.path);
    const decision = await ctx.acl.check("write_file", { path: target, operation: "write" });
    if (!decision.allowed) throw new Error(decision.reason);
    if (decision.requiresConfirm && !ctx.confirmationApproved) {
      throw new Error(`CONFIRM_REQUIRED: ${decision.confirmPrompt}`);
    }

    const { utils, write } = await import("xlsx");

    const wb = utils.book_new();
    const sheets = args.sheets as Array<{ name: string; headers: string[]; rows: unknown[][] }>;

    for (const sheet of sheets) {
      const data = [sheet.headers, ...sheet.rows.map((row) => row.map(String))];
      const ws = utils.aoa_to_sheet(data);

      // Auto column width
      const colWidths = sheet.headers.map((h, i) => {
        const maxLen = Math.max(
          h.length,
          ...sheet.rows.map((row) => String(row[i] ?? "").length),
        );
        return { wch: Math.min(maxLen + 2, 50) };
      });
      ws["!cols"] = colWidths;

      utils.book_append_sheet(wb, ws, sheet.name);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    const buffer = write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    await fs.writeFile(target, buffer);

    const totalRows = sheets.reduce((sum, s) => sum + s.rows.length, 0);
    return `Created ${target} (${sheets.length} sheet${sheets.length > 1 ? "s" : ""}, ${totalRows} rows)`;
  },
};

// ---------- create_document ----------
const createDocument: ToolImpl = {
  name: "create_document",
  description:
    "สร้างไฟล์ Word (.docx) จาก sections ที่กำหนด รองรับ heading, paragraph, table, bullet list",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path ของไฟล์ที่จะสร้าง ต้องลงท้ายด้วย .docx",
      },
      title: { type: "string", description: "หัวเรื่องของเอกสาร" },
      sections: {
        type: "array",
        description: "รายการ section ในเอกสาร",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["heading", "paragraph", "table", "bullets"],
              description: "ประเภทของ section",
            },
            level: { type: "number", description: "ระดับ heading (1-3)" },
            text: { type: "string", description: "ข้อความ สำหรับ heading/paragraph" },
            items: {
              type: "array",
              items: { type: "string" },
              description: "รายการ สำหรับ bullets",
            },
            headers: {
              type: "array",
              items: { type: "string" },
              description: "ชื่อ column สำหรับ table",
            },
            rows: {
              type: "array",
              items: { type: "array" },
              description: "แถวข้อมูล สำหรับ table",
            },
          },
          required: ["type"],
        },
      },
    },
    required: ["path", "sections"],
  },
  async execute(args, ctx) {
    const target = String(args.path);
    const decision = await ctx.acl.check("write_file", { path: target, operation: "write" });
    if (!decision.allowed) throw new Error(decision.reason);
    if (decision.requiresConfirm && !ctx.confirmationApproved) {
      throw new Error(`CONFIRM_REQUIRED: ${decision.confirmPrompt}`);
    }

    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } = await import("docx");

    const headingLevelMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
      1: HeadingLevel.HEADING_1,
      2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3,
    };

    type DocSection = {
      type: "heading" | "paragraph" | "table" | "bullets";
      level?: number;
      text?: string;
      items?: string[];
      headers?: string[];
      rows?: string[][];
    };

    const sections = args.sections as DocSection[];
    const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

    if (args.title) {
      children.push(
        new Paragraph({
          text: String(args.title),
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
        }),
      );
    }

    for (const section of sections) {
      if (section.type === "heading") {
        children.push(
          new Paragraph({
            text: section.text ?? "",
            heading: headingLevelMap[section.level ?? 1] ?? HeadingLevel.HEADING_1,
          }),
        );
      } else if (section.type === "paragraph") {
        children.push(new Paragraph({ children: [new TextRun(section.text ?? "")] }));
      } else if (section.type === "bullets" && Array.isArray(section.items)) {
        for (const item of section.items) {
          children.push(
            new Paragraph({
              text: item,
              bullet: { level: 0 },
            }),
          );
        }
      } else if (section.type === "table" && Array.isArray(section.headers)) {
        const allRows = [section.headers, ...(section.rows ?? [])];
        const table = new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: allRows.map((row, rowIdx) =>
            new TableRow({
              children: row.map((cell) =>
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: String(cell),
                          bold: rowIdx === 0,
                        }),
                      ],
                    }),
                  ],
                }),
              ),
            }),
          ),
        });
        children.push(table);
      }
    }

    const doc = new Document({ sections: [{ children }] });
    await fs.mkdir(path.dirname(target), { recursive: true });
    const buffer = await Packer.toBuffer(doc);
    await fs.writeFile(target, buffer);

    return `Created ${target} (${sections.length} sections)`;
  },
};

export const builtInDocumentTools: ToolImpl[] = [createSpreadsheet, createDocument];
