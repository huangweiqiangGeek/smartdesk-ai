from hashlib import sha256
from typing import Literal


class FakeProvider:
    """仅测试用，无 HTTP 推理端点；真实适配器和 Token 计数在 T12 实现。"""

    def __init__(self, outcome: Literal["success", "timeout", "unavailable"] = "success") -> None:
        self.outcome = outcome

    def embed(self, text: str) -> list[float]:
        if self.outcome == "timeout":
            raise TimeoutError("可控超时")
        if self.outcome == "unavailable":
            raise ConnectionError("可控提供方故障")
        digest = sha256(text.encode("utf-8")).digest()
        return [(value + 1) / 256 for value in digest[:8]]

    def reply(self) -> str:
        self.embed("probe")
        return "[FAKE] 仅用于配置与故障测试，未调用真实模型。"
