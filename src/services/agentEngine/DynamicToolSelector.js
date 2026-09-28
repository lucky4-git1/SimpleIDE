/**
 * DynamicToolSelector.js
 *
 * Implements Phase 16: Dynamic Tool Capabilities
 * Dynamically selects targeted tool subsets based on task context and Laya classification.
 * Prevents overwhelming LLM context windows with 35+ tools on every call.
 */

export const TOOL_PROFILE_SETS = {
  UI_CSS: [
    'read_file',
    'read_files',
    'edit_file',
    'apply_patch',
    'search_files',
    'search_text',
    'browser_screenshot',
    'browser_audit',
    'browser_set_viewport',
    'validate_standalone_html'
  ],
  AUTH_SECURITY: [
    'read_file',
    'read_files',
    'edit_file',
    'apply_patch',
    'find_definition',
    'find_references',
    'find_symbol',
    'query_symbol_graph',
    'run_command',
    'verify'
  ],
  DATABASE: [
    'read_file',
    'read_files',
    'edit_file',
    'apply_patch',
    'search_text',
    'search_files',
    'run_command',
    'verify'
  ],
  REFACTOR: [
    'read_file',
    'read_files',
    'edit_file',
    'apply_patch',
    'find_definition',
    'find_references',
    'find_implementations',
    'query_symbol_graph',
    'get_diagnostics',
    'verify'
  ],
  RESEARCH_ONLY: [
    'read_file',
    'read_files',
    'list_files',
    'search_files',
    'search_documentation',
    'search_web',
    'search_coding_knowledge',
    'find_symbol'
  ]
}

export class DynamicToolSelector {
  static selectToolsForTask(taskPrompt, allTools = []) {
    const text = String(taskPrompt || '').toLowerCase()
    let profile = null

    if (/\b(what|why|explain|document|how does|search for)\b/i.test(text)) {
      profile = TOOL_PROFILE_SETS.RESEARCH_ONLY
    } else if (/\b(css|style|color|layout|responsive|button|padding|margin|theme|html|tailwind)\b/i.test(text)) {
      profile = TOOL_PROFILE_SETS.UI_CSS
    } else if (/\b(auth|token|jwt|login|permission|session|password|secret)\b/i.test(text)) {
      profile = TOOL_PROFILE_SETS.AUTH_SECURITY
    } else if (/\b(db|database|sql|sqlite|postgres|mongo|schema|migration|table)\b/i.test(text)) {
      profile = TOOL_PROFILE_SETS.DATABASE
    } else if (/\b(rename|refactor|extract|move|interface|symbol)\b/i.test(text)) {
      profile = TOOL_PROFILE_SETS.REFACTOR
    }

    if (!profile) {
      // Standard balanced coding profile (12 core tools)
      return allTools.filter(t => [
        'read_file', 'read_files', 'edit_file', 'apply_patch', 'write_file',
        'find_definition', 'find_references', 'search_text', 'search_files',
        'run_command', 'verify', 'update_plan'
      ].includes(t.name))
    }

    const allowedSet = new Set(profile)
    // Always include plan update if present
    allowedSet.add('update_plan')

    const filtered = allTools.filter(t => allowedSet.has(t.name))
    return filtered.length > 0 ? filtered : allTools
  }
}
