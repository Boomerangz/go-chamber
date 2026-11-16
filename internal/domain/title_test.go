package domain

import "testing"

func TestNameKeepsTheHigherSource(t *testing.T) {
	s, err := NewSession("s1", AgentCodex, "/p")
	mustNoErr(t, err)
	if !s.Name("first words", TitleMessage) || s.Title() != "first words" {
		t.Fatalf("message title not set: %q", s.Title())
	}
	if !s.Name("Agent's name", TitleAgent) || s.Title() != "Agent's name" {
		t.Fatalf("agent title must beat the message: %q", s.Title())
	}
	if s.Name("later words", TitleMessage) {
		t.Fatal("a message must not override the agent's name")
	}
	s.Rename("Mine")
	if s.Name("Agent again", TitleAgent) || s.Title() != "Mine" {
		t.Fatalf("agent must not override the owner: %q", s.Title())
	}
	s.Rename("")
	if !s.Name("Agent again", TitleAgent) {
		t.Fatal("a cleared name must accept the agent's again")
	}
}

func TestRestoredTitleIsNotOverriddenByAgent(t *testing.T) {
	s, err := RestoreSession(SessionSnapshot{ID: "s1", Agent: AgentCodex, Cwd: "/p", Status: StatusIdle, Title: "Saved"})
	mustNoErr(t, err)
	if s.Name("Agent", TitleAgent) || s.Title() != "Saved" {
		t.Fatalf("restored title replaced: %q", s.Title())
	}
}
