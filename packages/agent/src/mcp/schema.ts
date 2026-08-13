/**
 * MCP 工具参数 schema 转换：JSON Schema → zod（v2.3）
 *
 * MCP 的 inputSchema 是 JSON Schema，而 ToolDef.schema 要求 zod。
 * 覆盖常用子集（string/number/integer/boolean/object/array/enum/anyOf/const），
 * 未知形态回退 z.any()——保证结构可用、绝不抛错。description 保留（模型可读）。
 */

import { z } from "zod";

export function jsonSchemaToZod(schema: Record<string, unknown> | undefined): z.ZodType {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return z.any();
  const s = schema as Record<string, any>;
  const desc = typeof s.description === "string" ? s.description : undefined;
  const wrap = (zod: z.ZodType): z.ZodType => (desc ? zod.describe(desc) : zod);

  // 常量值
  if (s.const !== undefined) {
    if (typeof s.const === "string") return wrap(z.literal(s.const));
    return z.any(); // 非字符串常量少见，宽松处理
  }
  // 枚举
  if (Array.isArray(s.enum)) {
    if (s.enum.length && s.enum.every((v) => typeof v === "string")) {
      return wrap(z.enum(s.enum as [string, ...string[]]));
    }
    return wrap(z.union(s.enum.map(() => z.any())));
  }
  // 联合类型（递归）
  if (Array.isArray(s.anyOf) && s.anyOf.length) {
    return wrap(z.union(s.anyOf.map((sub: any) => jsonSchemaToZod(sub))));
  }

  switch (s.type) {
    case "string":
      return wrap(z.string());
    case "number":
      return wrap(z.number());
    case "integer":
      return wrap(z.number().int());
    case "boolean":
      return wrap(z.boolean());
    case "null":
      return wrap(z.null());
    case "array": {
      const items = jsonSchemaToZod(s.items as Record<string, unknown> | undefined);
      return wrap(z.array(items));
    }
    case "object": {
      if (s.properties && typeof s.properties === "object") {
        const shape: Record<string, z.ZodType> = {};
        for (const [k, v] of Object.entries(s.properties)) {
          shape[k] = jsonSchemaToZod(v as Record<string, unknown>);
        }
        const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
        const obj: Record<string, z.ZodType> = {};
        for (const [k, v] of Object.entries(shape)) {
          obj[k] = required.has(k) ? v : v.optional();
        }
        return wrap(z.object(obj));
      }
      return wrap(z.record(z.string(), z.any())); // 无 properties：宽松对象
    }
    default:
      return wrap(z.any()); // 未知类型（oneOf/组合等）回退宽松校验
  }
}
