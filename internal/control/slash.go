package control

import (
	"fmt"
	"strings"

	"reasonix/internal/config"
	"reasonix/internal/i18n"
	"reasonix/internal/skill"
)

// SlashItem is one slash-completion suggestion. Insert is the token text placed
// at the current argument position (callers replace from the token's start, see
// SlashArgItems' returned offset); Descend hints the menu to re-open one level
// deeper after accepting (e.g. "/mcp " → "/mcp add ").
type SlashItem struct {
	Label   string `json:"label"`
	Insert  string `json:"insert"`
	Hint    string `json:"hint"`
	Descend bool   `json:"descend"`
}

// ArgData supplies the dynamic data SlashArgItems needs, so the completion logic
// is one shared function both frontends call with their own session data — the
// chat TUI (controller-free, from its cached lists) and the desktop (from the
// controller). This keeps the CLI and desktop sub-command hints identical.
type ArgData struct {
	Skills       []skill.Skill
	ServerNames  []string
	ModelRefs    []string
	CurrentModel string
}

// SlashArgItems completes the arguments of a management slash command
// (everything after the command word). It returns the suggestions filtered by
// the token being typed and the byte offset where that token begins, so a caller
// replaces just that token. Only structured commands participate (/mcp /model
// /skill /hooks); others yield nil. Single source of truth for CLI + desktop.
func SlashArgItems(line string, d ArgData) ([]SlashItem, int) {
	cmdEnd := strings.IndexAny(line, " \t")
	if cmdEnd < 0 {
		return nil, 0
	}
	from := strings.LastIndexAny(line, " \t") + 1
	cur := line[from:]
	prior := strings.Fields(line[:from]) // committed tokens, including the command word
	var raw []SlashItem
	switch line[:cmdEnd] {
	case "/mcp":
		raw = mcpArgItems(prior, cur, d)
	case "/model":
		raw = modelArgItems(prior, d)
	case "/skill", "/skills":
		raw = skillArgItems(prior, d)
	case "/hooks":
		raw = hooksArgItems(prior)
	default:
		return nil, from
	}
	return filterSlash(raw, line, from, cur), from
}

func mcpArgItems(prior []string, cur string, d ArgData) []SlashItem {
	if len(prior) <= 1 {
		return []SlashItem{
			{Label: "add", Insert: "add ", Hint: i18n.M.ArgMcpAdd, Descend: true},
			{Label: "remove", Insert: "remove ", Hint: i18n.M.ArgMcpRemove, Descend: true},
			{Label: "list", Insert: "list", Hint: i18n.M.ArgMcpList},
		}
	}
	switch prior[1] {
	case "remove", "rm":
		if len(prior) != 2 { // the single name arg is already placed
			return nil
		}
		var items []SlashItem
		for _, name := range d.ServerNames {
			items = append(items, SlashItem{Label: name, Insert: name, Hint: i18n.M.ArgMcpConnected})
		}
		return items
	case "add":
		if strings.HasPrefix(cur, "-") {
			return []SlashItem{
				{Label: "--http", Insert: "--http ", Hint: "Streamable HTTP URL"},
				{Label: "--sse", Insert: "--sse ", Hint: "legacy SSE URL"},
				{Label: "--env", Insert: "--env ", Hint: "KEY=VALUE (stdio)"},
				{Label: "--header", Insert: "--header ", Hint: "KEY=VALUE (remote)"},
			}
		}
	}
	return nil
}

func modelArgItems(prior []string, d ArgData) []SlashItem {
	if len(prior) != 1 { // the single ref arg is already placed
		return nil
	}
	var items []SlashItem
	for _, ref := range d.ModelRefs {
		hint := ""
		if ref == d.CurrentModel {
			hint = i18n.M.ArgModelCurrent
		}
		items = append(items, SlashItem{Label: ref, Insert: ref, Hint: hint})
	}
	return items
}

func skillArgItems(prior []string, d ArgData) []SlashItem {
	if len(prior) <= 1 {
		return []SlashItem{
			{Label: "list", Insert: "list", Hint: i18n.M.ArgSkillList},
			{Label: "show", Insert: "show ", Hint: i18n.M.ArgSkillShow, Descend: true},
			{Label: "new", Insert: "new ", Hint: i18n.M.ArgSkillNew},
			{Label: "paths", Insert: "paths", Hint: i18n.M.ArgSkillPaths},
		}
	}
	if (prior[1] == "show" || prior[1] == "cat") && len(prior) == 2 {
		var items []SlashItem
		for _, s := range d.Skills {
			items = append(items, SlashItem{Label: s.Name, Insert: s.Name, Hint: string(s.Scope)})
		}
		return items
	}
	return nil
}

func hooksArgItems(prior []string) []SlashItem {
	if len(prior) <= 1 {
		return []SlashItem{
			{Label: "list", Insert: "list", Hint: i18n.M.ArgHooksList},
			{Label: "trust", Insert: "trust", Hint: i18n.M.ArgHooksTrust},
		}
	}
	return nil
}

// filterSlash keeps items whose label starts with the typed token (case-
// insensitive) and drops no-op suggestions — ones whose insert wouldn't change
// the line because the token is already fully typed (e.g. "/skill list" offering
// "list"). Without this the menu lingers on a complete command and Enter keeps
// "accepting" the no-op instead of sending.
func filterSlash(items []SlashItem, line string, from int, cur string) []SlashItem {
	lp := strings.ToLower(cur)
	prefix := line[:from]
	var out []SlashItem
	for _, it := range items {
		if !strings.HasPrefix(strings.ToLower(it.Label), lp) {
			continue
		}
		if prefix+it.Insert == line {
			continue // token already complete: nothing to add
		}
		out = append(out, it)
	}
	return out
}

// managementNotice handles the read-only management slash commands on the Submit
// path (used by the desktop and HTTP frontends, which route raw input through
// Submit — the chat TUI has its own richer handlers). It emits a Notice listing
// and reports whether it handled the verb. Skills and custom commands are NOT
// here — those resolve to a turn in Submit.
func (c *Controller) managementNotice(trimmed string) bool {
	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return false
	}
	switch fields[0] {
	case "/model":
		c.notice(c.modelListText())
	case "/memory":
		c.notice(c.memoryListText())
	case "/skill", "/skills":
		c.notice(c.skillListText())
	case "/hooks":
		c.notice(c.hookListText())
	case "/mcp":
		c.notice(c.mcpListText())
	default:
		return false
	}
	return true
}

func (c *Controller) modelListText() string {
	cfg, err := config.Load()
	if err != nil {
		return "model: " + err.Error()
	}
	var b strings.Builder
	b.WriteString("models (active: " + c.label + ")\n")
	for i := range cfg.Providers {
		p := &cfg.Providers[i]
		for _, m := range p.ModelList() {
			fmt.Fprintf(&b, "  %s/%s\n", p.Name, m)
		}
	}
	b.WriteString("switch with the model switcher, or type /model <provider/model>")
	return strings.TrimRight(b.String(), "\n")
}

func (c *Controller) memoryListText() string {
	if c.mem == nil || len(c.mem.Docs) == 0 {
		return "memory: none — add with “#<note>” or run /init to generate AGENTS.md"
	}
	var b strings.Builder
	b.WriteString("memory files\n")
	for _, d := range c.mem.Docs {
		fmt.Fprintf(&b, "  (%s) %s\n", d.Scope, d.Path)
	}
	return strings.TrimRight(b.String(), "\n")
}

func (c *Controller) skillListText() string {
	if len(c.skills) == 0 {
		return "skills: none defined — invoke a built-in like /init, or author one with install_skill"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "skills (%d)\n", len(c.skills))
	for _, s := range c.skills {
		tag := ""
		if s.RunAs == "subagent" {
			tag = " 🧬"
		}
		fmt.Fprintf(&b, "  /%s%s — %s\n", s.Name, tag, s.Description)
	}
	return strings.TrimRight(b.String(), "\n")
}

func (c *Controller) hookListText() string {
	hooks := c.hooks.Hooks()
	if len(hooks) == 0 {
		return "hooks: none active — configure in .reasonix/settings.json (project, after trust) or ~/.reasonix/settings.json (global)"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "hooks (%d active)\n", len(hooks))
	for _, h := range hooks {
		match := h.Match
		if match == "" {
			match = "*"
		}
		fmt.Fprintf(&b, "  %s [%s] %s — %s\n", h.Event, h.Scope, match, h.Command)
	}
	return strings.TrimRight(b.String(), "\n")
}

func (c *Controller) mcpListText() string {
	if c.host == nil || len(c.host.ServerNames()) == 0 {
		return "mcp: no servers connected — add one in reasonix.toml ([[plugins]]) or a project .mcp.json"
	}
	var b strings.Builder
	b.WriteString("mcp servers\n")
	for _, name := range c.host.ServerNames() {
		fmt.Fprintf(&b, "  %s\n", name)
	}
	return strings.TrimRight(b.String(), "\n")
}
