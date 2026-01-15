use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Debug, Default)]
struct CodexState {
    resume: Option<String>,
    answer: Option<String>,
    turn_index: usize,
    note_seq: usize,
}

#[derive(Debug, Default)]
struct ClaudeState {
    resume: Option<String>,
    pending: HashMap<String, Value>,
    note_seq: usize,
}

#[derive(Debug, Default)]
pub struct AgentParser {
    codex: CodexState,
    claude: ClaudeState,
}

impl AgentParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn parse_value(&mut self, value: &Value) -> Option<Vec<Value>> {
        if let Some(events) = parse_codex_event(value, &mut self.codex) {
            return Some(events);
        }
        parse_claude_event(value, &mut self.claude)
    }

    pub fn parse_line(&mut self, line: &str) -> Option<Vec<Value>> {
        let value: Value = serde_json::from_str(line).ok()?;
        self.parse_value(&value)
    }
}

fn agent_event(engine: &str, kind: &str, mut payload: Map<String, Value>) -> Value {
    payload.insert("type".to_string(), Value::String(format!("agent.{kind}")));
    payload.insert("engine".to_string(), Value::String(engine.to_string()));
    Value::Object(payload)
}

fn action_event(engine: &str, phase: &str, action: Value, ok: Option<bool>, message: Option<&str>, level: Option<&str>) -> Value {
    let mut payload = Map::new();
    payload.insert("phase".to_string(), Value::String(phase.to_string()));
    payload.insert("action".to_string(), action);
    if let Some(ok) = ok {
        payload.insert("ok".to_string(), Value::Bool(ok));
    }
    if let Some(message) = message {
        payload.insert("message".to_string(), Value::String(message.to_string()));
    }
    if let Some(level) = level {
        payload.insert("level".to_string(), Value::String(level.to_string()));
    }
    agent_event(engine, "action", payload)
}

fn started_event(engine: &str, resume: &str, title: Option<&str>, meta: Option<Value>) -> Value {
    let mut payload = Map::new();
    payload.insert("resume".to_string(), Value::String(resume.to_string()));
    if let Some(title) = title {
        payload.insert("title".to_string(), Value::String(title.to_string()));
    }
    if let Some(meta) = meta {
        payload.insert("meta".to_string(), meta);
    }
    agent_event(engine, "started", payload)
}

fn message_event(engine: &str, text: &str) -> Value {
    let mut payload = Map::new();
    payload.insert("text".to_string(), Value::String(text.to_string()));
    agent_event(engine, "message", payload)
}

fn completed_event(engine: &str, ok: bool, answer: &str, resume: Option<&str>, error: Option<&str>, usage: Option<Value>) -> Value {
    let mut payload = Map::new();
    payload.insert("ok".to_string(), Value::Bool(ok));
    payload.insert("answer".to_string(), Value::String(answer.to_string()));
    if let Some(resume) = resume {
        payload.insert("resume".to_string(), Value::String(resume.to_string()));
    }
    if let Some(error) = error {
        payload.insert("error".to_string(), Value::String(error.to_string()));
    }
    if let Some(usage) = usage {
        payload.insert("usage".to_string(), usage);
    }
    agent_event(engine, "completed", payload)
}

fn value_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn parse_codex_event(value: &Value, state: &mut CodexState) -> Option<Vec<Value>> {
    let event_type = value.get("type")?.as_str()?;
    match event_type {
        "thread.started" => {
            let thread_id = value_str(value, "thread_id")?;
            state.resume = Some(thread_id.to_string());
            Some(vec![started_event("codex", thread_id, Some("Codex"), None)])
        }
        "turn.started" => {
            let action_id = format!("turn:{}", state.turn_index);
            state.turn_index += 1;
            let action = action_map(&action_id, "turn", "turn started", Map::new());
            Some(vec![action_event("codex", "started", action, None, None, None)])
        }
        "turn.completed" => {
            let action_id = format!("turn:{}", state.turn_index.saturating_sub(1));
            let action = action_map(&action_id, "turn", "turn completed", Map::new());
            let usage = value.get("usage").cloned();
            let resume = state.resume.as_deref();
            Some(vec![
                action_event("codex", "completed", action, Some(true), None, None),
                completed_event("codex", true, state.answer.as_deref().unwrap_or("") , resume, None, usage),
            ])
        }
        "turn.failed" => {
            let error_msg = value
                .get("error")
                .and_then(|err| err.get("message"))
                .and_then(Value::as_str);
            let resume = state.resume.as_deref();
            Some(vec![completed_event(
                "codex",
                false,
                state.answer.as_deref().unwrap_or(""),
                resume,
                error_msg,
                None,
            )])
        }
        "error" => {
            let message = value_str(value, "message");
            if let Some(message) = message {
                state.note_seq += 1;
                let action_id = format!("codex.note.{}", state.note_seq);
                let mut detail = Map::new();
                detail.insert("message".to_string(), Value::String(message.to_string()));
                let action = action_map(&action_id, "warning", message, detail);
                return Some(vec![action_event(
                    "codex",
                    "completed",
                    action,
                    Some(false),
                    Some(message),
                    Some("warning"),
                )]);
            }
            Some(vec![])
        }
        "item.started" | "item.updated" | "item.completed" => {
            let phase = match event_type {
                "item.started" => "started",
                "item.updated" => "updated",
                _ => "completed",
            };
            let item = value.get("item")?;
            Some(codex_item_events(phase, item, state))
        }
        _ => None,
    }
}

fn codex_item_events(phase: &str, item: &Value, state: &mut CodexState) -> Vec<Value> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    if item_type == "agent_message" {
        if let Some(text) = value_str(item, "text") {
            state.answer = Some(text.to_string());
            return vec![message_event("codex", text)];
        }
        return vec![];
    }

    let action_id = value_str(item, "id");
    if action_id.is_none() {
        return vec![];
    }
    let action_id = action_id.unwrap();

    match item_type {
        "command_execution" => {
            let command = value_str(item, "command").unwrap_or("command");
            let status = value_str(item, "status");
            let exit_code = item.get("exit_code");
            let mut detail = Map::new();
            if let Some(status) = status {
                detail.insert("status".to_string(), Value::String(status.to_string()));
            }
            if let Some(exit_code) = exit_code {
                detail.insert("exit_code".to_string(), exit_code.clone());
            }
            let action = action_map(action_id, "command", command, detail);
            let ok = if phase == "completed" {
                let mut ok = status == Some("completed");
                if let Some(code) = exit_code.and_then(Value::as_i64) {
                    ok = ok && code == 0;
                }
                Some(ok)
            } else {
                None
            };
            vec![action_event("codex", phase, action, ok, None, None)]
        }
        "mcp_tool_call" => {
            let server = value_str(item, "server");
            let tool = value_str(item, "tool");
            let status = value_str(item, "status");
            let mut title = String::new();
            if let Some(server) = server {
                title.push_str(server);
            }
            if let Some(tool) = tool {
                if !title.is_empty() {
                    title.push('.');
                }
                title.push_str(tool);
            }
            if title.is_empty() {
                title = "tool".to_string();
            }
            let mut detail = Map::new();
            if let Some(server) = server {
                detail.insert("server".to_string(), Value::String(server.to_string()));
            }
            if let Some(tool) = tool {
                detail.insert("tool".to_string(), Value::String(tool.to_string()));
            }
            if let Some(status) = status {
                detail.insert("status".to_string(), Value::String(status.to_string()));
            }
            if let Some(arguments) = item.get("arguments") {
                detail.insert("arguments".to_string(), arguments.clone());
            }
            let mut ok = None;
            if phase == "completed" {
                let error = item.get("error");
                if let Some(error) = error {
                    if let Some(message) = error.get("message").and_then(Value::as_str) {
                        detail.insert("error_message".to_string(), Value::String(message.to_string()));
                    }
                }
                if let Some(result_summary) = codex_mcp_result_summary(item.get("result")) {
                    detail.insert("result_summary".to_string(), result_summary);
                }
                ok = Some(status == Some("completed") && error.is_none());
            }
            let action = action_map(action_id, "tool", &title, detail);
            vec![action_event("codex", phase, action, ok, None, None)]
        }
        "web_search" => {
            let query = value_str(item, "query").unwrap_or("search");
            let mut detail = Map::new();
            detail.insert("query".to_string(), Value::String(query.to_string()));
            let action = action_map(action_id, "web_search", query, detail);
            let ok = if phase == "completed" { Some(true) } else { None };
            vec![action_event("codex", phase, action, ok, None, None)]
        }
        "file_change" => {
            if phase != "completed" {
                return vec![];
            }
            let (title, changes) = codex_change_summary(item.get("changes"));
            let mut detail = Map::new();
            detail.insert("changes".to_string(), changes);
            if let Some(status) = value_str(item, "status") {
                detail.insert("status".to_string(), Value::String(status.to_string()));
            }
            let ok = value_str(item, "status") == Some("completed");
            let action = action_map(action_id, "file_change", &title, detail);
            vec![action_event("codex", "completed", action, Some(ok), None, None)]
        }
        "todo_list" => {
            let (done, total, next_text) = codex_todo_summary(item.get("items"));
            let title = if total == 0 {
                "todo".to_string()
            } else if let Some(next_text) = next_text {
                format!("todo {done}/{total}: {next_text}")
            } else {
                format!("todo {done}/{total}: done")
            };
            let mut detail = Map::new();
            detail.insert("done".to_string(), Value::Number(done.into()));
            detail.insert("total".to_string(), Value::Number(total.into()));
            let action = action_map(action_id, "note", &title, detail);
            let ok = if phase == "completed" { Some(true) } else { None };
            vec![action_event("codex", phase, action, ok, None, None)]
        }
        "reasoning" => {
            let text = value_str(item, "text").unwrap_or("note");
            let action = action_map(action_id, "note", text, Map::new());
            let ok = if phase == "completed" { Some(true) } else { None };
            vec![action_event("codex", phase, action, ok, None, None)]
        }
        "error" => {
            let message = value_str(item, "message").unwrap_or("error");
            let mut detail = Map::new();
            detail.insert("message".to_string(), Value::String(message.to_string()));
            let action = action_map(action_id, "warning", message, detail);
            vec![action_event(
                "codex",
                "completed",
                action,
                Some(false),
                Some(message),
                Some("warning"),
            )]
        }
        _ => vec![],
    }
}

fn codex_mcp_result_summary(result: Option<&Value>) -> Option<Value> {
    let result = result?;
    let obj = result.as_object()?;
    let mut summary = Map::new();
    if let Some(content) = obj.get("content") {
        if let Some(list) = content.as_array() {
            summary.insert("content_blocks".to_string(), Value::Number(list.len().into()));
        } else {
            summary.insert("content_blocks".to_string(), Value::Number(1.into()));
        }
    }
    if obj.contains_key("structured_content") {
        let has_structured = !obj.get("structured_content").is_some_and(Value::is_null);
        summary.insert("has_structured".to_string(), Value::Bool(has_structured));
    } else if obj.contains_key("structured") {
        let has_structured = !obj.get("structured").is_some_and(Value::is_null);
        summary.insert("has_structured".to_string(), Value::Bool(has_structured));
    }
    if summary.is_empty() {
        None
    } else {
        Some(Value::Object(summary))
    }
}

fn codex_change_summary(changes: Option<&Value>) -> (String, Value) {
    let changes = match changes.and_then(Value::as_array) {
        Some(list) => list,
        None => return ("files".to_string(), Value::Array(vec![])),
    };
    let mut paths = Vec::new();
    let mut normalized = Vec::new();
    for change in changes {
        if let Some(obj) = change.as_object() {
            if let Some(path) = obj.get("path").and_then(Value::as_str) {
                paths.push(path.to_string());
                let mut entry = Map::new();
                entry.insert("path".to_string(), Value::String(path.to_string()));
                if let Some(kind) = obj.get("kind").and_then(Value::as_str) {
                    entry.insert("kind".to_string(), Value::String(kind.to_string()));
                }
                normalized.push(Value::Object(entry));
            }
        }
    }
    let title = if paths.is_empty() {
        let count = changes.len();
        if count == 0 {
            "files".to_string()
        } else {
            format!("{count} files")
        }
    } else {
        paths.join(", ")
    };
    (title, Value::Array(normalized))
}

fn codex_todo_summary(items: Option<&Value>) -> (usize, usize, Option<String>) {
    let list = match items.and_then(Value::as_array) {
        Some(list) => list,
        None => return (0, 0, None),
    };
    let mut done = 0;
    let mut total = 0;
    let mut next_text = None;
    for item in list {
        let obj = match item.as_object() {
            Some(obj) => obj,
            None => continue,
        };
        total += 1;
        if obj.get("completed").and_then(Value::as_bool) == Some(true) {
            done += 1;
            continue;
        }
        if next_text.is_none() {
            if let Some(text) = obj.get("text").and_then(Value::as_str) {
                next_text = Some(text.to_string());
            }
        }
    }
    (done, total, next_text)
}

fn parse_claude_event(value: &Value, state: &mut ClaudeState) -> Option<Vec<Value>> {
    let event_type = value.get("type")?.as_str()?;
    match event_type {
        "system" => {
            if value_str(value, "subtype") != Some("init") {
                return Some(vec![]);
            }
            let session_id = value_str(value, "session_id")?;
            state.resume = Some(session_id.to_string());
            let mut meta = Map::new();
            for key in ["cwd", "tools", "permissionMode", "output_style", "model"] {
                if let Some(val) = value.get(key) {
                    meta.insert(key.to_string(), val.clone());
                }
            }
            let meta = if meta.is_empty() { None } else { Some(Value::Object(meta)) };
            let title = value_str(value, "model");
            Some(vec![started_event("claude", session_id, title, meta)])
        }
        "assistant" => {
            let message = value.get("message").and_then(Value::as_object)?;
            let content = message.get("content").and_then(Value::as_array)?;
            let mut events = Vec::new();
            let mut text_parts = Vec::new();
            for block in content {
                let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
                match block_type {
                    "tool_use" => {
                        let tool_id = value_str(block, "id");
                        if tool_id.is_none() {
                            continue;
                        }
                        let tool_id = tool_id.unwrap();
                        let name = value_str(block, "name").unwrap_or("tool");
                        let tool_input = block.get("input").and_then(Value::as_object).cloned().unwrap_or_default();
                        let (kind, title) = tool_kind_and_title(name, &tool_input);
                        let mut detail = Map::new();
                        detail.insert("name".to_string(), Value::String(name.to_string()));
                        detail.insert("input".to_string(), Value::Object(tool_input.clone()));
                        if kind == "file_change" {
                            if let Some(path) = tool_input_path(&tool_input, &["file_path", "path"]) {
                                detail.insert(
                                    "changes".to_string(),
                                    Value::Array(vec![{
                                        let mut change = Map::new();
                                        change.insert("path".to_string(), Value::String(path));
                                        change.insert("kind".to_string(), Value::String("update".to_string()));
                                        Value::Object(change)
                                    }]),
                                );
                            }
                        }
                        let action = action_map(tool_id, &kind, &title, detail);
                        state.pending.insert(tool_id.to_string(), action.clone());
                        events.push(action_event("claude", "started", action, None, None, None));
                    }
                    "tool_result" => {
                        let tool_use_id = value_str(block, "tool_use_id");
                        if tool_use_id.is_none() {
                            continue;
                        }
                        let tool_use_id = tool_use_id.unwrap();
                        let mut action = state
                            .pending
                            .remove(tool_use_id)
                            .unwrap_or_else(|| action_map(tool_use_id, "tool", "tool", Map::new()));
                        if let Some(action_obj) = action.as_object_mut() {
                            let mut detail = action_obj
                                .get("detail")
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            let preview = claude_result_preview(block.get("content"));
                            detail.insert("tool_use_id".to_string(), Value::String(tool_use_id.to_string()));
                            detail.insert("result_preview".to_string(), Value::String(preview.clone()));
                            detail.insert("result_len".to_string(), Value::Number(preview.len().into()));
                            let is_error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                            detail.insert("is_error".to_string(), Value::Bool(is_error));
                            action_obj.insert("detail".to_string(), Value::Object(detail));
                            events.push(action_event("claude", "completed", action.clone(), Some(!is_error), None, None));
                        }
                    }
                    "thinking" => {
                        if let Some(thinking) = value_str(block, "thinking") {
                            state.note_seq += 1;
                            let title = thinking.lines().next().unwrap_or("thinking");
                            let mut detail = Map::new();
                            detail.insert("thinking".to_string(), Value::String(thinking.to_string()));
                            let action_id = format!("claude.note.{}", state.note_seq);
                            let action = action_map(&action_id, "note", title, detail);
                            events.push(action_event("claude", "completed", action, Some(true), None, None));
                        }
                    }
                    "text" => {
                        if let Some(text) = value_str(block, "text") {
                            text_parts.push(text.to_string());
                        }
                    }
                    _ => {}
                }
            }
            if !text_parts.is_empty() {
                events.push(message_event("claude", &text_parts.join("")));
            }
            Some(events)
        }
        "result" => {
            let ok = value.get("is_error").and_then(Value::as_bool) != Some(true);
            let answer = value_str(value, "result").unwrap_or("");
            let usage = value.get("usage").cloned();
            let error = if ok { None } else { Some(answer) };
            let resume = state.resume.as_deref();
            Some(vec![completed_event("claude", ok, answer, resume, error, usage)])
        }
        _ => None,
    }
}

fn action_map(id: &str, kind: &str, title: &str, detail: Map<String, Value>) -> Value {
    let mut map = Map::new();
    map.insert("id".to_string(), Value::String(id.to_string()));
    map.insert("kind".to_string(), Value::String(kind.to_string()));
    map.insert("title".to_string(), Value::String(title.to_string()));
    map.insert("detail".to_string(), Value::Object(detail));
    Value::Object(map)
}

fn tool_input_path(tool_input: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = tool_input.get(*key).and_then(Value::as_str) {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn tool_kind_and_title(name: &str, tool_input: &Map<String, Value>) -> (String, String) {
    let name_lower = name.to_lowercase();
    if ["bash", "shell"].contains(&name_lower.as_str()) {
        let command = tool_input.get("command").and_then(Value::as_str).unwrap_or(name);
        return ("command".to_string(), command.to_string());
    }
    if ["read", "edit", "write", "multiedit"].contains(&name_lower.as_str()) {
        let path = tool_input_path(tool_input, &["file_path", "path"]).unwrap_or_else(|| name.to_string());
        return ("file_change".to_string(), path);
    }
    if ["websearch", "web_search", "webfetch", "browser"].contains(&name_lower.as_str()) {
        let query = tool_input
            .get("query")
            .or_else(|| tool_input.get("url"))
            .and_then(Value::as_str)
            .unwrap_or(name);
        return ("web_search".to_string(), query.to_string());
    }
    if ["task", "agent"].contains(&name_lower.as_str()) {
        let title = tool_input
            .get("title")
            .or_else(|| tool_input.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(name);
        return ("subagent".to_string(), title.to_string());
    }
    ("tool".to_string(), name.to_string())
}

fn claude_result_preview(content: Option<&Value>) -> String {
    match content {
        None => String::new(),
        Some(Value::String(text)) => text.to_string(),
        Some(Value::Array(items)) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
            parts.join("\n")
        }
        Some(Value::Object(obj)) => obj
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some(other) => other.to_string(),
    }
}
