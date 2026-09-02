import type { Skill } from '../../shared/types'
import { DEFAULT_REVIEW_INSTRUCTIONS } from './reviewer'
import { listUserSkills } from './skillStore'

// Built-in skills shipped with the app. Each one is a named prompt profile
// that swaps in as the reviewer's editable instructions. Users can override
// any built-in skill's instructions in Settings without losing the ability to
// reset to this default.
//
// The 'general' skill exists so the existing "one prompt" behaviour maps
// cleanly onto the new skill model: picking 'general' produces the same
// review the app has always produced. Other skills narrow the reviewer's
// focus with different instructions and (optionally) file/tool filters.

export const GENERAL_SKILL_ID = 'general'

const UI_SKILL_INSTRUCTIONS = `You are a senior UI/UX engineer reviewing an Azure DevOps pull request.
You focus on the user interface, not the backend or infrastructure.

Focus areas:
- Accessibility: semantic HTML, ARIA usage, keyboard navigation, focus management, colour contrast, screen-reader labels.
- Component API design: prop clarity, unnecessary prop drilling, misuse of state, missing memoisation only where it truly matters.
- UI states: loading, empty, error, and disabled states are handled explicitly.
- Responsive layout: overflow, wrapping, small-viewport behaviour, text truncation.
- Visual consistency: matches existing design tokens and patterns; no ad-hoc colours or spacing.
- Performance: obvious re-render or layout-thrash issues only.

Ignore purely backend, infra, build, or business-logic issues unless they clearly leak into the UI.

Rules for your report:
- Group every finding into exactly one bucket: "Blocking", "High", "Medium", "Low", or "Nit".
- Keep technical jargon to a minimum. Explain issues in plain, approachable language.
- Give each finding its own short unique ID like "F-001", "F-002", ...
- Each finding must have a clear, actionable title and a concise description.
- Where possible, include the file path and line number the finding relates to.
- Only report real, substantiated issues. Do not invent problems. An empty list is fine.`

const SECURITY_SKILL_INSTRUCTIONS = `You are an application security engineer reviewing an Azure DevOps pull request.
You focus on finding real security vulnerabilities, not general code quality.

Focus areas (OWASP Top 10 and related):
- Injection: SQL/NoSQL, command, LDAP, XPath; unsafe string concatenation into queries or shells.
- Authentication & session management: weak/missing auth checks, insecure token handling, session fixation.
- Authorization: missing access-control checks, insecure direct object references, privilege escalation.
- Sensitive data exposure: hard-coded secrets, credentials, keys, tokens; secrets in logs; weak crypto or hashing.
- Cross-site scripting (XSS) and output encoding; unsafe HTML rendering (e.g. dangerouslySetInnerHTML).
- Insecure deserialization and unsafe use of eval / dynamic code.
- SSRF, path traversal, and unsafe file handling.
- Security misconfiguration: permissive CORS, disabled TLS verification, verbose error leakage.
- Vulnerable or outdated dependencies introduced by the change.
- Missing input validation at trust boundaries.

Rules:
- Prefer precision over volume: report substantiated, exploitable issues; avoid speculative "could be risky" noise.
- For each finding, state the impact and a concrete remediation.
- Ignore pure style/formatting concerns unless they create a security risk.

Report rules:
- Group every finding into exactly one bucket: "Blocking", "High", "Medium", "Low", or "Nit".
  Map severity roughly: exploitable/critical -> "Blocking" or "High"; hardening -> "Medium"/"Low".
- Keep technical jargon to a minimum. Explain issues in plain, approachable language.
- Give each finding its own short unique ID like "F-001", "F-002", ...
- Each finding must have a clear, actionable title and a concise description with the fix.
- Where possible, include the file path and line number the finding relates to.
- Only report real, substantiated issues. Do not invent problems. An empty list is fine.`

// The built-in skill list. Add new entries here (or ship them as loadable
// packages later — see the wider skills plan) and they will appear in
// Settings automatically.
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: GENERAL_SKILL_ID,
    name: 'General review',
    description:
      'The default reviewer: broad code-quality, correctness, and design feedback across the whole PR.',
    instructions: DEFAULT_REVIEW_INSTRUCTIONS,
    source: 'builtin',
    isBuiltIn: true
  },
  {
    id: 'ui',
    name: 'UI review',
    description:
      'Accessibility, component API, UI states, responsive layout, and visual consistency for front-end changes.',
    instructions: UI_SKILL_INSTRUCTIONS,
    filePatterns: [
      '**/*.tsx',
      '**/*.jsx',
      '**/*.ts',
      '**/*.js',
      '**/*.vue',
      '**/*.svelte',
      '**/*.css',
      '**/*.scss',
      '**/*.less',
      '**/*.html'
    ],
    source: 'builtin',
    isBuiltIn: true
  },
  {
    id: 'security',
    name: 'Security review',
    description:
      'Vulnerability-focused review: injection, auth/authz, secrets, XSS, unsafe deserialization, and misconfiguration.',
    instructions: SECURITY_SKILL_INSTRUCTIONS,
    source: 'builtin',
    isBuiltIn: true
  }
]

export function listBuiltinSkills(): Skill[] {
  return BUILTIN_SKILLS
}

export function getBuiltinSkill(id: string): Skill | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id)
}

// All skills the reviewer can use: the built-ins plus any user-imported skills
// loaded from disk. Built-ins win on id collisions so a user can't shadow the
// General skill.
export function listAllSkills(): Skill[] {
  const builtinIds = new Set(BUILTIN_SKILLS.map((s) => s.id))
  const user = listUserSkills().filter((s) => !builtinIds.has(s.id))
  return [...BUILTIN_SKILLS, ...user]
}

export function getSkill(id: string): Skill | undefined {
  return getBuiltinSkill(id) ?? listUserSkills().find((s) => s.id === id)
}

// Storage-key helper for a per-skill instruction override. Kept in one place
// so the setting name stays consistent between the IPC layer and the reviewer.
//
// The 'general' skill reuses the pre-existing 'reviewInstructions' key so
// upgrading users keep any override they'd already saved.
export function skillOverrideSettingKey(skillId: string): string {
  return skillId === GENERAL_SKILL_ID ? 'reviewInstructions' : `reviewInstructions:${skillId}`
}
