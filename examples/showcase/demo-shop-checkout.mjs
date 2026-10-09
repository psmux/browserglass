// Log in to the Sauce Labs demo shop with the demo account printed on its
// login page, put two products in the cart and check out with made up
// details. Prints the order total the shop showed.
//
//   node examples/showcase/demo-shop-checkout.mjs

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

// waitFor() can throw "Inspected target navigated or closed" when a click's
// navigation lands mid poll, so retry it across the page swap.
async function waitAfterNav(browser, selector, timeoutMs = 15000) {
  for (let i = 0; ; i++) {
    try {
      return await browser.waitFor(selector, { timeoutMs });
    } catch (err) {
      if (i >= 5 || !/navigated or closed/.test(String(err?.message))) throw err;
      await sleep(300);
    }
  }
}

async function clickShown(browser, selector) {
  await highlight(browser, selector, 500);
  await browser.click(selector);
  // This shop is a single page app, so drop the outline before the view
  // changes under it.
  await browser.evaluate(() => {
    for (const b of document.querySelectorAll('.__bg_hl')) b.remove();
  });
}

// Click, then wait for the next view. On a busy machine a click can land
// while the app is still re-rendering and do nothing, so try it again once.
async function clickThrough(browser, selector, next) {
  for (let i = 0; ; i++) {
    await clickShown(browser, selector);
    try {
      return await waitAfterNav(browser, next, i === 0 ? 5000 : 15000);
    } catch (err) {
      if (i >= 1) throw err;
    }
  }
}

const browser = await launch();
let total = '';
let thanks = '';
let items = [];
let seconds = 0;
try {
  // Load the first page before recording, so the clip does not open on a
  // blank tab.
  await browser.navigate('https://www.saucedemo.com/');
  await browser.waitFor('#user-name');
  seconds = await recordRun(browser, 'demo-shop-checkout', async () => {
    await caption(browser, '1/4', 'Log in with the demo account');
    await sleep(500);
    await browser.click('#user-name');
    await browser.humanType('standard_user');
    await browser.click('#password');
    await browser.humanType('secret_sauce');
    await clickThrough(browser, '#login-button', '.inventory_item');

    await caption(browser, '2/4', 'Add two products to the cart');
    await sleep(600);
    items = await browser.evaluate(() =>
      [...document.querySelectorAll('.inventory_item_name')]
        .slice(0, 2)
        .map((e) => e.textContent.trim()),
    );
    await clickShown(browser, '#add-to-cart-sauce-labs-backpack');
    await sleep(300);
    await clickShown(browser, '#add-to-cart-sauce-labs-bike-light');
    await sleep(500);
    // Adding to the cart scrolls the page a little, which leaves the cart
    // icon half above the viewport, so go back to the top first.
    await browser.evaluate(() => window.scrollTo(0, 0));
    await sleep(200);
    await clickThrough(browser, '.shopping_cart_link', '.cart_item');
    await caption(browser, '2/4', 'Two products in the cart');
    await sleep(900);

    await clickThrough(browser, '#checkout', '#first-name');
    await caption(browser, '3/4', 'Check out with made up details');
    await browser.click('#first-name');
    await browser.humanType('Ada');
    await browser.click('#last-name');
    await browser.humanType('Lovelace');
    await browser.click('#postal-code');
    await browser.humanType('10001');
    await sleep(300);
    await clickThrough(browser, '#continue', '.summary_total_label');
    total = (await browser.innerText('.summary_total_label')).trim();
    await caption(browser, '3/4', `Review the order: ${total}`);
    await browser.evaluate(() =>
      document.querySelector('.summary_total_label').scrollIntoView({ block: 'center' }),
    );
    await sleep(500);
    await highlight(browser, '.summary_total_label', 700);
    await clickThrough(browser, '#finish', '.complete-header');
    thanks = (await browser.innerText('.complete-header')).trim();
    await browser.evaluate(() => window.scrollTo(0, 0));
    await caption(browser, '4/4', `Order placed. ${total}`);
    await sleep(1200);
  });
} finally {
  await browser.release();
}

console.log(`Bought: ${items.join(', ')}`);
console.log(`Order total seen: ${total}`);
console.log(`Confirmation: "${thanks}" (${seconds}s)`);
