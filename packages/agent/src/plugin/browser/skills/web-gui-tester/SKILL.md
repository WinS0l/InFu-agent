---
name: web-gui-tester
description: Test web frontends interactively in a purely GUI-based, black-box manner using InFu's browser tools: simulate real user clicks/text input/scrolling, use browser_snapshot for DOM inspection and browser_screenshot for visual verification, and produce a final test report. Use when the user asks to test a webpage/frontend feature, verify UI behavior, reproduce a page bug, or gives only a URL and asks to "test it."
---

# Web GUI 黑盒测试

纯 GUI 黑盒测试前端：只与页面上可见可操作的元素交互，模拟真实用户行为；用 browser_snapshot（DOM 只读）交叉验证 + browser_screenshot（视觉验证）；最后产出测试报告。

## 核心原则

1. **纯 GUI 黑盒**：只操作可见元素，模拟真实用户。验证时允许截图 + 只读 DOM 检查；**禁止**注入 JS 改页面状态/绕过前端逻辑（InFu 无 evaluate 工具，天然满足）。
2. **忠于实际页面**：结论基于页面真实行为，不猜测。GUI 操作失败就停下报告，不用其他方式强推。
3. **测试与修复分离**：测试期间不改被测代码。发现 bug 记录并跳过，继续测其他点；用户明确要求改代码后才修。
4. **代码 + 视觉双重验证**：每个测试点必须既有只读 DOM 验证（browser_snapshot）又有视觉验证（browser_screenshot 并查看图片）。缺一即视为不完整，不得下结论。
5. **遵循浏览器工具自身规则**：以 control-browser 技能的初始化/定位/等待/观察规则为准；本技能定义测试方法论，冲突时工具规则优先。

## 阶段一：场景评估与测试规划

- **信息完整**（给了明确步骤 + 预期结果）→ 跳过规划直接测。
- **信息部分**（给了功能/需求描述）→ 轻量规划：明确测试目标 + 通过标准，直接执行不请求确认。
- **信息不足**（只有 URL 或"帮我测"）→ 完整规划：
  1. 打开页面截图概览，识别页面类型（表单/列表/详情/仪表盘）。
  2. 列核心交互元素与功能区。
  3. 按优先级排测试点：P0 主流程（表单提交/搜索/切换）、P1 交互反馈（加载/成功失败提示/禁用态/导航）、P2 输入边界（空/超长/特殊字符/重复提交）、P3 布局样式（重叠/溢出/对齐）。
  4. 展示计划并立即从 P0 开始，不等待确认；用户可随时打断。例外：需登录凭据或涉及写真实数据（下单/支付/删除）时，先用 ask_user 向用户确认。

## 阶段二：环境准备（需要时）

- 允许启动/重启 dev server、准备测试数据、初始化登录态等任何让被测功能可达的操作。
- **准备与测试明确分离**：准备完成后声明「环境准备完成，正式测试开始」，之后黑盒约束生效。
- 不用准备动作替代被测功能（如测下单流程不能直接插订单数据）。
- 测试中发现环境问题：先声明该测试点无效，回准备阶段，再重测。
- 记录所有准备操作，报告里区分「预置状态」与「测试本身产生的状态」。

## 阶段三：测试执行（操作 → 观察 → 操作循环）

- **操作**：browser_navigate 打开、browser_click 点击、browser_type 输入、browser_fill 填表。模拟真实用户。
- **定位**：基于 browser_snapshot 的实际观察（元素编号/placeholder/文本），绝不猜选择器。多标签页先列标签确认目标。
- **定位失败**：不重试原选择器——重新 snapshot 确认状态，判断是页面 bug（元素真缺失，记录跳过）还是定位问题（重建定位器）。
- **页面加载失败**（超时/白屏/报错）：截图记录状态，报告为问题，跳过依赖该页的后续点。
- **观察（代码 + 视觉双重）**：每个新页面状态（初始加载 + 每次交互后）都要 browser_snapshot（DOM）+ browser_screenshot（视觉）。截图必须「拍下来并查看」才算完成。
- **瞬时状态截图**（toast/加载动画/提示）：同一批次内连拍 before → 操作 → 等待 → after，再查看两张截图。
- **控制台错误收集**：InFu 无 console 监听工具，用**页面可见错误表现**（错误文案/白屏/空区/破图/坏布局）作证据，截图记录，报告里如实说明"未采集控制台"。

## 阶段四：输出测试结论

- 哪些测试点通过 / 失败（含复现步骤 + 截图路径）/ 被阻塞无法执行。
- 每个测试点必须引用对应的截图（报告其绝对文件路径）。
- 默认输出 Markdown 报告，截图用标准图片语法引用本地路径（如 ![](file:///C:/.../t1_before.png)）。
