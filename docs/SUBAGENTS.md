# Subagents

Subagents run an independent Agent loop for a delegated task. They receive a bounded tool set, task root, model configuration, approval channel, path scope, attachment read directories, and cancellation signal from the parent task.

## Built-in Roles

| Role | Purpose | Default tools |
|---|---|---|
| `general-purpose` | Multi-step implementation, debugging, and review work | All permitted built-in tools |
| `explore` | Read-only investigation and codebase analysis | Read-only tools |

Custom roles can be stored in `~/.infu/agents/` or `<project>/.infu/agents/`. A role file uses Markdown frontmatter for its description, tools, model, maximum steps, thinking level, permission mode, and sandbox preference.

## Delegation

Use `delegate_task` for a single task or a `tasks` array for independent work that can run in parallel. A session supports up to six active subagents. Nested delegation is intentionally limited.

Subagents emit structured events to the parent session. Their final summary is returned to the parent agent, and background work emits a completion notification that the parent can inspect with `report`, `job_output`, or `wait_task`.

## Safety

- Read-only delegations do not request a separate delegation approval.
- Delegations with write-capable tools require parent authorization.
- Explicit safety boundaries, protected paths, root scope rules, and disabled tools remain enforced.
- Background subagents are cancelled when their parent task ends.
