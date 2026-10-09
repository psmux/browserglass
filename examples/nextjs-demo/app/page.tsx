import Link from 'next/link';

export default function HomePage() {
  return (
    <main style={{ maxWidth: 640, margin: '10vh auto', padding: '0 24px', lineHeight: 1.6 }}>
      <h1>BrowserGlass Next.js demo</h1>
      <p>
        This app proves the whole point of BrowserGlass: concurrent, parallel browser tabs visually
        in front of the user, with the user able to control them, all through one WebSocket.
      </p>
      <p>
        <Link href="/browser" style={{ fontSize: 18 }}>
          Open the browser wall &rarr;
        </Link>
      </p>
    </main>
  );
}
