import asyncio
import base64
from pathlib import Path

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


def test_parses_fixed_html_snapshot_through_document_parser_contract() -> None:
    fixture = (
        Path(__file__).parent / "fixtures" / "p0-11-public-source.html"
    ).read_bytes()

    async def request_parse() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/v1/document/parse",
                json={
                    "contractType": "local-service-request",
                    "contractVersion": "1.0",
                    "requestId": "request-p0-11-html-fixture",
                    "port": "DOCUMENT_PARSER",
                    "input": {
                        "document": {
                            "mediaType": "text/html",
                            "dataBase64": base64.b64encode(fixture).decode("ascii"),
                        }
                    },
                },
            )

    response = asyncio.run(request_parse())

    assert response.status_code == 200
    assert response.json() == {
        "contractType": "local-service-result",
        "contractVersion": "1.0",
        "requestId": "request-p0-11-html-fixture",
        "port": "DOCUMENT_PARSER",
        "ok": True,
        "output": {
            "parser": "choicemind-html-parser-1.0",
            "text": (
                "ChoiceMind P0 固定来源 ChoiceMind 固定公开资料 "
                "候选 A 提供 32 GB 内存，公开标价为 7699 元。"
            ),
            "pageCount": 1,
        },
    }
