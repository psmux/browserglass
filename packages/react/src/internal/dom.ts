'use client';

import { useEffect, useLayoutEffect } from 'react';

/**
 * `useLayoutEffect` in the browser, `useEffect` (a silent no-op timing
 * difference, never a behaviour difference) on the server: plain
 * `useLayoutEffect` warns when it runs during server rendering, which a
 * `'use client'` component still undergoes under most frameworks' default
 * (non-`ssr:false`) client-component rendering.
 */
export const useIsomorphicLayoutEffect: typeof useLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Re-validates a page-controlled `href` client-side against `http`/`https`
 * only, before it is ever placed in a real `href` or `img src` attribute
 * (the server already
 * filters `target.probe`'s `href`, but "open link in new tab" is the one
 * menu item that acts on a page-controlled string, and this is the second,
 * independent check). A relative URL (no scheme of its own) is treated as
 * safe.
 */
export function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href, 'http://bgls-relative-base.invalid/');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
