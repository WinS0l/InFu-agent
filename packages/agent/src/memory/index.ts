/**
 * v2.6 记忆系统（批 1：项目指令 INFU.md + 三层记忆读写 + 自动沉淀）
 * 统一出口：指令文件注入 / 作用域解析 / 记忆读写 / 任务沉淀
 */

export {
  findInstructionFile,
  parseScopeRules,
  globToRegExp,
  checkPathScope,
  buildInfuPrompt,
  buildMemoryPrompt,
  INSTRUCTION_MAX_BYTES,
} from "./infu.js";
export {
  readMemory,
  writeMemory,
  listTopics,
  validateTopic,
  resolveMemoryPath,
  detectSensitiveContent,
  globalMemoryDir,
  projectMemoryDir,
  type MemoryScope,
} from "./store.js";
export { sedimentTask, type SedimentInput } from "./sediment.js";
