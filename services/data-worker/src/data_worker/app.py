from fastapi import FastAPI

app = FastAPI(title="ChoiceMind Data Worker")


@app.get("/health/live")
def health_live() -> dict[str, str]:
    return {
        "service": "data-worker",
        "status": "healthy",
    }
