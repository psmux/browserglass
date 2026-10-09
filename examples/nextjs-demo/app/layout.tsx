import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@browserglass/react/ui/styles.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'BrowserGlass demo',
  description: 'Three concurrent, controllable tabs of one real Chrome, streamed over one socket.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
