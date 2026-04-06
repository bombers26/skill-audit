#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const CLAUDE_DIR = join(homedir(), '.claude')
const PLUGINS_DIR = join(CLAUDE_DIR, 'plugins', 'marketplaces')
const HISTORY_FILE = join(CLAUDE_DIR, 'history.jsonl')
const USAGE_FILE = join(CLAUDE_DIR, 'skill-audit-usage.json')

// Pricing per million input tokens (USD)
const PRICING = {
  'claude-opus-4':    15.0,
  'claude-sonnet-4':   3.0,
  'claude-haiku-4':    0.8,
  'default':           3.0,
}

// ── helpers ──────────────────────────────────────────────────────────────────

function dirSize(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else total += statSync(full).size
  }
  return total
}

function charsToTokens(chars) {
  return Math.round(chars / 4)
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function costUsd(tokens, model = 'default') {
  const price = PRICING[model] ?? PRICING['default']
  return (tokens / 1_000_000) * price
}

function formatUsd(n) {
  if (n < 0.001) return '<$0.001'
  return '$' + n.toFixed(4)
}

function bar(fraction, width = 20) {
  const filled = Math.round(fraction * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// ── skill discovery ───────────────────────────────────────────────────────────

function findSkillFiles(dir, depth = 0) {
  // recursively find all SKILL.md files up to depth 5
  if (depth > 5 || !existsSync(dir)) return []
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === 'SKILL.md') {
      results.push(full)
    } else if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findSkillFiles(full, depth + 1))
    }
  }
  return results
}

function discoverSkills() {
  const skills = new Map() // name → { name, tokens, bytes, marketplace }

  if (!existsSync(PLUGINS_DIR)) return skills

  const allSkillFiles = findSkillFiles(PLUGINS_DIR)

  for (const skillFile of allSkillFiles) {
    const skillDir = dirname(skillFile)
    const name = skillDir.split('/').pop()
    // derive marketplace from path segment after 'marketplaces/'
    const parts = skillFile.split('/')
    const mIdx = parts.indexOf('marketplaces')
    const marketplace = mIdx >= 0 ? parts[mIdx + 1] : 'unknown'

    const bytes = dirSize(skillDir)
    const tokens = charsToTokens(bytes)

    // keep the largest version if duplicated across cache/marketplace
    if (!skills.has(name) || skills.get(name).tokens < tokens) {
      skills.set(name, { name, bytes, tokens, marketplace, path: skillDir })
    }
  }

  return skills
}

// ── usage tracking ────────────────────────────────────────────────────────────

function loadUsage() {
  if (!existsSync(USAGE_FILE)) return {}
  try { return JSON.parse(readFileSync(USAGE_FILE, 'utf8')) } catch { return {} }
}

function saveUsage(usage) {
  writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2))
}

function parseHistoryForSkills(skillNames) {
  if (!existsSync(HISTORY_FILE)) return {}
  const counts = {}
  const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      const text = (entry.display || '').toLowerCase()
      for (const name of skillNames) {
        if (text.includes(name.toLowerCase())) {
          counts[name] = (counts[name] || 0) + 1
        }
      }
    } catch { /* skip bad lines */ }
  }
  return counts
}

// ── enabled skills from settings ─────────────────────────────────────────────

function getEnabledPlugins() {
  const settingsFile = join(CLAUDE_DIR, 'settings.json')
  if (!existsSync(settingsFile)) return new Set()
  try {
    const s = JSON.parse(readFileSync(settingsFile, 'utf8'))
    return new Set(Object.keys(s.enabledPlugins || {}).filter(k => s.enabledPlugins[k]))
  } catch { return new Set() }
}

// ── system prompt overhead estimate ──────────────────────────────────────────

function estimateSystemPromptOverhead(skills) {
  // Each enabled skill appears as a line in system prompt (~80 chars average)
  const listOverhead = skills.size * 80
  // Base system prompt (Claude Code)
  const baseOverhead = 8000 * 4 // ~8K tokens base
  return charsToTokens(listOverhead + baseOverhead)
}

// ── commands ──────────────────────────────────────────────────────────────────

function cmdAudit(args) {
  const model = args.model || 'claude-sonnet-4'
  const dailySessions = parseInt(args.sessions || '10')

  const skills = discoverSkills()
  const enabledPlugins = getEnabledPlugins()
  const historyCounts = parseHistoryForSkills([...skills.keys()])
  const usage = loadUsage()

  // merge history counts into usage
  for (const [name, count] of Object.entries(historyCounts)) {
    usage[name] = (usage[name] || 0) + count
  }

  const systemOverheadTokens = estimateSystemPromptOverhead(skills)
  const systemOverheadCost = costUsd(systemOverheadTokens, model)

  // sort by token cost desc
  const sorted = [...skills.values()].sort((a, b) => b.tokens - a.tokens)
  const maxTokens = sorted[0]?.tokens || 1

  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║              Claude Code  skill-audit  v1.0                 ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  console.log(`  Model pricing : ${model} @ $${PRICING[model] ?? PRICING['default']}/M tokens`)
  console.log(`  Sessions/day  : ${dailySessions}`)
  console.log(`  Skills found  : ${skills.size}\n`)

  // header
  const W = { name: 22, tokens: 10, bar: 22, cost: 10, uses: 8 }
  const header =
    'Skill'.padEnd(W.name) +
    'Tokens'.padStart(W.tokens) +
    '  ' + 'Usage'.padEnd(W.bar) +
    'Cost/call'.padStart(W.cost) +
    'History'.padStart(W.uses)
  console.log('  ' + header)
  console.log('  ' + '─'.repeat(header.length))

  for (const skill of sorted) {
    const uses = usage[skill.name] || 0
    const fraction = skill.tokens / maxTokens
    const row =
      skill.name.slice(0, W.name - 1).padEnd(W.name) +
      formatTokens(skill.tokens).padStart(W.tokens) +
      '  ' + bar(fraction, W.bar) +
      formatUsd(costUsd(skill.tokens, model)).padStart(W.cost) +
      String(uses).padStart(W.uses)
    console.log('  ' + row)
  }

  const totalTokens = sorted.reduce((s, sk) => s + sk.tokens, 0)
  const totalCost = costUsd(totalTokens, model)
  const monthlyCost = totalCost * dailySessions * 30

  console.log('\n  ' + '─'.repeat(header.length))
  console.log(`\n  System prompt overhead  : ~${formatTokens(systemOverheadTokens)} tokens (${formatUsd(systemOverheadCost)}/call)`)
  console.log(`  Total skill content     : ${formatTokens(totalTokens)} tokens`)
  console.log(`  Cost if ALL loaded/call : ${formatUsd(totalCost)}`)
  console.log(`  Estimated monthly cost  : ${formatUsd(monthlyCost)}  (${dailySessions} sessions/day × 30 days)\n`)

  console.log('  💡 Tips:')
  console.log('     • Skills are loaded on-demand — only triggered skills add tokens')
  console.log('     • System prompt always includes the skill list (~' + formatTokens(systemOverheadTokens) + ' tokens)')
  console.log('     • Run `skill-audit track` after each session to log usage\n')

  saveUsage(usage)
}

function cmdTrack(skillName) {
  if (!skillName) {
    console.log('Usage: skill-audit track <skill-name>')
    return
  }
  const usage = loadUsage()
  usage[skillName] = (usage[skillName] || 0) + 1
  saveUsage(usage)
  console.log(`✓ Tracked usage: ${skillName} (total: ${usage[skillName]})`)
}

function cmdReset() {
  saveUsage({})
  console.log('✓ Usage stats reset.')
}

function cmdHelp() {
  console.log(`
  skill-audit — Claude Code Skill Token Cost Auditor

  Commands:
    audit              Show token cost breakdown for all installed skills
    audit --model <m>  Specify model (claude-opus-4 / claude-sonnet-4 / claude-haiku-4)
    audit --sessions N Estimate monthly cost based on N sessions/day (default: 10)
    track <skill>      Record a manual skill usage
    reset              Clear usage history
    help               Show this help

  Examples:
    skill-audit audit
    skill-audit audit --model claude-opus-4 --sessions 20
    skill-audit track pua
`)
}

// ── main ──────────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv

// parse --key value flags from rest
const args = {}
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    args[rest[i].slice(2)] = rest[i + 1] || true
    i++
  } else {
    args._positional = rest[i]
  }
}

switch (cmd) {
  case 'audit':   cmdAudit(args); break
  case 'track':   cmdTrack(args._positional || rest[0]); break
  case 'reset':   cmdReset(); break
  default:        cmdHelp()
}
