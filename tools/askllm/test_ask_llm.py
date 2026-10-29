"""Isolated CLI integration checks; no live gateway calls or real credentials."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SCRIPT = Path(__file__).with_name("ask_llm.py")


class Server(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.calls.append((self.path, dict(self.headers), body))
        if self.path.endswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "https://example.invalid/credential-leak")
            self.end_headers()
            return
        if self.path.endswith("/fail"):
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'{"error":"fake-test-key"}')
            return
        self.send_response(200)
        if self.path.endswith("/sse"):
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: [DONE]\n\n')
            return
        if self.path.endswith("/audio"):
            self.end_headers()
            self.wfile.write(b"\x00\xffaudio\x80")
            return
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        payload = {"output": [{"content": [{"type": "output_text", "text": "OK"}]}]}
        if self.path.endswith("/models"):
            payload = {"data": [{"id": "test-model"}]}
        self.wfile.write(json.dumps(payload).encode())


class CliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="askllm-test-")
        cls.home = Path(cls.temp.name)
        cls.server = Server(("127.0.0.1", 0), Handler)
        cls.server.calls = []
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/v1"
        (cls.home / "config.toml").write_text(
            f'model_provider="gateway"\nmodel="test-model"\nmodel_reasoning_effort="xhigh"\n'
            f'[model_providers.gateway]\nbase_url="{cls.base}"\nrequires_openai_auth=true\n'
            '[profiles.sample]\nmodel="profile-model"\n', encoding="utf-8")
        (cls.home / "auth.json").write_text('{"OPENAI_API_KEY":"fake-test-key"}', encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def run_cli(self, *args, input=None, extra_env=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith("ASKLLM_")}
        env.update(CODEX_HOME=str(self.home), NO_PROXY="127.0.0.1", **(extra_env or {}))
        return subprocess.run([sys.executable, str(SCRIPT), *args], input=input,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=10)

    def test_env_gateway_skips_codex_config(self):
        result = self.run_cli("ask", "hi", "--model", "env-model", "--text", "--codex-home", "missing-dir",
                              extra_env={"ASKLLM_BASE_URL": self.base, "ASKLLM_API_KEY": "env-key",
                                         "ASKLLM_WIRE_API": "chat"})
        self.assertEqual(result.returncode, 0, result.stderr)
        path, headers, _ = self.server.calls[-1]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(headers["Authorization"], "Bearer env-key")

    def test_info_profile_override_and_redaction(self):
        result = self.run_cli("info", "--profile", "sample", "-c", 'model="override-model"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["model"], "override-model")
        self.assertNotIn(b"fake-test-key", result.stdout)

    def test_models(self):
        result = self.run_cli("models")
        self.assertEqual(json.loads(result.stdout), {"data": [{"id": "test-model"}]})
        self.assertEqual(self.server.calls[-1][1]["Authorization"], "Bearer fake-test-key")

    def test_ask_formats(self):
        for api, endpoint, budget in [("responses", "responses", "max_output_tokens"),
                                      ("chat", "chat/completions", "max_completion_tokens"),
                                      ("messages", "messages", "max_tokens")]:
            with self.subTest(api=api):
                result = self.run_cli("ask", "你好", "--model", "selected-model", "--profile", "sample",
                                      "-c", 'model="override-model"', "--api", api, "--text", "--max-tokens", "1024")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.decode().strip(), "OK")
                path, _, body = self.server.calls[-1]
                self.assertEqual(path, "/v1/" + endpoint)
                payload = json.loads(body)
                self.assertEqual(payload["model"], "selected-model")
                self.assertEqual(payload[budget], 1024)
                self.assertNotIn("reasoning", payload)
                self.assertNotIn("reasoning_effort", payload)

    def test_ask_requires_model_before_request(self):
        before = len(self.server.calls)
        result = self.run_cli("ask", "你好")
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"--model", result.stderr)
        self.assertEqual(len(self.server.calls), before)

    def test_native_stdin_root_path_and_fields(self):
        result = self.run_cli("request", "/v1beta/custom", "--json", "-", "--set",
                              "generationConfig.temperature=0.2", input=b'{"contents":[]}')
        self.assertEqual(result.returncode, 0, result.stderr)
        path, _, body = self.server.calls[-1]
        self.assertEqual(path, "/v1beta/custom")
        self.assertEqual(json.loads(body), {"contents": [], "generationConfig": {"temperature": 0.2}})

    def test_upload_stream_and_binary(self):
        upload = self.home / "sample.wav"
        upload.write_bytes(b"audio-data")
        result = self.run_cli("request", "upload", "--form", "model=test", "--file", f"file={upload}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"audio-data", self.server.calls[-1][2])
        result = self.run_cli("request", "sse", "--stream", "--json", "-", input=b"{}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"data: [DONE]", result.stdout)
        self.assertEqual(json.loads(self.server.calls[-1][2]), {"stream": True})
        output = self.home / "output.bin"
        result = self.run_cli("request", "audio", "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_bytes(), b"\x00\xffaudio\x80")

    def test_failure_and_redirect(self):
        result = self.run_cli("request", "fail")
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"401", result.stderr)
        self.assertNotIn(b"fake-test-key", result.stderr)
        result = self.run_cli("request", "redirect")
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"redirect refused", result.stderr)
        result = self.run_cli("request", "https://example.invalid/test")
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"not an absolute URL", result.stderr)


if __name__ == "__main__":
    unittest.main()
