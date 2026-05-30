package acp

import "testing"

func TestFlattenPrompt(t *testing.T) {
	tests := []struct {
		name   string
		blocks []ContentBlock
		want   string
	}{
		{
			name:   "text blocks join with blank line",
			blocks: []ContentBlock{{Type: "text", Text: "hello"}, {Type: "text", Text: "world"}},
			want:   "hello\n\nworld",
		},
		{
			name: "resource contributes inline text",
			blocks: []ContentBlock{
				{Type: "text", Text: "see file:"},
				{Type: "resource", Resource: &ResourceContents{URI: "file:///x", Text: "contents"}},
			},
			want: "see file:\n\ncontents",
		},
		{
			name: "resource without inline text is dropped",
			blocks: []ContentBlock{
				{Type: "resource", Resource: &ResourceContents{URI: "file:///x"}},
				{Type: "text", Text: "only this"},
			},
			want: "only this",
		},
		{
			name: "image and audio blocks are ignored",
			blocks: []ContentBlock{
				{Type: "image", MimeType: "image/png", Data: "base64"},
				{Type: "text", Text: "kept"},
				{Type: "audio", MimeType: "audio/wav", Data: "base64"},
			},
			want: "kept",
		},
		{
			name:   "surrounding whitespace trimmed",
			blocks: []ContentBlock{{Type: "text", Text: "  spaced  "}},
			want:   "spaced",
		},
		{
			name:   "empty input",
			blocks: nil,
			want:   "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FlattenPrompt(tt.blocks); got != tt.want {
				t.Errorf("FlattenPrompt() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestToolKindFor(t *testing.T) {
	tests := map[string]string{
		"read_file":             "read",
		"ls":                    "read",
		"glob":                  "read",
		"grep":                  "search",
		"edit_file":             "edit",
		"multiedit":             "edit",
		"write_file":            "edit",
		"bash":                  "execute",
		"webfetch":              "other",
		"task":                  "other",
		"mcp__server__do_thing": "other",
		"semantic_search":       "search", // heuristic fallback
		"run_command":           "execute",
		"unknown":               "other",
	}
	for name, want := range tests {
		if got := toolKindFor(name); got != want {
			t.Errorf("toolKindFor(%q) = %q, want %q", name, got, want)
		}
	}
}
