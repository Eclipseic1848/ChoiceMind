import base64
import binascii
from html.parser import HTMLParser
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="ChoiceMind Data Worker")


class DocumentInput(BaseModel):
    media_type: Literal["text/html"] = Field(alias="mediaType")
    data_base64: str = Field(alias="dataBase64")


class ParserInput(BaseModel):
    document: DocumentInput


class DocumentParserRequest(BaseModel):
    contract_type: Literal["local-service-request"] = Field(alias="contractType")
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    request_id: str = Field(alias="requestId")
    port: Literal["DOCUMENT_PARSER"]
    input: ParserInput


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.ignored_depth = 0

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        del attrs
        if tag in {"script", "style"}:
            self.ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.ignored_depth > 0:
            self.ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        text = " ".join(data.split())
        if self.ignored_depth == 0 and text:
            self.parts.append(text)


@app.get("/health/live")
def health_live() -> dict[str, str]:
    return {
        "service": "data-worker",
        "status": "healthy",
    }


@app.post("/v1/document/parse")
def parse_document(request: DocumentParserRequest) -> dict[str, object]:
    try:
        html = base64.b64decode(
            request.input.document.data_base64, validate=True
        ).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return parser_failure(request.request_id, "输入不是有效的 UTF-8 HTML")

    parser = TextExtractor()
    parser.feed(html)
    return {
        "contractType": "local-service-result",
        "contractVersion": "1.0",
        "requestId": request.request_id,
        "port": "DOCUMENT_PARSER",
        "ok": True,
        "output": {
            "parser": "choicemind-html-parser-1.0",
            "text": " ".join(parser.parts),
            "pageCount": 1,
        },
    }


def parser_failure(request_id: str, message: str) -> dict[str, object]:
    return {
        "contractType": "local-service-result",
        "contractVersion": "1.0",
        "requestId": request_id,
        "port": "DOCUMENT_PARSER",
        "ok": False,
        "error": {
            "code": "INVALID_RESPONSE",
            "category": "PROTOCOL",
            "message": message,
            "retryable": False,
        },
    }
