# Verify the generated tutorial PDF: pages, embedded fonts, and required content.
import os
from pypdf import PdfReader

P = r"C:\Users\17731\Desktop\KFF-交付-0.1.53\KFF新电脑安装与使用教程.pdf"
print("exists:", os.path.exists(P), "bytes:", os.path.getsize(P) if os.path.exists(P) else 0)

r = PdfReader(P)
print("pages =", len(r.pages))

fonts = set()
for pg in r.pages:
    res = pg.get("/Resources")
    if res and "/Font" in res:
        for _, v in res["/Font"].items():
            o = v.get_object()
            fonts.add((str(o.get("/BaseFont")), str(o.get("/Subtype"))))
print("embedded fonts:")
for f in sorted(fonts):
    print("   ", f)

text = "".join((pg.extract_text() or "") for pg in r.pages)
print("total chars =", len(text))

probes = [
    "controller.cmd setup",
    "controller.cmd stop",
    "empty_workspace",
    "operator@kff.local",
    "kff-controller-0.1.53-win32-x64-2c82a35912bf.zip",
    "341666529005d881e3cab087710d0ca7486f9ee3639c1e32d1607333ca12e9e8",
    "客户收件箱",
    "五条硬规则",
    "验收状态",
    "端口",
    "硬规则",
    "status",
]
print("--- content probes ---")
for p in probes:
    print(("OK  " if p in text else "MISS"), p)

print("--- page 1 text (first 400 chars) ---")
print((r.pages[0].extract_text() or "")[:400])
