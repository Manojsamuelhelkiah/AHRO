"""Validate every deliverable and render representative PDF pages for visual review."""
import json
from pathlib import Path
import re

import pymupdf as fitz
from PIL import Image

from assurance_content import GROUPS, METRICS
from build_assurance_pack import FILES, validate_sources

ROOT = Path(__file__).resolve().parents[2]
PROOF = ROOT / ".agents" / "outputs"
PROOF.mkdir(parents=True, exist_ok=True)
validate_sources()
controls = [row for _, _, rows in GROUPS for row in rows]
data = json.loads((ROOT / "deliverables" / FILES["json"]).read_text())
assert len(controls) == 50
assert sum(len(group["controls"]) for group in data["groups"]) == len(controls)
assert len(data["metrics"]) == len(METRICS) == 12
html = (ROOT / "deliverables" / FILES["html"]).read_text()
assert 'name="viewport"' in html and "<script" not in html
for row in controls:
    assert row.id in html

for kind in ("business", "technical", "inventory"):
    pdf = ROOT / "deliverables" / FILES[kind]
    with fitz.open(pdf) as document:
        text = "\n".join(page.get_text() for page in document)
        if kind in ("business", "technical"):
            expected = 8 if kind == "business" else 2
            assert document.page_count == expected, f"{kind}: expected {expected}, found {document.page_count}"
        else:
            for row in controls:
                assert row.id in text, f"Missing control {row.id}"
            for id, *_ in METRICS:
                assert id in text, f"Missing metric {id}"
            for term in ("MAP-05", "DEP-06", "Nearby test pointers", "No live metric values"):
                assert term in text, f"Missing inventory qualification: {term}"
        for term in ("roadmap", "harness", "privacy", "evidence"):
            assert term in text.lower(), f"Missing {kind} topic: {term}"
        for number, page in enumerate(document, 1):
            assert len(page.get_text().split()) > 35, f"Unexpected near-empty page: {kind}/{number}"
            for block in page.get_text("blocks"):
                x0, y0, x1, y1 = block[:4]
                assert x0 >= 35 and x1 <= page.rect.width - 35, f"Horizontal overflow: {kind}/{number}"
                assert y0 >= 25 and y1 <= page.rect.height - 12, f"Vertical overflow: {kind}/{number}"
        selected = {
            "business": [0, 2, 3, 4, 6, 7],
            "technical": [0, 1],
            "inventory": [0, 1, document.page_count // 2, document.page_count - 1],
        }[kind]
        images = []
        for index in selected:
            pix = document[index].get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
            images.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
        columns = 2 if kind != "business" else 3
        width, height = images[0].size
        rows = (len(images) + columns - 1) // columns
        sheet = Image.new("RGB", (width * columns, height * rows), "#DDE3EB")
        for index, image in enumerate(images):
            sheet.paste(image, ((index % columns) * width, (index // columns) * height))
        sheet.save(PROOF / f"assurance-{kind}-proof.jpg", quality=90)
        print(f"{kind}: {document.page_count} pages, {len(text.split())} words; layout/content checks passed")
print("50 controls and 12 metric definitions reconcile across register, JSON and HTML.")
