import base64

from data_worker.app import DocumentParserRequest, parse_document


def parse(html: str, extract_links: bool = True):
    request = DocumentParserRequest.model_validate({
        "contractType": "local-service-request", "contractVersion": "1.0",
        "requestId": "synthetic-links", "port": "DOCUMENT_PARSER",
        "input": {"extractLinks": extract_links, "document": {
            "mediaType": "text/html",
            "dataBase64": base64.b64encode(html.encode("utf-8")).decode("ascii"),
        }},
    })
    return parse_document(request)["output"]


def test_extracts_links_without_fetching_or_authorizing_targets():
    output = parse('<a href="/product?a=1&amp;b=2">产品 <b>规格</b></a>'
                   '<a href="?page=2" rel="NEXT">下一页</a>'
                   '<template><a href="/hidden">隐藏</a></template>')
    assert output["links"] == [
        {"href": "/product?a=1&b=2", "text": "产品 规格", "next": False},
        {"href": "?page=2", "text": "下一页", "next": True},
    ]


def test_link_metadata_is_bounded_and_legacy_output_is_unchanged():
    assert "links" not in parse('<a href="/product">产品</a>', False)
    output = parse('<a href="' + 'x' * 2049 + '">过长地址</a>'
                   + '<a href="/product">' + '中' * 300 + '</a>'
                   + '<a href="/other">其他</a>' * 220)
    assert len(output["links"]) == 200
    assert output["links"][0] == {"href": "/product", "text": "中" * 200, "next": False}
