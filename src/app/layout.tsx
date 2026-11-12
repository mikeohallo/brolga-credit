import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

// Self-hosted fonts (the `geist` package ships the files) so nothing is fetched
// from Google at build or run time — one less thing to fail on demo day.
const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: "Brolga Credit · Loan desk",
  description: "A consumer-lending demo built on Zepto: real-time disbursement, PayTo repayments, live reconciliation.",
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
  appleWebApp: { capable: true, title: "Brolga", statusBarStyle: "default" },
};

// The home-screen app: Access intercepts every request that carries no credentials, and the
// browser fetches a manifest without them unless it is told to send the cookie, so the
// manifest link says so (`crossOrigin: "use-credentials"`). Without it the icon and name
// are lost behind the sign-in page.
export const viewport: Viewport = { themeColor: "#0f5c50", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      </head>
      <body className="min-h-full">
        <div className="flex min-h-screen flex-col md:flex-row">
          <Sidebar />
          <main className="flex-1 min-w-0">
            <div className="mx-auto max-w-6xl px-6 py-8 lg:px-10">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
