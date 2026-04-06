# skill-audit

Audit your Claude Code skill token costs and track usage frequency.

```
╔══════════════════════════════════════════════════════════════╗
║              Claude Code  skill-audit  v1.0                 ║
╚══════════════════════════════════════════════════════════════╝

  Model pricing : claude-sonnet-4 @ $3/M tokens
  Sessions/day  : 10
  Skills found  : 56

  Skill                     Tokens  Usage                  Cost/call History
  ──────────────────────────────────────────────────────────────────────────
  canvas-design               1.4M  ██████████████████████   $4.1655       0
  pptx                      282.5K  ████░░░░░░░░░░░░░░░░░░   $0.8475       0
  docx                      280.3K  ████░░░░░░░░░░░░░░░░░░   $0.8410       0
  pua                        37.9K  █░░░░░░░░░░░░░░░░░░░░░   $0.1136      12
  ...
```

## Why

Claude Code skills are loaded on-demand — but most users don't know how many tokens each skill consumes when triggered, or how much the skill list itself costs in every system prompt.

`skill-audit` makes this visible.

## Install

```bash
# Run directly (no install needed)
npx skill-audit audit

# Or install globally
npm install -g skill-audit
```

Requires Node.js 18+. No other dependencies.

## Usage

```bash
# Audit all installed skills (default: claude-sonnet-4, 10 sessions/day)
skill-audit audit

# Specify model and daily session count for cost projection
skill-audit audit --model claude-opus-4 --sessions 20

# Manually record a skill usage
skill-audit track pua

# Reset usage history
skill-audit reset
```

### Available models

| Model | Price |
|-------|-------|
| `claude-opus-4` | $15 / M tokens |
| `claude-sonnet-4` | $3 / M tokens |
| `claude-haiku-4` | $0.8 / M tokens |

## How it works

1. **Skill discovery** — scans `~/.claude/plugins/marketplaces/` for all `SKILL.md` files and measures total directory size
2. **Token estimation** — approximates tokens as `bytes / 4` (standard heuristic)
3. **Usage tracking** — parses `~/.claude/history.jsonl` for skill name mentions, persists counts in `~/.claude/skill-audit-usage.json`
4. **Cost projection** — multiplies token count × model price × sessions/day × 30

## Key insight

Skills are **on-demand** — they only consume tokens when triggered. But:

- The **skill list** in the system prompt is always present (~80 chars × number of skills)
- Large skills like `canvas-design` (1.4M tokens!) are extremely expensive if triggered accidentally
- Understanding your skill footprint helps you decide which plugins to keep enabled

## License

MIT
