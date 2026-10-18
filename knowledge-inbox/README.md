# knowledge-inbox · 知识收集缓存（待分析）

用户收集物的**待分析缓存**：文件、文档、项目代码、模型、调研总结都先放这里。

## 一句话分析流程（用户给一句话即触发，全程自动）

1. **分析文件**：扫描 inbox 里的新材料，识别主题、类型与可信度
2. **产出报告**：写了什么、与项目相关度、值得收录的知识点
3. **验证可行性**：对可执行的结论做本机验证（能跑的跑通、不能跑的标注原因）
4. **横向对比**：与 `knowledge-atlas/js/data.js` 现有条目对照——已有则订正、矛盾则标注取舍
5. **整合**：改 data.js 源（**不直接改 export 的 md**）→ `node knowledge-export/build.js` → git 提交

## 领域红线

- 敏感话题（无审查/NSFW 类）只写结构科普与法律红线，不提供规避手段
- 一切数据标注口径：「本项目实测」>「官方文档」>「社区说法」，不混写
- 仓库链接先核实再写（上游 tarball 锁定的写 docs 指路，不编 URL）

## 数据源映射（bili-duty 自动化知识检索）

- bili-duty skill 的检索产出目录：`F:\schoolCompWorks\clone\bili-duty-local\data\summaries`
- **本项目需要的子路径**：`...\summaries\ai voice\`
- 约定：调用 bili-duty 的场景，结果从该路径读取，按上面五步流程整合进知识图谱；本目录（knowledge-inbox）承接手动收集物
