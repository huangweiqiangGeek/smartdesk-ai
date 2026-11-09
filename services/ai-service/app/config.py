from pathlib import Path
from typing import Literal, Self

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="AI_",
        env_file=Path(__file__).resolve().parents[3] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    mode: Literal["disabled", "fake", "openai_compatible"] = "disabled"
    base_url: AnyHttpUrl | None = None
    api_key: SecretStr | None = None
    model_id: str | None = None
    embedding_model_id: str | None = None
    embedding_dimensions: int | None = Field(default=None, ge=1, le=16000)
    model_context_tokens: int | None = Field(default=None, ge=1)
    embedding_context_tokens: int | None = Field(default=None, ge=1)
    input_token_budget: int = Field(default=8000, ge=1, le=8000)
    output_token_budget: int = Field(default=2000, ge=1, le=2000)
    embedding_token_budget: int = Field(default=8000, ge=1, le=8000)
    call_timeout_seconds: int = Field(default=30, ge=1, le=30)

    @field_validator(
        "base_url",
        "api_key",
        "model_id",
        "embedding_model_id",
        "embedding_dimensions",
        "model_context_tokens",
        "embedding_context_tokens",
        mode="before",
    )
    @classmethod
    def empty_to_none(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value

    @model_validator(mode="after")
    def provider_contract(self) -> Self:
        if self.mode == "openai_compatible" and not all(
            (
                self.base_url,
                self.api_key and self.api_key.get_secret_value(),
                self.model_id,
                self.embedding_model_id,
                self.embedding_dimensions,
                self.model_context_tokens,
                self.embedding_context_tokens,
            )
        ):
            raise ValueError("真实提供方必须配置 URL、Key、两个 modelId、维度与上下文上限")
        if self.model_context_tokens is not None and (
            self.input_token_budget + self.output_token_budget > self.model_context_tokens
        ):
            raise ValueError("输入与输出预算之和超过模型上下文上限")
        if self.embedding_context_tokens is not None and (
            self.embedding_token_budget > self.embedding_context_tokens
        ):
            raise ValueError("Embedding 预算超过提供方上下文上限")
        if self.mode == "fake":
            if self.model_id not in (None, "fake-chat-v1"):
                raise ValueError("fake 模式不能使用真实 modelId")
            if self.embedding_model_id not in (None, "fake-embedding-v1"):
                raise ValueError("fake 模式不能使用真实 Embedding modelId")
            if self.embedding_dimensions not in (None, 8):
                raise ValueError("fake Embedding 固定为 8 维")
            self.model_id = "fake-chat-v1"
            self.embedding_model_id = "fake-embedding-v1"
            self.embedding_dimensions = 8
        return self
