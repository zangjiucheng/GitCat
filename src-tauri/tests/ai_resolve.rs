//! LLM Resolver: the whole request against a local mock server, one per
//! provider. Nothing here reaches a real API — the server is a TcpListener on
//! 127.0.0.1 that records the request it gets and replies with a canned body.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use gitcat_lib::ai_resolve::{request_suggestion, AiProvider, AiSettings, HunkInput};
use serde_json::{json, Value};

struct Seen {
    request_line: String,
    headers: Vec<(String, String)>,
    body: Value,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Serve exactly one request with `status` + `reply`, and hand back what came in.
fn mock(status: u16, reply: Value) -> (String, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut r = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        r.read_line(&mut request_line).unwrap();
        let mut headers = Vec::new();
        loop {
            let mut l = String::new();
            r.read_line(&mut l).unwrap();
            let l = l.trim_end();
            if l.is_empty() {
                break;
            }
            let (k, v) = l.split_once(':').unwrap();
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
        let len: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).map(|(_, v)| v.parse().unwrap()).unwrap_or(0);
        let mut buf = vec![0; len];
        r.read_exact(&mut buf).unwrap();
        let out = reply.to_string();
        let mut w = stream;
        write!(w, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}", out.len()).unwrap();
        tx.send(Seen { request_line: request_line.trim_end().to_string(), headers, body: serde_json::from_slice(&buf).unwrap() }).unwrap();
    });
    (url, rx)
}

fn hunk() -> HunkInput {
    HunkInput {
        file: "src/config.ts".into(),
        op: "merge".into(),
        before: "export const config = {\n".into(),
        ours: "  ttl: 3600,\n".into(),
        base: Some("  ttl: 60,\n".into()),
        theirs: "  ttl: 60,\n  retries: 3,\n".into(),
        after: "};\n".into(),
        locale: "en".into(),
    }
}

#[test]
fn anthropic_request_carries_the_key_version_and_hunk_and_returns_the_suggestion() {
    let (url, rx) = mock(
        200,
        json!({
            "model": "claude-opus-5-5",
            "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": "{\"resolution\":\"  ttl: 3600,\\n  retries: 3,\",\"explanation\":\"Kept our TTL and their retries.\"}" }]
        }),
    );
    let s = AiSettings { enabled: true, provider: AiProvider::Anthropic, base_url: url, api_key: "sk-test".into(), ..Default::default() };
    let got = request_suggestion(&s, &hunk()).unwrap();
    // The missing final newline is restored to match OURS.
    assert_eq!(got.resolution, "  ttl: 3600,\n  retries: 3,\n");
    assert_eq!(got.explanation, "Kept our TTL and their retries.");
    assert_eq!(got.model, "claude-opus-5-5");

    let seen = rx.recv().unwrap();
    assert_eq!(seen.request_line, "POST /v1/messages HTTP/1.1");
    assert_eq!(seen.header("x-api-key"), Some("sk-test"));
    assert_eq!(seen.header("anthropic-version"), Some("2026-10-21"));
    assert_eq!(seen.header("anthropic-beta"), Some("server-side-fallback-2026-07-01"));
    assert_eq!(seen.body["model"], "claude-opus-5-5");
    assert_eq!(seen.body["fallbacks"], "default");
    let prompt = seen.body["messages"][0]["content"].as_str().unwrap();
    assert!(prompt.contains("<ours>\n  ttl: 3600,\n</ours>"));
    assert!(prompt.contains("<base>\n  ttl: 60,\n</base>"));
}

#[test]
fn anthropic_auth_errors_surface_the_providers_message() {
    let (url, _rx) = mock(401, json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } }));
    let s = AiSettings { enabled: true, provider: AiProvider::Anthropic, base_url: url, api_key: "bad".into(), ..Default::default() };
    let err = request_suggestion(&s, &hunk()).unwrap_err();
    assert!(err.starts_with("i18n:err_ai.auth_failed"), "{err}");
    assert!(err.contains("invalid x-api-key"), "{err}");
}

#[test]
fn openai_compatible_request_needs_no_key_and_reads_choices() {
    let (url, rx) = mock(
        200,
        json!({
            "model": "qwen2.5-coder",
            "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": "```json\n{\"resolution\": \"  ttl: 3600,\\n  retries: 3,\\n\", \"explanation\": \"both\"}\n```" } }]
        }),
    );
    let s = AiSettings { enabled: true, provider: AiProvider::OpenaiCompatible, model: "qwen2.5-coder".into(), base_url: format!("{url}/v1"), ..Default::default() };
    let got = request_suggestion(&s, &hunk()).unwrap();
    assert_eq!(got.resolution, "  ttl: 3600,\n  retries: 3,\n");
    assert_eq!(got.model, "qwen2.5-coder");

    let seen = rx.recv().unwrap();
    assert_eq!(seen.request_line, "POST /v1/chat/completions HTTP/1.1");
    assert_eq!(seen.header("authorization"), None, "no key configured, none sent");
    assert_eq!(seen.body["messages"][0]["role"], "system");
}

#[test]
fn a_missing_key_or_model_fails_before_any_request() {
    let s = AiSettings { enabled: true, provider: AiProvider::Anthropic, base_url: "http://127.0.0.1:9".into(), ..Default::default() };
    // ANTHROPIC_API_KEY is only used for api.anthropic.com, so this holds on
    // a developer machine that has it set, too.
    assert_eq!(request_suggestion(&s, &hunk()).unwrap_err(), "i18n:err_ai.no_key");
    let o = AiSettings { enabled: true, provider: AiProvider::OpenaiCompatible, base_url: "http://127.0.0.1:9".into(), ..Default::default() };
    assert_eq!(request_suggestion(&o, &hunk()).unwrap_err(), "i18n:err_ai.no_model");
}

#[test]
fn a_key_is_never_sent_over_plain_http_to_another_machine() {
    let s = AiSettings { enabled: true, provider: AiProvider::OpenaiCompatible, model: "m".into(), base_url: "http://lan-box.invalid:8080/v1".into(), api_key: "sk-secret".into() };
    let err = request_suggestion(&s, &hunk()).unwrap_err();
    assert!(err.starts_with("i18n:err_ai.insecure_key"), "{err}");
}
