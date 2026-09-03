"""Drive the board like a user: wait for rows, open the drawer, pause, edit a rule, run the cat, take screenshots.
Run with the board up on 127.0.0.1:4663. Writes assets/board.png and assets/board-drawer.png."""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:4663"
OUT = Path(__file__).resolve().parent.parent / "assets"


async def main() -> None:
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_selector("#feed tr", timeout=180_000)
        await page.wait_for_timeout(15_000)  # let a few launches land
        rows = await page.locator("#feed tr").count()
        print("rows", rows)
        assert rows >= 1
        # KPI numbers render
        seen = await page.locator("#s-seen").inner_text()
        print("seen", seen)
        # the board starts as a feed; start demo / stop demo round-trip through POST
        assert "feed only" in (await page.locator("#mode-text").inner_text()), "board should start in feed-only mode"
        await page.click("#run")
        await page.wait_for_timeout(700)
        assert "demo trading" in (await page.locator("#mode-text").inner_text()), "start demo did not register"
        await page.click("#run")
        await page.wait_for_timeout(700)
        assert "feed only" in (await page.locator("#mode-text").inner_text()), "stop demo did not register"
        # the pulse arrives and the notice stays hidden while the engine answers
        await page.wait_for_timeout(11_000)
        assert await page.evaluate("Date.now() - state.lastTick < 15000"), "no tick from the engine"
        assert await page.evaluate("document.getElementById('notice').hidden"), "notice shown while the engine is healthy"
        # rule stepper edits the running engine
        before = await page.locator('[data-rule="minScore"]').input_value()
        await page.click('[data-step="minScore"][data-d="1"]')
        await page.wait_for_timeout(700)
        after = await page.locator('[data-rule="minScore"]').input_value()
        print("minScore", before, "->", after)
        assert int(after) == int(before) + 5
        await page.click('[data-step="minScore"][data-d="-1"]')
        await page.wait_for_timeout(500)
        # filter buttons
        await page.click('[data-filter="fire"]')
        await page.wait_for_timeout(300)
        await page.click('[data-filter="all"]')
        # clean screenshot first
        await page.screenshot(path=str(OUT / "board.png"))
        # drawer opens on row click
        await page.locator("#feed tr").first.click()
        await page.wait_for_timeout(700)
        assert "open" in (await page.get_attribute("#drawer", "class")), "drawer did not open"
        title = await page.locator("#drawer h3").inner_text()
        print("drawer", title)
        links = await page.locator("#drawer .links a").all_inner_texts()
        print("drawer links", links)
        assert "axiom" in links and "fomo" in links and "dexscreener" not in links
        await page.screenshot(path=str(OUT / "board-drawer.png"))
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(400)
        assert "open" not in (await page.get_attribute("#drawer", "class"))
        # the cat
        for _ in range(5):
            await page.click("#mark")
        await page.wait_for_timeout(300)
        assert "run" in (await page.get_attribute("#cat", "class")), "cat did not run"
        # keyboard: / focuses search
        await page.keyboard.press("/")
        assert await page.evaluate("document.activeElement.id") == "search"
        await page.keyboard.type("zzzz-no-such-token")
        await page.wait_for_timeout(300)
        hidden = await page.locator("#feed tr.hidden").count()
        print("hidden by search", hidden, "of", rows)
        assert hidden >= 1
        # state endpoint
        st = json.loads(await page.evaluate("fetch('/api/state').then(r => r.text())"))
        print("api/state keys", sorted(st.keys()))
        assert "positions" in st and "rules" in st
        print("page errors", errors)
        assert not errors, errors
        await b.close()
        print("BOARD OK")


asyncio.run(main())
