'use client';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LAB_FIELD } from '../../lib/agent-lab';

/**
 * The page the demo's agent drives.
 *
 * It is served by this same Next app on purpose. An agent loop pointed at
 * somebody else's website is a demo that breaks when that website changes,
 * when the machine is offline, or when a consent banner lands on top of the
 * thing the agent was about to click. This page is under the same roof as
 * the loop driving it, so the demo works on a plane.
 *
 * Two design constraints, both unusual, both load bearing.
 *
 * 1. EVERYTHING IS HUGE. This page is rendered in a 1280x800 Chrome
 *    viewport and then streamed into a pane roughly 360 pixels wide, so it
 *    is read at about a third of life size. Ordinary 16px body text lands
 *    at five pixels on the watcher's screen and is not text any more, it is
 *    texture. So the heading is 56px, the field is 40px, and a log row is
 *    30px, chosen by looking at the pane rather than by looking at the
 *    page.
 *
 * 2. THE FIELD IS AT FIXED PIXEL COORDINATES. `AutomationClient.clickAt`
 *    takes viewport CSS pixels; the locator engine (`click('#q')`) is not
 *    built in this pass and throws `NOT_IMPLEMENTED` if called. So the one
 *    thing the agent has to hit is absolutely positioned from `LAB_FIELD`
 *    in `lib/agent-lab.ts`, which the runner imports too rather than
 *    copying a pair of numbers out of here. Move the field and the agent
 *    follows.
 *
 * The log is what makes shared control visible. Two writers on one focused
 * input interleave their characters, and an agent will not notice a person
 * has started typing, so a line submitted while both were typing comes out
 * shuffled. That is not a defect this page hides. It is the hazard the
 * shared pattern carries, printed in 30px type, with the interleaved line
 * flagged as soon as it happens.
 */

interface LogRow {
  n: number;
  text: string;
  at: string;
  /**
   * True when the characters of this line did not arrive in one steady
   * stream, which is what two writers on one field looks like from the
   * page's side. See {@link looksInterleaved}.
   */
  interleaved: boolean;
}

/**
 * A guess, honestly labelled as one, about whether two writers produced
 * this line.
 *
 * The page cannot know who typed what: a keystroke arrives as a keystroke
 * and carries no author. What it can see is the RHYTHM. The agent types on
 * a fixed cadence, so its own gaps cluster tightly around one value; a
 * person joining in produces gaps that are all over the place. A standard
 * deviation well above the median gap means two hands, and that is as far
 * as this goes: the badge says "two writers", not "Alice and the agent".
 */
function looksInterleaved(gaps: readonly number[]): boolean {
  if (gaps.length < 6) return false;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median === 0) return false;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) > median * 1.4;
}

export default function AgentLabPage() {
  const [value, setValue] = useState('');
  const [rows, setRows] = useState<LogRow[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Time of the previous keystroke, and the gaps since this field was last cleared. */
  const lastKeyAt = useRef<number | null>(null);
  const gaps = useRef<number[]>([]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    const now = performance.now();
    if (e.key.length === 1) {
      if (lastKeyAt.current !== null) gaps.current.push(now - lastKeyAt.current);
      lastKeyAt.current = now;
    }
  }, []);

  const submit = useCallback(() => {
    const text = value.trim();
    if (text.length === 0) return;
    const interleaved = looksInterleaved(gaps.current);
    gaps.current = [];
    lastKeyAt.current = null;
    setRows((prev) =>
      [
        {
          n: prev.length + 1,
          text,
          at: new Date().toLocaleTimeString([], { hour12: false }),
          interleaved,
        },
        ...prev,
      ].slice(0, 24),
    );
    setValue('');
  }, [value]);

  // Focused on load so a person who takes this tab over can simply start
  // typing. The agent still clicks the field every cycle rather than
  // relying on this: after a takeover the focus is wherever the person
  // left it, and an agent that assumed otherwise would type into nothing.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <main
      style={{
        position: 'relative',
        width: '100%',
        minHeight: 2400,
        background: '#0d0f14',
        color: '#e8e8ea',
        overflowX: 'hidden',
      }}
    >
      {/* Top band. Wide, flat, and high contrast so the pane reads as "a
          specific page" at a glance rather than as a grey rectangle. */}
      <div
        style={{
          height: 160,
          background: '#181a20',
          borderBottom: '2px solid #2a2c33',
          display: 'flex',
          alignItems: 'center',
          padding: '0 64px',
          gap: 28,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 64,
            height: 64,
            borderRadius: 12,
            background: '#2a2140',
            border: '2px solid #4b3d75',
            display: 'grid',
            placeItems: 'center',
            fontSize: 34,
          }}
        >
          &#9635;
        </span>
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: 56,
              letterSpacing: '-0.02em',
              lineHeight: 1,
              fontWeight: 700,
            }}
          >
            Agent lab
          </h1>
          <p style={{ margin: '10px 0 0', fontSize: 26, color: '#9aa' }}>
            A real page, driven by a real automation client, over the same socket you are watching.
          </p>
        </div>
      </div>

      <p
        style={{
          position: 'absolute',
          left: LAB_FIELD.left,
          top: 208,
          margin: 0,
          fontSize: 28,
          color: '#7db1ff',
          fontWeight: 600,
        }}
      >
        What are we looking up?
      </p>

      {/* The one element with a contract outside this file. See LAB_FIELD. */}
      <input
        ref={inputRef}
        aria-label="What are we looking up?"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder="Type here. So can the agent."
        style={{
          position: 'absolute',
          left: LAB_FIELD.left,
          top: LAB_FIELD.top,
          width: LAB_FIELD.width,
          height: LAB_FIELD.height,
          background: '#111318',
          border: '3px solid #4b3d75',
          borderRadius: 10,
          color: '#e8e8ea',
          fontSize: 40,
          padding: '0 24px',
          outlineColor: '#7db1ff',
        }}
      />

      <p
        style={{
          position: 'absolute',
          left: LAB_FIELD.left,
          top: LAB_FIELD.top + LAB_FIELD.height + 18,
          margin: 0,
          fontSize: 24,
          color: '#667',
        }}
      >
        Enter files it below. Nothing leaves this machine.
      </p>

      <section
        style={{
          position: 'absolute',
          left: LAB_FIELD.left,
          top: 470,
          width: LAB_FIELD.width + 340,
        }}
      >
        <h2
          style={{
            fontSize: 26,
            margin: '0 0 18px',
            color: '#9aa',
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
          }}
        >
          Filed ({rows.length})
        </h2>
        {rows.length === 0 && (
          <p style={{ fontSize: 30, color: '#556', margin: 0 }}>Nothing yet.</p>
        )}
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li
              key={r.n}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 22,
                padding: '16px 20px',
                marginBottom: 10,
                background: r.interleaved ? '#1b1810' : '#111318',
                border: `2px solid ${r.interleaved ? '#5c4a1e' : '#2a2c33'}`,
                borderRadius: 8,
                fontSize: 30,
              }}
            >
              <span style={{ color: '#556', fontVariantNumeric: 'tabular-nums', fontSize: 24 }}>
                {r.at}
              </span>
              <span style={{ flex: 1, wordBreak: 'break-word' }}>{r.text}</span>
              {r.interleaved && (
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: '#e6c37e',
                    whiteSpace: 'nowrap',
                    letterSpacing: '0.08em',
                  }}
                >
                  TWO WRITERS
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* Deliberate dead space. The agent scrolls, and a page that fits on
          one screen cannot show a scroll happening. */}
      <p
        style={{
          position: 'absolute',
          left: LAB_FIELD.left,
          top: 2180,
          margin: 0,
          fontSize: 30,
          color: '#3a3f4a',
        }}
      >
        Bottom of the page. The agent scrolls down to here and back up again.
      </p>
    </main>
  );
}
