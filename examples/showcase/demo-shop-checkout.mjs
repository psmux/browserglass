// Log in to the Sauce Labs demo shop with the demo account printed on its
// login page, put two products in the cart and check out with made up
// details. Prints the order total the shop showed.
//
//   node examples/showcase/demo-shop-checkout.mjs

import { caption, clickShown, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

async function checkout(browser) {
  const order = { items: [], total: '', thanks: '' };

  await caption(browser, '1/4', 'Log in with the demo account');
  await sleep(500);
  await browser.fill('#user-name', 'standard_user');
  await browser.fill('#password', 'secret_sauce');
  await clickShown(browser, '#login-button');
  await browser.waitFor('.inventory_item');

  await caption(browser, '2/4', 'Add two products to the cart');
  await sleep(600);
  order.items = await browser.evaluate(() =>
    [...document.querySelectorAll('.inventory_item_name')]
      .slice(0, 2)
      .map((e) => e.textContent.trim()),
  );
  await clickShown(browser, '#add-to-cart-sauce-labs-backpack');
  await sleep(300);
  await clickShown(browser, '#add-to-cart-sauce-labs-bike-light');
  await sleep(500);
  const badge = await browser.evaluate(
    () => document.querySelector('.shopping_cart_badge')?.textContent ?? '0',
  );
  if (badge !== '2') throw new Error(`the cart shows ${badge} items, expected 2`);
  // Adding to the cart scrolls the page a little, which leaves the cart
  // icon half above the viewport, so go back to the top first.
  await browser.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  await clickShown(browser, '.shopping_cart_link');
  await browser.waitFor('.cart_item');
  await caption(browser, '2/4', 'Two products in the cart');
  await sleep(900);

  await clickShown(browser, '#checkout');
  await browser.waitFor('#first-name');
  await caption(browser, '3/4', 'Check out with made up details');
  await browser.fill('#first-name', 'Ada');
  await browser.fill('#last-name', 'Lovelace');
  await browser.fill('#postal-code', '10001');
  await sleep(300);
  await clickShown(browser, '#continue');
  await browser.waitFor('.summary_total_label');
  order.total = (await browser.innerText('.summary_total_label')).trim();
  await caption(browser, '3/4', `Review the order: ${order.total}`);
  await browser.evaluate(() =>
    document.querySelector('.summary_total_label').scrollIntoView({ block: 'center' }),
  );
  await sleep(500);
  await highlight(browser, '.summary_total_label', 700);
  await clickShown(browser, '#finish');
  await browser.waitFor('.complete-header');
  order.thanks = (await browser.innerText('.complete-header')).trim();
  await browser.evaluate(() => window.scrollTo(0, 0));
  await caption(browser, '4/4', `Order placed. ${order.total}`);
  await sleep(1200);
  return order;
}

const browser = await launch();
let order;
let seconds = 0;
try {
  seconds = await recordRun(
    browser,
    'demo-shop-checkout',
    async () => {
      order = await checkout(browser);
    },
    { url: 'https://www.saucedemo.com/', ready: '#user-name' },
  );
} finally {
  await browser.release();
}

console.log(`Bought: ${order.items.join(', ')}`);
console.log(`Order total seen: ${order.total}`);
console.log(`Confirmation: "${order.thanks}" (${seconds}s)`);
