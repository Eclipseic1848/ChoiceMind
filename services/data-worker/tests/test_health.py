import asyncio

import httpx
from data_worker.app import app


def test_reports_data_worker_as_healthy() -> None:
    async def request_health() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.get("/health/live")

    response = asyncio.run(request_health())

    assert response.status_code == 200
    assert response.json() == {
        "service": "data-worker",
        "status": "healthy",
    }
