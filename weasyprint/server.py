"""Minimal HTML → PDF sidecar built on WeasyPrint + Flask.

The Go orchestrator (proxcenter-backend) calls this service through
`internal/reports/renderer/client.go`. Two endpoints are required:

    POST /render
        Body: text/html
        Returns: application/pdf

    GET /health
        Returns: 200 OK with a tiny JSON body so docker-compose can probe it.

Errors come back as JSON with a non-2xx status — the Go client surfaces the
body as the error message.
"""

import logging

from flask import Flask, Response, jsonify, request
from weasyprint import HTML

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("weasyprint-sidecar")

app = Flask(__name__)


@app.get("/health")
def health() -> Response:
    return jsonify(status="ok")


@app.post("/render")
def render() -> Response:
    html = request.get_data(as_text=True)
    if not html:
        return jsonify(error="empty html body"), 400

    try:
        # base_url=None disables remote resource fetching by default; the Go
        # caller embeds CSS / images inline in the report templates.
        pdf_bytes = HTML(string=html).write_pdf()
    except Exception as exc:  # noqa: BLE001 — surface the rendering failure verbatim.
        log.exception("PDF rendering failed")
        return jsonify(error=str(exc)), 500

    return Response(pdf_bytes, mimetype="application/pdf")


if __name__ == "__main__":
    # Local dev convenience — production runs through gunicorn (see CMD in Dockerfile).
    app.run(host="0.0.0.0", port=5000)
