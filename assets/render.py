"""Render the brand SVGs to PNG with headless Chromium. Inlines each SVG so web fonts apply."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).parent
JOBS = [("icon.svg", "icon.png", 512, 512), ("token.svg", "token.png", 1000, 1000), ("logo.svg", "logo.png", 1280, 320), ("hero.svg", "hero.png", 1600, 520)]
FONT = "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap'>"


def page_html(svg: str, w: int, h: int) -> str:
    style = "html,body{margin:0;background:#000} svg{display:block;width:%dpx;height:%dpx}" % (w, h)
    return "<html><head>%s<style>%s</style></head><body>%s</body></html>" % (FONT, style, svg)


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        for src, out, w, h in JOBS:
            page = await browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
            await page.set_content(page_html((HERE / src).read_text(encoding="utf-8"), w, h), wait_until="networkidle")
            await page.wait_for_timeout(1000)
            await page.screenshot(path=str(HERE / out), clip={"x": 0, "y": 0, "width": w, "height": h})
            print("rendered", out)
        await browser.close()


asyncio.run(main())
