# Hindsight Bank Missions

## Global Bank (`sil`)

### retain_mission
```
Focus on user preferences, communication style, workflow habits, and recurring patterns across projects. Deprioritize one-time events and project-specific implementation details.
```

### observations_mission
```
Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Focus on what the user consistently does or prefers — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations.
```

## Project Banks (`project-*`)

### retain_mission
```
Focus on coding conventions, architecture decisions, tech stack choices, project-specific patterns, and user preferences within this codebase. Deprioritize one-time events and transient debugging steps.
```

### observations_mission
```
Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Also capture key project context: architecture decisions, tech stack choices, known constraints, and established patterns in the codebase. Focus on what persists across sessions — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations.
```

## How to apply

```bash
# Global bank
curl -X PATCH "http://10.0.0.1:9000/v1/default/banks/sil/config" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": {
      "retain_mission": "Focus on user preferences, communication style, workflow habits, and recurring patterns across projects. Deprioritize one-time events and project-specific implementation details.",
      "observations_mission": "Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Focus on what the user consistently does or prefers — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations."
    }
  }'

# Project bank (replace bank_id)
curl -X PATCH "http://10.0.0.1:9000/v1/default/banks/{bank_id}/config" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": {
      "retain_mission": "Focus on coding conventions, architecture decisions, tech stack choices, project-specific patterns, and user preferences within this codebase. Deprioritize one-time events and transient debugging steps.",
      "observations_mission": "Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Also capture key project context: architecture decisions, tech stack choices, known constraints, and established patterns in the codebase. Focus on what persists across sessions — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations."
    }
  }'
```
