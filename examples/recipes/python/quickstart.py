"""Navigate, read the page text, and take a screenshot, from Python.

    pip install -e clients/python
    python examples/recipes/python/quickstart.py

Uses the same two environment variables as the Node recipes:
BGLS_URL (default http://127.0.0.1:7799/browserglass) and BGLS_ADMIN_TOKEN.
Writes out/python-shot.png next to the other recipe output.
"""

import asyncio
import base64
import os
import sys
import time
from pathlib import Path

from browserglass import AutomationClient, RestClient

BASE_URL = os.environ.get("BGLS_URL", "http://127.0.0.1:7799/browserglass").rstrip("/")
ADMIN_TOKEN = os.environ.get("BGLS_ADMIN_TOKEN")
OUT = Path(__file__).resolve().parent.parent / "out"


async def main() -> None:
    if not ADMIN_TOKEN:
        sys.exit("BGLS_ADMIN_TOKEN is not set. Run: export BGLS_ADMIN_TOKEN=$(pnpm -s bgls token)")

    async with RestClient(base_url=BASE_URL, token=ADMIN_TOKEN) as rest:
        # A fresh headless Chrome. request_id must be new for every acquire:
        # the gateway dedupes a repeated one for five minutes.
        acquired = await rest.acquire(
            request_id=f"py-quickstart-{os.getpid()}-{int(time.time() * 1000)}",
            browser={"headless": "new"},
        )
        print(f"browser {acquired.instance_id} is {acquired.state}")
        try:
            # The acquire answer carries a short lived ticket scoped to this
            # one browser. Connect with it straight away, it lasts a minute.
            client = await AutomationClient.connect(
                endpoint=acquired.attach.ws_url, token=acquired.attach.ticket
            )
            try:
                lease = await client.acquire_control()
                status = await client.navigate("https://example.com/", wait_until="load")
                print(f"navigated to {status.url}")

                text = await client.text()
                print("page text:", " ".join(text.split())[:120])

                shot = await client.screenshot(format="png")
                OUT.mkdir(exist_ok=True)
                (OUT / "python-shot.png").write_bytes(base64.b64decode(shot.data))
                print(f"saved out/python-shot.png ({shot.width}x{shot.height})")

                await lease.release()
            finally:
                await client.close()
        finally:
            # force=True: this script owns the browser, end it even if the
            # gateway still counts our just closed socket as a viewer.
            result = await rest.release(acquired.instance_id, force=True)
            print(f"released: {result.outcome}")


asyncio.run(main())
