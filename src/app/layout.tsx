import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Otodom → Meta CAPI",
  description: "Automatyczna wysyłka zdarzeń Lead do Meta Conversions API na podstawie maili z Otodom.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
