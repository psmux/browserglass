// Fill in and submit the sample pizza order form at httpbin.org/forms/post,
// then check what the server says it received.
//
//   node examples/recipes/fill-form.mjs
//
// Every field is found by its visible label and the button by its role and
// name, so nothing here depends on ids or CSS classes. httpbin answers a
// submit by echoing the form back as JSON, which makes the check exact.

import { openBrowser } from './lib/gateway.mjs';

const order = {
  custname: 'Ada Lovelace',
  custtel: '555 0100',
  custemail: 'ada@example.com',
  comments: 'Ring the bell twice.',
};

const { client, done } = await openBrowser({ sub: 'form-filler' });
try {
  await client.acquireControl();
  await client.navigate('https://httpbin.org/forms/post', { waitUntil: 'load' });

  // fill() waits for the field, types with real key events, then reads the
  // value back. `verified` says whether the field really holds the text.
  const filled = [
    await client.fill('label=Customer name', order.custname),
    await client.fill('label=Telephone', order.custtel),
    await client.fill('label=E-mail address', order.custemail),
    await client.fill('label=Delivery instructions', order.comments),
  ];
  console.log(`fields filled and verified: ${filled.filter((f) => f.verified).length}/4`);

  // Radio buttons and checkboxes are clicked, like a person would.
  await client.click('label=Medium');
  await client.click('label=Mushroom');

  await client.click('role=button[name="Submit order"]');

  // The answer page is httpbin's JSON echo of what it received.
  await client.waitForFunction(`location.pathname === '/post' && !!document.body`);
  const echoed = JSON.parse(await client.text()).form;
  console.log('server received:', JSON.stringify(echoed));

  const ok =
    echoed.custname === order.custname &&
    echoed.custemail === order.custemail &&
    echoed.size === 'medium' &&
    echoed.topping === 'mushroom';
  console.log(ok ? 'PASS: the order went through as typed' : 'FAIL: something did not match');
  process.exitCode = ok ? 0 : 1;
} finally {
  await done();
}
