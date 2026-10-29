#!/usr/bin/env python3
"""Call an LLM gateway from the command line; Python 3.11+, stdlib only.

The gateway comes from ASKLLM_BASE_URL / ASKLLM_API_KEY / ASKLLM_WIRE_API (or --base-url /
--wire-api) when set, otherwise from Codex's user config.toml and auth.json."""
import argparse
import json
import mimetypes
import os
from pathlib import Path
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError(f"HTTP {code}: redirect refused; credentials stay on configured gateway")


def load_json(source):
    return json.loads(sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8-sig"))


def assign(target, expression):
    key, sep, value = expression.partition("=")
    if not sep or not key:
        raise ValueError("Expected KEY=JSON")
    try:
        value = json.loads(value)
    except json.JSONDecodeError:
        value = value
    parts = key.split(".")
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = value


def resolve(args):
    base_override = args.base_url or os.environ.get("ASKLLM_BASE_URL")
    if base_override:
        return resolve_direct(args, base_override)
    home = Path(args.codex_home or os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    config_path = Path(args.config) if args.config else home / "config.toml"
    config = tomllib.loads(config_path.read_text(encoding="utf-8-sig"))
    # CLI overrides also select a profile, then override the selected profile.
    for override in args.config_override:
        assign(config, override)
    profile = args.profile or config.get("profile")
    if profile:
        profiles = config.get("profiles", {})
        if profile not in profiles:
            raise ValueError(f"Unknown profile: {profile}")
        config.update(profiles[profile])
    for override in args.config_override:
        assign(config, override)
    provider_id = args.provider or config.get("model_provider", "openai")
    provider = config.get("model_providers", {}).get(provider_id)
    if provider is None:
        if provider_id != "openai":
            raise ValueError(f"Unknown configured provider: {provider_id}")
        provider = {"base_url": os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                    "requires_openai_auth": True}
    if provider.get("auth") or provider.get("aws"):
        raise ValueError("Command-backed/SigV4 auth is not supported by this API-key tool")
    base = provider.get("base_url")
    parsed = urllib.parse.urlsplit(base or "")
    if parsed.scheme not in ("https", "http") or not parsed.netloc or parsed.username or parsed.fragment:
        raise ValueError("Provider needs an http(s) base_url without embedded credentials or fragment")
    headers = {k.lower(): str(v) for k, v in provider.get("http_headers", {}).items()}
    for name, env in provider.get("env_http_headers", {}).items():
        if os.environ.get(env):
            headers[name.lower()] = os.environ[env]
    token = None
    auth_source = "provider headers / unauthenticated"
    if provider.get("env_key"):
        env = provider["env_key"]
        token = os.environ.get(env)
        if not token or not token.strip():
            raise ValueError(f"Missing provider credential environment variable: {env}")
        auth_source = f"env:{env}"
    elif provider.get("experimental_bearer_token"):
        token = provider["experimental_bearer_token"]
        auth_source = "provider.experimental_bearer_token"
    elif provider.get("requires_openai_auth"):
        auth_path = Path(args.auth) if args.auth else home / "auth.json"
        auth = load_json(str(auth_path))
        token = auth.get("OPENAI_API_KEY")
        if not token:
            raise ValueError("auth.json needs OPENAI_API_KEY; ChatGPT login tokens are not gateway API keys")
        auth_source = "auth.json:OPENAI_API_KEY"
    if token:
        headers["authorization"] = "Bearer " + token
    return {"config": str(config_path), "profile": profile, "provider": provider_id,
            "base_url": base, "model": args.model if args.command == "ask" else config.get("model"),
            "wire_api": provider.get("wire_api", "responses"), "auth_source": auth_source,
            "headers": headers, "query": provider.get("query_params", {})}


def resolve_direct(args, base):
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in ("https", "http") or not parsed.netloc or parsed.username or parsed.fragment:
        raise ValueError("ASKLLM_BASE_URL needs an http(s) URL without embedded credentials or fragment")
    wire_api = args.wire_api or os.environ.get("ASKLLM_WIRE_API") or "responses"
    headers = {}
    token = os.environ.get("ASKLLM_API_KEY", "").strip()
    if token:
        headers["authorization"] = "Bearer " + token
        if wire_api == "messages":
            headers["x-api-key"] = token
    return {"config": None, "profile": None, "provider": "env", "base_url": base,
            "model": args.model if args.command == "ask" else None, "wire_api": wire_api,
            "auth_source": "env:ASKLLM_API_KEY" if token else "unauthenticated",
            "headers": headers, "query": {}}


def endpoint_url(connection, endpoint, query):
    part = urllib.parse.urlsplit(endpoint)
    if part.scheme or part.netloc or part.fragment:
        raise ValueError("Endpoint must be a gateway-relative path, not an absolute URL")
    base = urllib.parse.urlsplit(connection["base_url"])
    path = part.path if endpoint.startswith("/") else base.path.rstrip("/") + "/" + part.path
    if any(segment in (".", "..") for segment in urllib.parse.unquote(path).split("/")):
        raise ValueError("Endpoint path must not contain traversal segments")
    params = dict(urllib.parse.parse_qsl(base.query))
    params.update(connection["query"])
    params.update(urllib.parse.parse_qsl(part.query))
    for entry in query:
        key, sep, value = entry.partition("=")
        if not sep:
            raise ValueError("Query parameter needs KEY=VALUE")
        params[key] = value
    return urllib.parse.urlunsplit((base.scheme, base.netloc, path, urllib.parse.urlencode(params), ""))


def multipart(fields, files):
    boundary = "AskLLM" + uuid.uuid4().hex
    chunks = []
    for entry in fields:
        name, sep, value = entry.partition("=")
        if not sep:
            raise ValueError("Form field needs NAME=VALUE")
        chunks.append((name, None, None, value.encode("utf-8")))
    for entry in files:
        name, sep, filename = entry.partition("=")
        if not sep:
            raise ValueError("File needs FIELD=PATH")
        path = Path(filename)
        chunks.append((name, path.name, mimetypes.guess_type(path.name)[0] or "application/octet-stream", path.read_bytes()))
    body = bytearray()
    for name, filename, mime, content in chunks:
        if any(c in name + (filename or "") for c in '\r\n"'):
            raise ValueError("Invalid multipart field name or filename")
        header = f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
        if filename:
            header += f'; filename="{filename}"\r\nContent-Type: {mime}'
        body.extend((header + "\r\n\r\n").encode("utf-8"))
        body.extend(content + b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    return bytes(body), "multipart/form-data; boundary=" + boundary


def prepare(args, connection):
    headers = dict(connection["headers"])
    for entry in args.header:
        name, sep, value = entry.partition(":")
        if not sep:
            raise ValueError("Header needs NAME:VALUE")
        headers[name.strip().lower()] = value.strip()
    body = None
    if args.command == "models":
        return "GET", args.endpoint or "models", headers, None
    if args.command == "ask":
        prompt = args.prompt
        if args.prompt_file:
            prompt = sys.stdin.read() if args.prompt_file == "-" else Path(args.prompt_file).read_text(encoding="utf-8-sig")
        if prompt is None:
            raise ValueError("ask needs a prompt or --prompt-file")
        api = args.api if args.api != "auto" else connection["wire_api"]
        if api not in ("responses", "chat", "messages"):
            raise ValueError(f"Unsupported wire_api: {api}; choose --api explicitly")
        payload = {"model": connection["model"], "stream": args.stream}
        if api == "responses":
            endpoint = "responses"
            payload.update(input=prompt, max_output_tokens=args.max_tokens, store=False)
            if args.system:
                payload["instructions"] = args.system
            if args.effort:
                payload["reasoning"] = {"effort": args.effort}
        else:
            endpoint = "chat/completions" if api == "chat" else "messages"
            payload["messages"] = [{"role": "user", "content": prompt}]
            payload["max_completion_tokens" if api == "chat" else "max_tokens"] = args.max_tokens
            if args.system:
                if api == "chat":
                    payload["messages"].insert(0, {"role": "system", "content": args.system})
                else:
                    payload["system"] = args.system
            if args.effort:
                if api != "chat":
                    raise ValueError("For Messages reasoning, supply native fields with --set or request --json")
                payload["reasoning_effort"] = args.effort
        if api == "messages":
            headers.setdefault("anthropic-version", "2023-06-01")
        method = "POST"
        endpoint = args.endpoint or endpoint
    else:
        endpoint = args.endpoint
        method = args.method
        payload = load_json(args.json) if args.json else None
        if args.body:
            body = sys.stdin.buffer.read() if args.body == "-" else Path(args.body).read_bytes()
            headers.setdefault("content-type", "application/octet-stream")
        elif args.form or args.file:
            body, headers["content-type"] = multipart(args.form, args.file)
        if args.stream and isinstance(payload, dict):
            payload["stream"] = True
    if args.set:
        if body is not None:
            raise ValueError("--set requires a JSON body")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise ValueError("--set requires a JSON object")
        for entry in args.set:
            assign(payload, entry)
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers.setdefault("content-type", "application/json")
    return method, endpoint, headers, body


def extract_text(payload):
    if "output" in payload:
        return "".join(c.get("text", "") for item in payload["output"] for c in item.get("content", []) if c.get("type") == "output_text")
    if "choices" in payload:
        return "".join(c.get("message", {}).get("content") or "" for c in payload["choices"])
    if "content" in payload:
        return "".join(c.get("text", "") for c in payload["content"] if c.get("type") == "text")
    raise ValueError("No supported text envelope; omit --text for native JSON")


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    for flag in ("codex-home", "config", "auth", "profile", "provider"):
        common.add_argument("--" + flag)
    common.add_argument("--base-url", help="Gateway base URL; overrides ASKLLM_BASE_URL and skips Codex config")
    common.add_argument("--wire-api", choices=["responses", "chat", "messages"],
                        help="Default protocol for --base-url / ASKLLM_BASE_URL (default: responses)")
    common.add_argument("-c", "--config-override", action="append", default=[], metavar="KEY=VALUE")
    common.add_argument("--timeout", type=float, default=300, help="Socket idle timeout, seconds")
    common.add_argument("--header", action="append", default=[], metavar="NAME:VALUE")
    common.add_argument("--query", action="append", default=[], metavar="KEY=VALUE")
    common.add_argument("--output", help="Write native response bytes to file")
    common.add_argument("--text", action="store_true", help="Extract non-streaming assistant text")
    common.add_argument("--stream", action="store_true", help="Send stream=true for JSON; copy raw SSE")
    common.add_argument("--set", action="append", default=[], metavar="KEY=JSON", help="Set body field; dotted keys supported")
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("info", parents=[common], help="Show selected configuration without secrets")
    models = sub.add_parser("models", parents=[common], help="Query gateway model catalog")
    models.add_argument("--endpoint")
    ask = sub.add_parser("ask", parents=[common], help="One model turn")
    ask.add_argument("--model", required=True, help="Explicit model ID; not inherited from config")
    ask.add_argument("prompt", nargs="?")
    ask.add_argument("--prompt-file", help="UTF-8 prompt file, or - for stdin")
    ask.add_argument("--api", choices=["auto", "responses", "chat", "messages"], default="auto")
    ask.add_argument("--endpoint")
    ask.add_argument("--system")
    ask.add_argument("--max-tokens", type=int, default=4096)
    ask.add_argument("--effort", help="Explicit reasoning effort; global Codex effort is not inherited")
    request = sub.add_parser("request", parents=[common], help="Native gateway endpoint, JSON/multipart/binary")
    request.add_argument("endpoint", help="Relative to base_url; /path uses same host's root")
    request.add_argument("--method", default="POST", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    source = request.add_mutually_exclusive_group()
    source.add_argument("--json", help="Native JSON file, or - for stdin")
    source.add_argument("--body", help="Raw body file, or - for stdin")
    request.add_argument("--form", action="append", default=[], metavar="NAME=VALUE")
    request.add_argument("--file", action="append", default=[], metavar="FIELD=PATH")
    return root


def main():
    for output in (sys.stdout, sys.stderr):
        if hasattr(output, "reconfigure"):
            output.reconfigure(encoding="utf-8")
    args = parser().parse_args()
    secrets = []
    try:
        connection = resolve(args)
        secrets.extend(connection["headers"].values())
        secrets.extend(str(v) for v in connection["query"].values())
        if args.command == "info":
            visible = {k: v for k, v in connection.items() if k not in ("headers", "query", "base_url")}
            base = urllib.parse.urlsplit(connection["base_url"])
            visible["base_url"] = urllib.parse.urlunsplit((base.scheme, base.netloc, base.path, "", ""))
            print(json.dumps(visible, ensure_ascii=False, indent=2))
            return 0
        if args.text and (args.stream or args.output):
            raise ValueError("--text is for non-streaming stdout; use native output for --stream/--output")
        if args.command == "request" and (args.json or args.body) and (args.form or args.file):
            raise ValueError("Choose JSON, raw body, or multipart")
        method, endpoint, headers, body = prepare(args, connection)
        secrets.extend(headers.values())
        for value in headers.values():
            if value.lower().startswith("bearer "):
                secrets.append(value[7:])
        url = endpoint_url(connection, endpoint, args.query)
        secrets.extend(v for _, v in urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        opener = urllib.request.build_opener(NoRedirect())
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        with opener.open(req, timeout=args.timeout) as response:
            if args.text:
                payload = json.load(response)
                if payload.get("error") or payload.get("status") in ("failed", "incomplete"):
                    raise ValueError(json.dumps(payload, ensure_ascii=False)[:4000])
                text = extract_text(payload)
                if not text:
                    raise ValueError("Empty assistant text; inspect native JSON for tools/refusal/token budget")
                print(text)
            else:
                target = open(args.output, "wb") if args.output else sys.stdout.buffer
                try:
                    while chunk := response.read1(65536):
                        target.write(chunk)
                        target.flush()
                finally:
                    if args.output:
                        target.close()
        return 0
    except (ValueError, OSError, KeyError, TypeError, urllib.error.URLError) as error:
        if isinstance(error, urllib.error.HTTPError):
            message = f"HTTP {error.code}: " + error.read(8192).decode("utf-8", errors="replace")
        else:
            message = str(error)
        for secret in sorted(set(secrets), key=len, reverse=True):
            if secret:
                message = message.replace(secret, "<redacted>")
        print("AskLLM: " + message[:4000], file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
