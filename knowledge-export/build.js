/* knowledge-export/build.js — 声音知识图谱 → Markdown 规范手册编译器
 * 用法：node knowledge-export/build.js
 */
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const OUT = __dirname;

const dataFile = path.join(REPO, "knowledge-atlas", "js", "data.js");
const { SECTIONS, GLOSSARY, RESOURCES, RESOURCE_MAP } = require(dataFile);

const strip = (s) => String(s)
  .replace(/<b>(.*?)<\/b>/gs, "**$1**")
  .replace(/<code>(.*?)<\/code>/gs, "`$1`")
  .replace(/<br\s*\/?>/g, " ")
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .trim();

function renderBlock(b) {
  let md = `### ${b.heading}\n\n`;
  if (b.meta) {
    const m = b.meta, bits = [];
    if (m.status) bits.push({ active: "现役主流", classic: "经典架构", legacy: "偏旧参考" }[m.status] || m.status);
    if (m.note) bits.push(m.note);
    if (bits.length) md += `> 状态：${bits.join(" ｜ ")}\n\n`;
  }
  (b.paragraphs || []).forEach((p) => (md += strip(p) + "\n\n"));
  if (b.table) {
    md += `**${b.table.title}**\n\n| ${b.table.head.join(" | ")} |\n|${b.table.head.map(() => "---|").join("")}\n`;
    b.table.rows.forEach((r) => (md += "| " + r.map((c) => strip(c).replace(/\|/g, "/")).join(" | ") + " |\n"));
    md += "\n";
  }
  if (b.callout) md += `> 【${b.callout.title}】${strip(b.callout.text)}\n\n`;
  if (b.sub) md = md.replace("### ", `### （补充阅读·挂在 b${b.parentIdx} 内）`);
  return md;
}

const written = [];
const put = (name, content) => {
  fs.writeFileSync(path.join(OUT, name), content, "utf8");
  written.push(name);
};

// 1. 各章节参考书
SECTIONS.forEach((sec) => {
  let md = `# AI 声音知识图谱 · ${sec.title}（${sec.en}）\n\n${sec.summary || ""}\n\n`;
  (sec.sections || []).forEach((b) => (md += renderBlock(b)));
  put(`01-参考书-${sec.title}.md`, md);
});

// 2. 术语表
let gMd = `# AI 声音知识图谱 · 术语速查表（${GLOSSARY.length} 条）\n\n`;
gMd += "| 术语名称 | 类别 | 核心概念与实战解释 |\n|---|---|---|\n";
GLOSSARY.forEach((t) => {
  gMd += `| **${t.term}** | ${t.cat} | ${strip(t.def)} |\n`;
});
put("02-声音术语速查表.md", gMd);

// 3. 官方资源清单
let rMd = `# AI 声音知识图谱 · 官方开源资源与工具链（${RESOURCES.length} 项）\n\n`;
rMd += "| 项目名称 | 分类 | 官方链接 | 简介与特长 |\n|---|---|---|---|\n";
RESOURCES.forEach((r) => {
  rMd += `| **${r.name}** | ${r.cat} | [GitHub Repo](${r.url}) | ${strip(r.desc)} |\n`;
});
put("03-主流工具与开源清单.md", rMd);

// 4. README
let readme = `# AI 声音知识手册规范包 (Voice Knowledge Export)

本目录由 \`node knowledge-export/build.js\` 自动生成，数据源为 \`knowledge-atlas/js/data.js\`。
面向 voice-workbench 及各类开发/调试 Agent，提供开箱即用的 AI 声音知识查询。

## 文件目录
` + written.map((f) => `- [${f}](./${f})`).join("\n");
put("README.md", readme);

written.forEach((f) => console.log("✓", f, Math.round(fs.statSync(path.join(OUT, f)).size / 1024) + "KB"));
