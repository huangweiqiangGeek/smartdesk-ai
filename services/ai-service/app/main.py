from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.config import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings if settings is not None else Settings()
    app = FastAPI(title="SmartDesk AI 内部服务", docs_url=None, redoc_url=None)

    @app.get("/health/live")
    def live() -> dict[str, str]:
        return {"service": "ai-service", "status": "ok"}

    @app.get("/health/ready")
    def ready() -> JSONResponse:
        return JSONResponse(
            status_code=200 if config.mode == "fake" else 503,
            content={
                "service": "ai-service",
                "status": "fake"
                if config.mode == "fake"
                else ("disabled" if config.mode == "disabled" else "configured_unverified"),
                "mode": config.mode,
                "realModelVerified": False,
            },
        )

    return app


app = create_app()
