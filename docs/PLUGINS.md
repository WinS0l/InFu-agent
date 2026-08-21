# Plugins and Skills

InFu extensions are either JavaScript plugins or `SKILL.md` skills. Plugins can add tools, hooks, and skill directories. Skills provide reusable instructions and supporting files for the Agent.

## Plugin Shape

```ts
export default {
  id: "my-tools",
  name: "My Tools",
  description: "Project-specific tools and workflow hooks.",
  tools: [],
  hooks: {
    preToolUse: async ({ tool, args }) => ({ decision: "allow", args }),
    postToolUse: async ({ result }) => ({ result }),
  },
  skills: ["C:/path/to/skill-dir"],
};
```

Plugin tools default to `medium` risk when no risk is declared. Tool-name collisions are renamed instead of replacing built-in tools. Plugin load failures are reported without stopping a task.

## Skills

Skills use a directory with a `SKILL.md` file and YAML frontmatter:

```text
my-skill/
├─ SKILL.md
├─ references/
├─ scripts/
└─ assets/
```

InFu discovers skills from explicit configuration, `~/.infu/skills/`, `<project>/.infu/skills/`, and bundled extensions. Higher-priority locations win on name conflicts.

## Bundled Extensions

- `browser-use`: browser navigation, accessibility snapshots, interactions, screenshots, and browser workflow skills.
- `skill-creator`: guidance for authoring and improving local skills.

Document-processing skills are not part of the open-source distribution.

## Commands

```powershell
npm run infu -- plugin list
npm run infu -- plugin add <id> --path <module-path>
npm run infu -- skill list
npm run infu -- skill template list
```

## Trust Model

Plugins execute in the Agent process. Install only code you trust. MCP servers and skills can influence Agent behavior and should be reviewed before use.
