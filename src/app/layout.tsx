import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NOTE AIPRO",
  description: "Dịch thuật thời gian thực, chuyển giọng nói thành văn bản, phân biệt người nói và tóm tắt cuộc họp thông minh bằng Trợ lý AI.",
  manifest: "/manifest.json?v=3",
  icons: {
    icon: "/favicon.png?v=3",
    shortcut: "/favicon.png?v=3",
    apple: "/logo.png?v=3",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "NOTE AIPRO",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
