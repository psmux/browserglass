// Draws on the Excalidraw whiteboard with drag(): a rectangle, an ellipse
// and an arrow between them, then a text label typed with the text tool.
// Prints what the canvas holds at the end, read from the page.
//
//   node examples/showcase/draw-canvas.mjs

import { caption, clickShown, launch, recordRun, sleep } from './lib/showcase.mjs';

const LABEL = 'Drawn by a script';

// Picks a tool from the toolbar, then drags out a shape with it.
async function drawWith(browser, tool, from, to) {
  await clickShown(browser, `[data-testid="toolbar-${tool}"]`, 400);
  await browser.drag(from, to, { steps: 24 });
  await sleep(400);
}

const browser = await launch();
let elements = [];
try {
  const seconds = await recordRun(
    browser,
    'draw-canvas',
    async () => {
      // A first visit can show a dialog over the canvas. Close it if so.
      await browser.pressKey('Escape');

      await caption(browser, '1/4', 'Draw a rectangle with drag()');
      await drawWith(browser, 'rectangle', { x: 300, y: 260 }, { x: 540, y: 420 });

      await caption(browser, '2/4', 'Then an ellipse');
      await drawWith(browser, 'ellipse', { x: 800, y: 250 }, { x: 1040, y: 430 });

      await caption(browser, '3/4', 'Connect them with an arrow');
      await drawWith(browser, 'arrow', { x: 560, y: 340 }, { x: 780, y: 340 });

      await caption(browser, '4/4', 'Label it with the text tool');
      await clickShown(browser, '[data-testid="toolbar-text"]', 400);
      await browser.clickAt(560, 520);
      await sleep(300);
      await browser.humanType(LABEL, { delayMs: 60 });
      await browser.pressKey('Escape');
      await browser.pressKey('Escape');
      await sleep(400);

      elements = await browser.evaluate(() => {
        const raw = localStorage.getItem('excalidraw');
        return raw
          ? JSON.parse(raw)
              .filter((e) => !e.isDeleted)
              .map((e) => (e.type === 'text' ? `text "${e.text}"` : e.type))
          : [];
      });
      await caption(browser, '4/4', `Done: ${elements.length} shapes on the canvas`);
      await sleep(1200);
    },
    { url: 'https://excalidraw.com/', ready: '[data-testid="toolbar-rectangle"]' },
  );
  console.log(`canvas holds ${elements.length} elements: ${elements.join(', ')} (${seconds}s)`);
} finally {
  await browser.release();
}
