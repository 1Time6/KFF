# Rasterize every page of the tutorial PDF so layout can be inspected visually.
import os
import pymupdf

P = r"C:\Users\17731\Desktop\KFF-交付-0.1.53\KFF新电脑安装与使用教程.pdf"
OUT = r"C:\Users\17731\Desktop\KFF\.kff\pdf-preview"
os.makedirs(OUT, exist_ok=True)
for old in os.listdir(OUT):
    os.remove(os.path.join(OUT, old))

doc = pymupdf.open(P)
print("pages =", doc.page_count)
for i, page in enumerate(doc, start=1):
    pix = page.get_pixmap(dpi=110)
    target = os.path.join(OUT, "page%02d.png" % i)
    pix.save(target)
    print("page", i, pix.width, "x", pix.height, os.path.getsize(target), "bytes")

# Detect suspicious layout: text that ran off the printable area.
print("--- text outside margins? ---")
for i, page in enumerate(doc, start=1):
    w, h = page.rect.width, page.rect.height
    bad = []
    for b in page.get_text("blocks"):
        x0, y0, x1, y1 = b[:4]
        if x0 < 50 or x1 > w - 50 or y0 < 30 or y1 > h - 40:
            bad.append((round(x0), round(y0), round(x1), round(y1), str(b[4])[:40]))
    print("page", i, "overflow blocks:", len(bad))
    for row in bad[:6]:
        print("     ", row)
