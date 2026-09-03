"""Render the ASCII wordmark in the Robinhood Chain palette to assets/banner.png (lime fading to yellow on black)."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

LINES = [
    "██████╗  ██████╗ ██████╗ ██╗  ██╗██╗███╗   ██╗",
    "██╔══██╗██╔═══██╗██╔══██╗██║ ██╔╝██║████╗  ██║",
    "██████╔╝██║   ██║██║  ██║█████╔╝ ██║██╔██╗ ██║",
    "██╔══██╗██║   ██║██║  ██║██╔═██╗ ██║██║╚██╗██║",
    "██████╔╝╚██████╔╝██████╔╝██║  ██╗██║██║ ╚████║",
    "╚═════╝  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝",
]
COLORS = ["#CCFF00", "#D6FA00", "#E0F600", "#EBF100", "#F5EC00", "#FFE700"]
OUT = Path(__file__).resolve().parent / "banner.png"
FONT = "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Instrument+Serif&display=swap'>"

rows = "".join(f"<div style='color:{c}'>{l}</div>" for l, c in zip(LINES, COLORS))
HTML = f"""<html><head>{FONT}<style>
html,body{{margin:0;background:#000}}
.wrap{{width:1600px;height:420px;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;
  background-image:radial-gradient(circle at 50% 120%, rgba(204,255,0,.18), transparent 55%), radial-gradient(#1a1a17 1px, transparent 1px);background-size:100% 100%, 22px 22px}}
pre{{margin:0;font:500 26px/1.05 'JetBrains Mono',monospace;letter-spacing:0;text-shadow:0 0 24px rgba(204,255,0,.25)}}
.tag{{font:400 26px 'Instrument Serif',serif;color:#D9D9D9;letter-spacing:-.3px}}
.tag b{{color:#FFE700;font-weight:400}}
</style></head><body><div class='wrap'><pre>{rows}</pre><div class='tag'>the sniper terminal for pons v2 on <b>Robinhood Chain</b> · local · open · non-custodial</div></div></body></html>"""


async def main() -> None:
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1600, "height": 420}, device_scale_factor=1)
        await pg.set_content(HTML, wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=str(OUT), clip={"x": 0, "y": 0, "width": 1600, "height": 420})
        await b.close()
        print("rendered", OUT)


asyncio.run(main())
