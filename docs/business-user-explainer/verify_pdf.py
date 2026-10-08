"""Check the PDF text/layout and render a contact sheet for visual review."""
from pathlib import Path
import pymupdf as fitz
from PIL import Image

root = Path(__file__).resolve().parents[2]
pdf = root / "deliverables" / "Agentic_HRO_Business_User_Explainer.pdf"
proof = root / ".agents" / "outputs" / "business-explainer-proof.jpg"
proof.parent.mkdir(parents=True, exist_ok=True)
document = fitz.open(pdf)
assert document.page_count == 6, f"Expected 6 pages; found {document.page_count}"
full_text = "\n".join(page.get_text() for page in document)
for term in [
    "ROADMAP", "CONFIGURATION REQUIRED", "IMPLEMENTED",
    "agent harness", "testing harness", "Business example", "Employee Vault",
    "bias-free", "compliance", "authenticity",
]:
    assert term.lower() in full_text.lower(), f"Missing required content: {term}"
images = []
for n, page in enumerate(document, start=1):
    blocks = page.get_text("blocks")
    for block in blocks:
        x0, y0, x1, y1 = block[:4]
        assert x0 >= 35 and x1 <= page.rect.width - 35, f"Horizontal overflow on page {n}"
        assert y0 >= 25 and y1 <= page.rect.height - 12, f"Vertical overflow on page {n}"
    pixmap = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
    image = Image.frombytes("RGB", [pixmap.width, pixmap.height], pixmap.samples)
    images.append(image)
    print(f"Page {n}: {len(page.get_text().split())} words")
width, height = images[0].size
sheet = Image.new("RGB", (width * 3, height * 2), "#DDE3EB")
for index, image in enumerate(images):
    sheet.paste(image, ((index % 3) * width, (index // 3) * height))
sheet.save(proof, quality=90)
print(f"Verified {document.page_count} pages; contact sheet: {proof.relative_to(root)}")
