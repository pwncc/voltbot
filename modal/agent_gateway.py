import os
import subprocess
import time
from typing import Any

import modal

APP_NAME = "Volty-agent-gateway"
VOLUME_NAME = "Volty-agent-models"

CPU_GATE_MODEL = os.environ.get(
    "CPU_GATE_MODEL", "Qwen/Qwen2.5-0.5B-Instruct"
)
GPU_AGENT_MODEL = os.environ.get(
    "GPU_AGENT_MODEL", "meta-llama/Meta-Llama-3.1-8B-Instruct"
)
GPU_TYPE = os.environ.get("GPU_TYPE", "L40S")
GPU_MIN_CONTAINERS = int(os.environ.get("GPU_MIN_CONTAINERS", "0"))
GPU_MAX_CONTAINERS = int(os.environ.get("GPU_MAX_CONTAINERS", "2"))
GPU_SCALEDOWN_WINDOW = int(os.environ.get("GPU_SCALEDOWN_WINDOW", "300"))
CPU_MIN_CONTAINERS = int(os.environ.get("CPU_MIN_CONTAINERS", "1"))
CPU_SCALEDOWN_WINDOW = int(os.environ.get("CPU_SCALEDOWN_WINDOW", "900"))
API_KEY_SECRET = "Volty-agent-gateway"

volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi[standard]", "openai")
)

gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "fastapi[standard]",
        "openai",
        "vllm>=0.6.0",
        "huggingface_hub[hf_transfer]",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

app = modal.App(APP_NAME)


def require_bearer(headers: dict[str, str]) -> None:
    expected = os.environ.get("AGENT_GATEWAY_API_KEY")
    if not expected:
        return

    auth = headers.get("authorization") or headers.get("Authorization") or ""
    if auth != f"Bearer {expected}":
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="invalid bearer token")


@app.cls(
    image=gpu_image,
    gpu=GPU_TYPE,
    volumes={"/models": volume},
    secrets=[modal.Secret.from_name(API_KEY_SECRET)],
    scaledown_window=GPU_SCALEDOWN_WINDOW,
    min_containers=GPU_MIN_CONTAINERS,
    max_containers=GPU_MAX_CONTAINERS,
)
class GPUAgents:
    @modal.enter()
    def start(self):
        self.proc = subprocess.Popen(
            [
                "python",
                "-m",
                "vllm.entrypoints.openai.api_server",
                "--host",
                "127.0.0.1",
                "--port",
                "8000",
                "--model",
                GPU_AGENT_MODEL,
                "--served-model-name",
                "agent-8b",
                "--download-dir",
                "/models",
                "--max-model-len",
                os.environ.get("GPU_MAX_MODEL_LEN", "8192"),
            ]
        )

        import httpx

        for _ in range(240):
            try:
                httpx.get("http://127.0.0.1:8000/health", timeout=1)
                return
            except Exception:
                time.sleep(1)

        raise RuntimeError("vLLM GPU server did not become healthy")

    @modal.exit()
    def stop(self):
        self.proc.terminate()

    @modal.method()
    def chat_completions(self, payload: dict[str, Any]) -> dict[str, Any]:
        import httpx

        payload = dict(payload)
        payload["model"] = "agent-8b"
        with httpx.Client(timeout=90) as client:
            resp = client.post(
                "http://127.0.0.1:8000/v1/chat/completions",
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()


@app.cls(
    image=cpu_image,
    secrets=[modal.Secret.from_name(API_KEY_SECRET)],
    scaledown_window=CPU_SCALEDOWN_WINDOW,
    min_containers=CPU_MIN_CONTAINERS,
    max_containers=1,
)
class Gateway:
    @modal.enter()
    def setup(self):
        from openai import OpenAI

        # This CPU gate can point at any cheap OpenAI-compatible CPU endpoint.
        # If unset, /v1/chat/completions forwards to GPU directly.
        self.cpu_client = (
            OpenAI(
                base_url=os.environ["CPU_GATE_BASE_URL"],
                api_key=os.environ.get("CPU_GATE_API_KEY", "not-needed"),
            )
            if os.environ.get("CPU_GATE_BASE_URL")
            else None
        )

    def _should_use_gpu(self, payload: dict[str, Any]) -> bool:
        if self.cpu_client is None:
            return True

        gate_messages = [
            {
                "role": "system",
                "content": (
                    "Decide if this request needs the GPU 8B critic model. "
                    "Return exactly GPU or CPU. Use GPU for nuanced style, realism, "
                    "factuality, or rewrite review. Use CPU only for trivial no-op."
                ),
            },
            {
                "role": "user",
                "content": str(payload.get("messages", ""))[:4000],
            },
        ]
        out = self.cpu_client.chat.completions.create(
            model=CPU_GATE_MODEL,
            messages=gate_messages,
            max_tokens=1,
            temperature=0,
        )
        return (out.choices[0].message.content or "").strip().upper() != "CPU"

    @modal.asgi_app()
    def api(self):
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse

        api = FastAPI()

        @api.get("/health")
        async def health():
            return {"ok": True}

        @api.post("/v1/chat/completions")
        async def chat_completions(request: Request):
            require_bearer(dict(request.headers))
            payload = await request.json()

            if not self._should_use_gpu(payload) and self.cpu_client is not None:
                resp = self.cpu_client.chat.completions.create(**payload)
                return JSONResponse(resp.model_dump())

            resp = GPUAgents().chat_completions.remote(payload)
            return JSONResponse(resp)

        return api
