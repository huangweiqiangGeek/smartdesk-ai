import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.fake_provider import FakeProvider
from app.main import create_app


def test_disabled_does_not_claim_model_ready() -> None:
    with TestClient(create_app(Settings(mode="disabled"))) as client:
        assert client.get("/health/live").status_code == 200
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json()["realModelVerified"] is False
        assert client.post("/infer", json={}).status_code == 404


def test_real_provider_cannot_start_without_contract() -> None:
    with pytest.raises(ValidationError):
        Settings(mode="openai_compatible", model_id="only-one-field")


@pytest.mark.parametrize("budget", [0, 8001])
def test_invalid_input_budget(budget: int) -> None:
    with pytest.raises(ValidationError):
        Settings(input_token_budget=budget)


def test_fake_dimensions_and_label_are_explicit() -> None:
    config = Settings(mode="fake")
    assert config.embedding_dimensions == 8
    assert config.model_id == "fake-chat-v1"
    with TestClient(create_app(config)) as client:
        assert client.get("/health/ready").json() == {
            "service": "ai-service",
            "status": "fake",
            "mode": "fake",
            "realModelVerified": False,
        }
    with pytest.raises(ValidationError):
        Settings(mode="fake", embedding_dimensions=1536)


def test_fake_is_deterministic_and_can_fail() -> None:
    provider = FakeProvider()
    assert provider.embed("同一输入") == provider.embed("同一输入")
    assert len(provider.embed("文本")) == 8
    with pytest.raises(TimeoutError):
        FakeProvider("timeout").reply()
    with pytest.raises(ConnectionError):
        FakeProvider("unavailable").embed("文本")


def test_context_capacity_cannot_be_smaller_than_budget() -> None:
    with pytest.raises(ValidationError):
        Settings(model_context_tokens=9999)
    with pytest.raises(ValidationError):
        Settings(embedding_context_tokens=7999)


def test_configured_provider_stays_unverified_and_hides_key() -> None:
    config = Settings(
        mode="openai_compatible",
        base_url="https://example.invalid/v1",
        api_key="test-only-secret",
        model_id="configured-chat",
        embedding_model_id="configured-embedding",
        embedding_dimensions=16,
        model_context_tokens=10000,
        embedding_context_tokens=8000,
    )
    with TestClient(create_app(config)) as client:
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json()["status"] == "configured_unverified"
        assert "test-only-secret" not in response.text
