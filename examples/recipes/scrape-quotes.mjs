// Scrape quotes and authors from quotes.toscrape.com, two pages deep, by
// clicking the site's own "Next" link the way a person would.
//
//   node examples/recipes/scrape-quotes.mjs > out/quotes.json
//
// Prints a JSON array to stdout. Progress goes to stderr so the JSON stays clean.

import { openBrowser } from './lib/gateway.mjs';

const PAGES = 2;

// Runs inside the page. It cannot see variables from this file, so it takes
// nothing and returns plain JSON.
function readQuotes() {
  return [...document.querySelectorAll('.quote')].map((q) => ({
    text: q.querySelector('.text')?.textContent.trim(),
    author: q.querySelector('.author')?.textContent.trim(),
    tags: [...q.querySelectorAll('.tag')].map((t) => t.textContent.trim()),
  }));
}

const { client, done } = await openBrowser({ sub: 'quote-scraper' });
try {
  await client.acquireControl();
  await client.navigate('https://quotes.toscrape.com/', { waitUntil: 'load' });

  // pageMap() is the agent's view of a page: every link, button and field,
  // indexed. Handy to see what you can act on before writing selectors.
  const map = await client.pageMap();
  const links = (map.nodes ?? []).filter((n) => n.role === 'link').length;
  console.error(`page map: ${map.nodes?.length ?? 0} actionable nodes, ${links} of them links`);

  const all = [];
  for (let page = 1; page <= PAGES; page++) {
    const quotes = await client.evaluate(readQuotes);
    console.error(`page ${page}: ${quotes.length} quotes`);
    all.push(...quotes.map((q) => ({ page, ...q })));

    if (page < PAGES) {
      // A real mouse click on the link whose text is "Next".
      await client.click('text=Next');
      await client.waitForFunction(
        `location.pathname === '/page/${page + 1}/' && document.readyState === 'complete'`,
      );
    }
  }

  console.log(JSON.stringify(all, null, 2));
} finally {
  await done();
}
