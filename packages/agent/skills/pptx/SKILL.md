---
name: pptx
description: Inspect and narrowly update PowerPoint PPTX elements selected in ZCode Preview Pane using fingerprint-checked OOXML references. Use when a prompt contains a `# Presentation element comments:` or legacy `# Presentation elements:` block, or the user asks to edit a referenced slide shape or table cell.
---

> **InFu 环境适配（本机 Windows + Python 3.11，无 bash）**：
> - 本 SKILL.md 所在目录 = `$SKILL_DIR`（use_skill 返回的目录提示给出绝对路径）；脚本在 `$SKILL_DIR/scripts/` 下。
> - 运行脚本统一用 `python "<脚本绝对路径>"`（勿用 `bash setup.sh`；本机 `python3` 就是 `python`）。
> - 首次使用先装依赖（按需）：`pip install python-docx python-pptx reportlab pypdf playwright markdown` 等。
> - 文中 `$SKILL_DIR` / `$DOCX_SCRIPTS` / `$PDF_SKILL_DIR` 等变量 = `$SKILL_DIR` 下的对应目录，调用时替换为绝对路径。
> - 本技能原为 ZCode Preview Pane 集成；InFu 无 Preview Pane——按「用户给出 .pptx 路径 + 要改的元素描述」的通用方式，用 scripts/pptx_reference.py inspect/update-text 精确改 OOXML，而非依赖元素引用块。

# PPTX referenced-element editing

Use this skill for an existing `.pptx` when ZCode supplies a structured Preview Pane element reference. The
supported mutation scope is intentionally narrow: shape text and table-cell text. Pictures, charts, and table
containers may be inspected, but must not be generically rewritten.

## Required workflow

1. Read the `# Presentation element comments:` JSON block, or a legacy `# Presentation elements:` block, from the prompt. Keep `sourceFingerprint`, `slidePart`,
   `nodeId`, and table `rowIndex`/`cellIndex` exactly as supplied.
2. Run `inspect` before proposing or performing an update.
3. Treat optional `selectedText` as the user's intended text focus and every non-empty `comment` as the user's
   requested change to that specific element. They are model context only. Process all comments without applying
   one reference's comment to another. Use the full element text returned by `inspect`
   to construct the complete replacement passed to `update-text`; never pass the selected substring or instruction
   alone unless the intended complete element text is exactly that value.
4. If inspect reports a fingerprint, missing-node, ambiguous-node, type, name, text, or cell-coordinate conflict,
   stop. Ask the user to reopen the PPTX preview and select the element again. Never guess by similar text/name.
5. For shape text or table-cell text, run `update-text` to a user-requested output path. Prefer a new `.pptx`
   path unless the user explicitly asked to replace the source. If the prompt references multiple elements from
   the same source revision, use one `update-texts` batch so every change is applied to the same output.
6. Report the exact output path and the resolved slide/node/cell. Do not claim lossless Office editing.

```text
reference -> inspect (whole-file sha256 + OOXML locator)
          -> allowed mutation -> temporary PPTX -> ZIP/XML/target validation -> atomic output replace
          -> conflict         -> stop and request reselection
```

## Commands

Set the skill directory first, then store one reference JSON object in a temporary JSON file. Do not include the
surrounding array when invoking the script for one element.

```bash
python3 scripts/pptx_reference.py inspect \
  --source /absolute/path/deck.pptx \
  --reference-file /absolute/path/reference.json
```

```bash
python3 scripts/pptx_reference.py update-text \
  --source /absolute/path/deck.pptx \
  --output /absolute/path/deck-updated.pptx \
  --reference-file /absolute/path/reference.json \
  --text 'Replacement text'
```

For multiple elements, write an updates file shaped as
`[{"reference": { ... }, "text": "Replacement"}, ...]`, then run:

```bash
python3 scripts/pptx_reference.py update-texts \
  --source /absolute/path/deck.pptx \
  --output /absolute/path/deck-updated.pptx \
  --updates-file /absolute/path/updates.json
```

Exit code `2` means the structured reference is stale or ambiguous and no output should be trusted. Exit code
`1` means another file/ZIP/XML error occurred. If its JSON `reason` is `zip_limit_exceeded` or
`invalid_zip_entry`, stop without retrying or bypassing the resolver limits; no output should be trusted.

## Boundaries

- Never edit `.ppt`, `.pptm`, encrypted files, master/layout objects, or group non-text children through this
  resolver.
- Never treat the Preview Pane bounds, node name, or visible text as the authoritative locator. They are only
  diagnostics after `sourceFingerprint + slidePart + nodeId (+ cell coordinates)` resolves uniquely.
- `textFingerprint` always guards the complete shape or table-cell text. Never recompute it from `selectedText`
  or `comment`, and never use either context field as a conflict-check target.
- Do not modify the source through ad-hoc ZIP extraction. The provided script writes and validates a temporary
  archive before an atomic output replace.
- PPTX OOXML text replacement can change line wrapping. It does not provide PowerPoint layout reflow,
  animation, collaboration, or lossless editing guarantees.
