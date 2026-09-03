"""Board screenshots for the README at 2x: the page, and the drawer on the newest launch. Board must be up on 127.0.0.1:4663."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path(__file__).resolve().parent


async def main() -> None:
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        await pg.goto("http://127.0.0.1:4663/", wait_until="networkidle")
        await pg.wait_for_selector("#feed tr", timeout=180_000)
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path=str(OUT / "board.png"), clip={"x": 0, "y": 0, "width": 1440, "height": 900})
        await pg.locator("#feed tr").first.click()
        await pg.wait_for_timeout(900)
        await pg.screenshot(path=str(OUT / "board-drawer.png"), clip={"x": 0, "y": 0, "width": 1440, "height": 900})
        print("rendered board.png and board-drawer.png")
        await b.close()


asyncio.run(main())
