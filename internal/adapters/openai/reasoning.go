package openai

// Adapted from Pi openai-completions.ts appendOpenAIReasoningDetail (LICENSE.pi).
// Keep encrypted entries discrete and opaque; only join adjacent text/summary
// deltas of the same block. Unknown fields survive replay unchanged.
import "encoding/json"

func appendReasoningDetail(details []map[string]json.RawMessage, next map[string]json.RawMessage) []map[string]json.RawMessage {
	var kind string
	_ = json.Unmarshal(next["type"], &kind)
	field := ""
	switch kind {
	case "reasoning.text":
		field = "text"
	case "reasoning.summary":
		field = "summary"
	}
	if field != "" && len(details) > 0 {
		last := details[len(details)-1]
		if string(last["type"]) == string(next["type"]) && compatibleDetailField(last, next, "index") && compatibleDetailField(last, next, "id") {
			var previous, delta string
			if json.Unmarshal(last[field], &previous) == nil && json.Unmarshal(next[field], &delta) == nil {
				last[field], _ = json.Marshal(previous + delta)
				for key, value := range next {
					if len(last[key]) == 0 || string(last[key]) == "null" || string(last[key]) == `""` {
						last[key] = value
					}
				}
				return details
			}
		}
	}
	return append(details, next)
}

func compatibleDetailField(a, b map[string]json.RawMessage, key string) bool {
	return len(a[key]) == 0 || len(b[key]) == 0 || string(a[key]) == "null" || string(b[key]) == "null" || string(a[key]) == string(b[key])
}
