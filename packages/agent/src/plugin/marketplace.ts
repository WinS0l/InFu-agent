/**
 * 插件市场雏形（v2.7 批 1）——内置官方插件注册表
 * 借鉴 zcode marketplace（source/hash/version 元数据）；当前为「内置注册表」形态：
 * 官方插件随 InFu 分发，marketplace 列出可一键安装的插件（id/描述/模块路径/版本）。
 * 后续可扩展为远程市场（URL 拉取 manifest）。
 */
import { fileURLToPath } from "node:url";

export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  /** 插件模块绝对路径（随 InFu 分发，相对本模块解析） */
  path: string;
  /** 安装来源标记（写 config.plugins[].source） */
  source: string;
}

// v3.0：builtin 插件路径扩展名跟随执行环境——tsx（dev/CLI/Web 常驻）加载 .ts 源码；
// dist（桌面端 Electron 宿主/生产）加载 .js 编译产物
const _moduleExt = import.meta.url.endsWith(".js") ? ".js" : ".ts";

const _registry: MarketplacePlugin[] = [
  {
    id: "browser-use",
    name: "browser-use",
    description:
      "浏览器自动化：打开/导航网页、AI 可访问性树快照、点击/输入/填表、页面 JS 执行、截图视觉验证。用于 Web 前端测试、渲染页面抓取、交互验证（含 control-browser / web-gui-tester 两个技能）。",
    version: "0.2.0",
    path: fileURLToPath(new URL(`./browser/tools${_moduleExt}`, import.meta.url)),
    source: "builtin",
  },
  {
    id: "document-skills",
    name: "document-skills",
    description: "文档处理三件套：docx（Word 创建/编辑/审阅）、pdf（报告/创意/LaTeX/PDF 处理）、pptx（PowerPoint 精确编辑）。",
    version: "1.0.0",
    path: fileURLToPath(new URL(`./official/document-skills${_moduleExt}`, import.meta.url)),
    source: "builtin",
  },
  {
    id: "skill-creator",
    name: "skill-creator",
    description: "创建新技能、编辑现有技能、迭代措辞。把重复工作流沉淀为可复用 SKILL.md 时使用。",
    version: "1.0.0",
    path: fileURLToPath(new URL(`./official/skill-creator${_moduleExt}`, import.meta.url)),
    source: "builtin",
  },
];

/** 列出市场可安装插件 */
export function listMarketplacePlugins(): MarketplacePlugin[] {
  return _registry;
}

/** 内置官方插件（随 InFu 分发，默认启用；用户可在设置界面禁用） */
export function listBuiltinPlugins(): MarketplacePlugin[] {
  return _registry;
}

/** 按 id 查市场插件 */
export function findMarketplacePlugin(id: string): MarketplacePlugin | null {
  return _registry.find((p) => p.id === id) ?? null;
}

/** 判断某 id 是否为内置官方插件 */
export function isBuiltinPlugin(id: string): boolean {
  return _registry.some((p) => p.id === id);
}
