package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

var planTool = domain.ModelTool{Name: "update_plan", Description: "Record or revise your step-by-step plan for multi-step work; the user sees it. Send the whole plan each time, with at most one step in_progress. Skip it for single-step tasks.", Parameters: json.RawMessage(`{"type":"object","properties":{"explanation":{"type":"string"},"plan":{"type":"array","items":{"type":"object","properties":{"step":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["step","status"],"additionalProperties":false}}},"required":["plan"],"additionalProperties":false}`)}

// updatePlan replaces the turn's single plan item rather than adding a tool row.
func (r *NativeRuntime) updatePlan(turn domain.TurnID, call domain.ModelToolCall) (string, error) {
	var input struct {
		Explanation string `json:"explanation"`
		Plan        []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"plan"`
	}
	if json.Unmarshal(call.Arguments, &input) != nil || len(input.Plan) == 0 || len(input.Plan) > 50 {
		return "", errors.New("invalid plan")
	}
	var b strings.Builder
	for _, step := range input.Plan {
		text := strings.TrimSpace(strings.ReplaceAll(step.Step, "\n", " "))
		switch {
		case text == "":
			return "", errors.New("invalid plan: empty step")
		case step.Status == "completed":
			fmt.Fprintf(&b, "- [x] %s\n", text)
		case step.Status == "in_progress":
			fmt.Fprintf(&b, "- [ ] **%s**\n", text)
		case step.Status == "pending":
			fmt.Fprintf(&b, "- [ ] %s\n", text)
		default:
			return "", fmt.Errorf("invalid plan: status %q", step.Status)
		}
	}
	if input.Explanation != "" {
		b.WriteString("\n" + input.Explanation)
	}
	r.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &domain.Item{ID: domain.ItemID("plan-" + string(turn)), SessionID: r.cfg.SessionID, TurnID: turn, Kind: domain.ItemPlan, Status: domain.ItemCompleted, Text: b.String()}})
	return "Plan updated", nil
}
