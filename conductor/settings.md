# Conductor Settings

User preferences stored in `settings` table.

## All Settings

| Key | Value | Description |
|-----|-------|-------------|
| `default_model` | `opus` | Default AI model for coding |
| `review_model` | `gpt-5.2` | Model used for code review |
| `default_thinking_enabled` | `true` | Enable thinking blocks |
| `review_thinking_enabled` | `true` | Enable thinking in reviews |
| `notifications_enabled` | `true` | Desktop notifications |
| `sound_effects_enabled` | `true` | Audio feedback |
| `sound_type` | `default` | Sound theme |
| `right_panel_visible` | `true` | Show right panel |
| `show_cost_in_topbar` | `true` | Display token costs |
| `mono_font` | `Geist Mono` | Monospace font |
| `markdown_style` | `default` | Markdown rendering style |
| `branch_prefix_type` | `github_username` | How to name branches |
| `experimental_shortcuts` | `true` | Enable experimental features |
| `spotlight_testing` | `true` | Spotlight integration |
| `using_split_view` | `false` | Split view mode |
| `default_open_in` | `antigravity` | Default app to open files |
| `last_clone_directory` | `/Users/.../conductor/repos` | Last clone location |
| `onboarding_dismissed` | `true` | Onboarding completed |
| `onboarding_step` | `0` | Current onboarding step |
| `last_seen_announcement` | `2.29.4` | Last viewed announcement |
| `conductor_api_token` | `aHO8OV1T_...` | API token for Conductor services |

## Model Configuration

### Default Model (Coding)
```
default_model = opus
```
Claude Opus is used for primary development tasks.

### Review Model (Code Review)
```
review_model = gpt-5.2
```
GPT-5.2 is used specifically for:
- PR reviews
- Security audits
- Code analysis

### Thinking Mode
```
default_thinking_enabled = true
review_thinking_enabled = true
```
Both models can use extended thinking/reasoning.

## UI Settings

### Fonts
```
mono_font = Geist Mono
```

### Display
```
right_panel_visible = true
show_cost_in_topbar = true
using_split_view = false
```

### Audio/Notifications
```
notifications_enabled = true
sound_effects_enabled = true
sound_type = default
```

## Experimental Features

```
experimental_shortcuts = true
spotlight_testing = true
```

## Integration

### Default Open In
```
default_open_in = antigravity
```
Opens files in Antigravity (Google's editor - `com.google.antigravity`).

### Branch Naming
```
branch_prefix_type = github_username
```
Branches are prefixed with GitHub username (e.g., `jparklev/victoria`).

## Query Settings

```sql
SELECT key, value FROM settings ORDER BY key;
```
