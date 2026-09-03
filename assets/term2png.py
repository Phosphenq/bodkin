"""Render a captured ANSI terminal transcript as a PNG in the brand's terminal frame.

    python assets/term2png.py assets/hunt.txt assets/hunt.png [max_lines]
"""
import asyncio
import html
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ANSI = re.compile(r"\x1b\[([0-9;]*)m")
FONT = "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=JetBrains+Mono&family=Instrument+Serif&display=swap'>"


def ansi_to_html(text: str) -> str:
    out, fg, bg, dim = [], None, None, False
    pos = 0

    def open_span() -> str:
        style = []
        if fg:
            style.append(f"color:{fg}")
        if bg:
            style.append(f"background:{bg};padding:0 2px;border-radius:3px")
        if dim:
            style.append("opacity:.72")
        return f"<span style='{';'.join(style)}'>" if style else "<span>"

    for m in ANSI.finditer(text):
        out.append(html.escape(text[pos:m.start()]))
        pos = m.end()
        codes = [int(c) for c in m.group(1).split(";") if c != ""] or [0]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == 0:
                fg, bg, dim = None, None, False
                i += 1
            elif c == 2:
                dim = True
                i += 1
            elif c in (38, 48) and i + 4 < len(codes) and codes[i + 1] == 2:
                col = f"rgb({codes[i + 2]},{codes[i + 3]},{codes[i + 4]})"
                if c == 38:
                    fg = col
                else:
                    bg = col
                i += 5
            else:
                i += 1
        out.append("</span>" + open_span())
    out.append(html.escape(text[pos:]))
    return "<span>" + "".join(out) + "</span>"


async def render(body: str, out: Path, width: int) -> None:
    page = f"""<html><head>{FONT}<style>
      html,body{{margin:0;background:#000}}
      .win{{width:{width}px;background:#000;border:1px solid #35322D;border-radius:24px;overflow:hidden}}
      .bar{{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid #35322D;font:400 15px 'Instrument Serif',serif;color:#fff;letter-spacing:-.3px}}
      .bar i{{width:10px;height:10px;border-radius:50%;background:#23231F;display:inline-block}}
      .bar b{{font-weight:400;color:#CCFF00}}
      pre{{margin:0;padding:18px 22px 22px;font:400 13.5px/1.45 'JetBrains Mono',monospace;color:#D9D9D9;white-space:pre-wrap;word-break:break-all}}
    </style></head><body><div class='win'><div class='bar'><i></i><i></i><i></i>&nbsp;<b>bodkin</b> · Robinhood Chain 4663</div><pre>{body}</pre></div></body></html>"""
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": width + 2, "height": 900}, device_scale_factor=2)
        await pg.set_content(page, wait_until="networkidle")
        await pg.wait_for_timeout(800)
        el = await pg.query_selector(".win")
        await el.screenshot(path=str(out))
        await b.close()


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    max_lines = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    lines = src.read_text(encoding="utf-8", errors="replace").rstrip().splitlines()
    asyncio.run(render(ansi_to_html("\n".join(lines[:max_lines])), out, 1180))
    print("rendered", out, "from", len(lines), "lines")


if __name__ == "__main__":
    main()
