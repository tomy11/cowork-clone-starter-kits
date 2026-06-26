/**
 * Skills Loader (Anthropic Skill Spec compatible)
 *
 * โหลด skills จาก folder — แต่ละ skill คือ folder ที่มี SKILL.md
 * ใช้ progressive disclosure: โหลดแค่ metadata ตอน list,
 * โหลด full instruction ตอน activate
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as yaml from "yaml";

export type SkillMetadata = {
  name: string;
  description: string;
  path: string; // folder path
  raw: Record<string, unknown>;
};

export type Skill = SkillMetadata & {
  instructions: string;
  resources: SkillResource[];
};

export type SkillResource = {
  type: "file" | "script" | "template";
  name: string;
  path: string;
};

export class SkillsLoader {
  private skillsRoot: string;
  private cache = new Map<string, Skill>();

  constructor(skillsRoot: string) {
    this.skillsRoot = skillsRoot;
  }

  /**
   * List skill metadata ทั้งหมด — เบาๆ ไม่โหลด instruction
   */
  async list(): Promise<SkillMetadata[]> {
    try {
      const entries = await fs.readdir(this.skillsRoot, { withFileTypes: true });
      const skills: SkillMetadata[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const metadata = await this.metadataFromPath(path.join(this.skillsRoot, e.name), e.name);
        if (metadata) skills.push(metadata);
      }
      return skills;
    } catch {
      return [];
    }
  }

  async metadataFromPath(skillDir: string, nameHint = path.basename(skillDir)): Promise<SkillMetadata | null> {
    const skillMd = path.join(skillDir, "SKILL.md");
    try {
      const raw = await fs.readFile(skillMd, "utf-8");
      const meta = this.parseFrontmatter(raw);
      return {
        name: typeof meta.name === "string" ? meta.name : nameHint,
        description: typeof meta.description === "string" ? meta.description : "",
        path: skillDir,
        raw: meta,
      };
    } catch {
      return null;
    }
  }

  /**
   * โหลด skill เต็ม (instruction + resources) — เรียกตอน activate
   */
  async load(name: string): Promise<Skill> {
    const skillDir = path.join(this.skillsRoot, name);
    return this.loadSkillFromPath(skillDir, name, name);
  }

  async loadFromPath(skillDir: string, nameHint = path.basename(skillDir)): Promise<Skill> {
    return this.loadSkillFromPath(skillDir, nameHint, `path:${path.resolve(skillDir)}`);
  }

  private async loadSkillFromPath(skillDir: string, nameHint: string, cacheKey: string): Promise<Skill> {
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const skillMd = path.join(skillDir, "SKILL.md");

    const raw = await fs.readFile(skillMd, "utf-8");
    const { body, meta } = this.parseFrontmatterWithBody(raw);

    const resources: SkillResource[] = [];
    const entries = await fs.readdir(skillDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "SKILL.md") continue;
      if (e.isFile()) {
        resources.push({
          type: this.inferResourceType(e.name),
          name: e.name,
          path: path.join(skillDir, e.name),
        });
      }
    }

    const skill: Skill = {
      name: typeof meta.name === "string" ? meta.name : nameHint,
      description: typeof meta.description === "string" ? meta.description : "",
      path: skillDir,
      raw: meta,
      instructions: body,
      resources,
    };

    this.cache.set(cacheKey, skill);
    return skill;
  }

  /**
   * Format skill list ให้ LLM เห็น — แค่ name + description (progressive disclosure)
   */
  async formatForLLM(): Promise<string> {
    const skills = await this.list();
    if (skills.length === 0) return "(no skills available)";
    return skills
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join("\n");
  }

  private parseFrontmatter(raw: string): Record<string, unknown> {
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return {};
    try {
      return yaml.parse(m[1]) ?? {};
    } catch {
      return {};
    }
  }

  private parseFrontmatterWithBody(raw: string): {
    meta: Record<string, unknown>;
    body: string;
  } {
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!m) return { meta: {}, body: raw };
    try {
      return { meta: yaml.parse(m[1]) ?? {}, body: m[2] };
    } catch {
      return { meta: {}, body: raw };
    }
  }

  private inferResourceType(name: string): "file" | "script" | "template" {
    if (/\.(sh|js|ts|py|rb)$/.test(name)) return "script";
    if (/\.(tmpl|tpl|template)$/.test(name)) return "template";
    return "file";
  }
}
